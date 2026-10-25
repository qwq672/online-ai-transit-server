#!/usr/bin/env python3
"""
online-ai-transit-server
========================

iOS 6 NSURLConnection 在现代 TLS（Let's Encrypt ECDSA 证书、TLS 1.3）
下经常握手失败。中转服务器接收 iOS 6 设备的 HTTPS 请求，自己用
现代 Python `requests` 库（支持 TLS 1.2/1.3）转发到客户端指定的
目标 URL。

v261025-3 设计大改：中转服务器不再维护 UPSTREAMS 上游路由表，
也不再根据 X-Provider 头路由到 zhipu/openai/ollama/tavily。
现在中转是一个**纯 TLS 透传代理**：

  - 关闭中转默认模型（默认）：
    客户端在 HTTP header `X-Target-URL` 里指定真正的目标地址，
    中转原样转发 body（含 model、messages、Authorization、stream=true）
    到 X-Target-URL，SSE 流式原样回流。

    例如：客户端 X-Target-URL: https://discovery-api.intern-ai.org.cn/v1/chat/completions
    中转替 iOS 6 完成 TLS，把请求原样转发到 intern-ai 的 chat/completions，
    流式响应原样回给客户端。

  - 开启中转默认模型：
    客户端可以拉中转服务器自带的模型列表 (GET /v1/transit/models)。
    服务端通过环境变量 TRANSIT_MODELS_ENABLED=1/0 控制是否启用，
    TRANSIT_MODELS=glm-4-flash,gpt-4o-mini 配置可选模型。

路由：
  POST /v1/chat/completions    — 透传到 X-Target-URL（含 SSE 流式）
  POST /v1/tavily/search       — 透传到 X-Target-URL（默认 api.tavily.com/search）
  POST /v1/images/generations  — 透传到 X-Target-URL
  GET  /v1/fetch_image?url=     — 拉取任意图片 URL
  GET  /v1/models               — 兼容端点，等同 /v1/transit/models
  GET  /v1/transit/models       — 返回中转自带模型列表
  GET  /health                  — 健康检查
  GET  /version                 — 部署验证

环境变量：
  PORT                          — 监听端口（默认 8443）
  TRANSIT_MODELS_ENABLED        — 是否启用自带模型（"1"/"0"，默认 "0"）
  TRANSIT_MODELS                — 自带模型列表，逗号分隔
                                   （例如 "glm-4-flash,gpt-4o-mini"）
"""

import os
import json
import time
from flask import Flask, request, Response, stream_with_context, jsonify
import requests

app = Flask(__name__)

# 部署版本号 — 用于确认线上跑的是哪一版：
#   curl https://<你的中转域名>/version
SERVER_VERSION = "v261025-3"

# 上游连接超时（秒）
# 读取超时 300s：thinking 类模型在输出前可能有长时间静默，
# 120s 会在流中间断开（表现为回复突然截断/空）。
UPSTREAM_TIMEOUT = 300
UPSTREAM_CONNECT_TIMEOUT = 15

# 流式 chunk 大小（字节）
STREAM_CHUNK_SIZE = 4096


def _transit_models():
    """读取服务端配置的自带模型列表。

    Returns (enabled: bool, models: list[str])
    """
    enabled = os.environ.get("TRANSIT_MODELS_ENABLED", "0").strip() in ("1", "true", "yes", "on")
    raw = os.environ.get("TRANSIT_MODELS", "").strip()
    models = []
    if raw:
        for m in raw.split(","):
            m = m.strip()
            if m:
                models.append(m)
    return enabled, models


def _resolve_target_url(default=None):
    """从 X-Target-URL 请求头读目标 URL。

    v261025-3 关键设计：中转不再维护 UPSTREAMS 表，目标由客户端决定。
    """
    target = request.headers.get("X-Target-URL", "").strip()
    if not target:
        target = default
    return target


# --- 请求日志 -----------------------------------------------------------
@app.after_request
def _log_request(resp):
    try:
        dur = getattr(request, "_start_ts", None)
        dur_ms = int((time.time() - dur) * 1000) if dur else -1
        app.logger.info(
            "%s %s target=%s -> %d (%dms)",
            request.method, request.path,
            request.headers.get("X-Target-URL", "-") or "-",
            resp.status_code, dur_ms,
        )
    except Exception:
        pass
    return resp


@app.before_request
def _mark_start():
    request._start_ts = time.time()
    return None


def _forward_headers(upstream_url):
    """构造转发给上游的请求头。

    Authorization / Content-Type / Accept 原样转发。
    X-Target-URL / X-Provider 等 transit 元数据头**不**转发给上游
    （它们只是中转自己的控制信号）。
    """
    out = {
        "Content-Type": request.headers.get("Content-Type", "application/json"),
        "Accept": request.headers.get("Accept", "application/json"),
    }
    auth = request.headers.get("Authorization")
    if auth:
        out["Authorization"] = auth
    return out


@app.route("/health")
def health():
    return jsonify({"status": "ok", "service": "online-ai-transit-server",
                    "version": SERVER_VERSION})


@app.route("/version")
def version():
    """部署验证端点 — 升级后 curl 这个路径确认版本号。"""
    return jsonify({
        "version": SERVER_VERSION,
        "endpoints": [
            "POST /v1/chat/completions",
            "POST /v1/tavily/search",
            "POST /v1/images/generations",
            "GET  /v1/fetch_image",
            "GET  /v1/transit/models",
            "GET  /v1/models",
            "GET  /health",
            "GET  /version",
        ],
    })


@app.route("/v1/transit/models", methods=["GET"])
@app.route("/v1/models", methods=["GET"])
def transit_models():
    """返回中转服务器自带模型列表。

    当 TRANSIT_MODELS_ENABLED=1 时返回 enabled=true + models 数组；
    否则返回 enabled=false + 空数组，客户端据此提示"此中转服务器不含自带模型"。

    注：这个端点**不**透传到任何上游——它是中转自己的元信息端点。
    """
    enabled, models = _transit_models()
    return jsonify({
        "enabled": enabled,
        "models": models,
        "count": len(models),
    })


@app.route("/v1/chat/completions", methods=["POST"])
def chat_completions():
    """透传 chat completions 请求，支持 SSE 流式响应。

    v261025-3 改造：
      - 客户端必须带 X-Target-URL header（例如
        https://discovery-api.intern-ai.org.cn/v1/chat/completions），
        中转用它作为真正目标，原样转发 body（含 model / messages /
        Authorization）。
      - 不再有 DEFAULT_MODELS / X-Provider 路由逻辑。

    iOS 6 客户端用 NSURLConnection 接收流；中转服务器用 requests
    的 stream=True 接收上游 SSE，然后通过 Flask 的
    stream_with_context 生成器把 chunk 原样转发给客户端。
    """
    target_url = _resolve_target_url()
    if not target_url:
        return jsonify({"error": "missing X-Target-URL header"}), 400

    body = request.get_data(as_text=False)
    try:
        body_json = json.loads(body)
    except json.JSONDecodeError:
        app.logger.warning("invalid JSON body from %s", request.remote_addr)
        return jsonify({"error": "invalid JSON body"}), 400

    is_stream = body_json.get("stream", False)
    app.logger.info("chat target=%s model=%s stream=%s msgs=%d",
                    target_url,
                    body_json.get("model", "<none>"),
                    is_stream,
                    len(body_json.get("messages", [])))

    headers = _forward_headers(target_url)
    # 上游期望 Accept: text/event-stream 才能正常流式返回
    if is_stream:
        headers["Accept"] = "text/event-stream"

    try:
        upstream_resp = requests.post(
            target_url,
            data=body,
            headers=headers,
            stream=is_stream,
            timeout=(UPSTREAM_CONNECT_TIMEOUT, UPSTREAM_TIMEOUT),
        )
    except requests.RequestException as e:
        return jsonify({"error": "upstream error", "detail": str(e)}), 502

    # 如果不是流式，直接返回 JSON。
    if not is_stream:
        return Response(
            upstream_resp.content,
            status=upstream_resp.status_code,
            content_type=upstream_resp.headers.get("Content-Type", "application/json"),
        )

    # 流式：用生成器逐 chunk 转发 SSE。
    def generate():
        try:
            for chunk in upstream_resp.iter_content(chunk_size=STREAM_CHUNK_SIZE):
                if chunk:
                    yield chunk
        except Exception as e:
            # 上游连接中断 — 发送一个错误 SSE 事件给客户端。
            err_payload = json.dumps({"error": {"message": f"transit stream error: {e}"}})
            yield f"data: {err_payload}\n\ndata: [DONE]\n\n"

    return Response(
        stream_with_context(generate()),
        status=upstream_resp.status_code,
        content_type=upstream_resp.headers.get("Content-Type", "text/event-stream"),
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # Nginx：禁用缓冲，让 chunk 立刻到达客户端
        },
    )


@app.route("/v1/tavily/search", methods=["POST"])
def tavily_search():
    """透传到 Tavily API（或客户端指定的 X-Target-URL）。

    默认 target = https://api.tavily.com/search；客户端可用
    X-Target-URL header 覆盖（极少用到，但保留灵活性）。
    """
    target_url = _resolve_target_url(default="https://api.tavily.com/search")
    body = request.get_data(as_text=False)
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    # Tavily 接受 api_key 在 body 里；Authorization Bearer 也兼容
    auth = request.headers.get("Authorization")
    if auth:
        headers["Authorization"] = auth

    try:
        upstream_resp = requests.post(
            target_url,
            data=body,
            headers=headers,
            timeout=(UPSTREAM_CONNECT_TIMEOUT, 30),
        )
    except requests.RequestException as e:
        return jsonify({"error": "upstream error", "detail": str(e)}), 502

    return Response(
        upstream_resp.content,
        status=upstream_resp.status_code,
        content_type=upstream_resp.headers.get("Content-Type", "application/json"),
    )


@app.route("/v1/images/generations", methods=["POST"])
def images_generations():
    """透传到上游图片生成 API。

    客户端必须带 X-Target-URL header（例如
    https://api.openai.com/v1/images/generations 或
    https://open.bigmodel.cn/api/paas/v4/images/generations），
    中转原样转发 body。
    """
    target_url = _resolve_target_url()
    if not target_url:
        return jsonify({"error": "missing X-Target-URL header"}), 400
    body = request.get_data(as_text=False)
    headers = _forward_headers(target_url)

    try:
        upstream_resp = requests.post(
            target_url,
            data=body,
            headers=headers,
            timeout=(UPSTREAM_CONNECT_TIMEOUT, 120),  # image gen can be slow
        )
    except requests.RequestException as e:
        return jsonify({"error": "upstream error", "detail": str(e)}), 502

    return Response(
        upstream_resp.content,
        status=upstream_resp.status_code,
        content_type=upstream_resp.headers.get("Content-Type", "application/json"),
    )


@app.route("/v1/fetch_image", methods=["GET"])
def fetch_image():
    """通过中转服务器拉取任意图片 URL，返回原始字节.

    用法: GET /v1/fetch_image?url=https://example.com/image.png
    """
    image_url = request.args.get("url")
    if not image_url:
        return jsonify({"error": "missing 'url' query parameter"}), 400
    try:
        upstream_resp = requests.get(
            image_url,
            timeout=(UPSTREAM_CONNECT_TIMEOUT, 60),
        )
    except requests.RequestException as e:
        return jsonify({"error": "fetch failed", "detail": str(e)}), 502
    return Response(
        upstream_resp.content,
        status=upstream_resp.status_code,
        content_type=upstream_resp.headers.get("Content-Type", "application/octet-stream"),
    )


@app.route("/", methods=["GET"])
def index():
    enabled, models = _transit_models()
    return jsonify({
        "service": "online-ai-transit-server",
        "version": SERVER_VERSION,
        "endpoints": [
            "POST /v1/chat/completions",
            "POST /v1/tavily/search",
            "POST /v1/images/generations",
            "GET  /v1/fetch_image",
            "GET  /v1/transit/models",
            "GET  /v1/models",
            "GET  /health",
            "GET  /version",
        ],
        "transit_models_enabled": enabled,
        "transit_models": models,
    })


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8443))
    # 0.0.0.0 让容器内可访问
    app.run(host="0.0.0.0", port=port, threaded=True)
