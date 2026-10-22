#!/usr/bin/env python3
"""
online-ai-transit-server
========================

iOS 6 NSURLConnection 在现代 TLS（Let's Encrypt ECDSA 证书、TLS 1.3）
下经常握手失败。中转服务器接收 iOS 6 设备的 HTTPS 请求，自己用
现代 Python `requests` 库（支持 TLS 1.2/1.3）转发到上游 AI/Tavily。

支持路由：
  POST /v1/chat/completions  — SSE 流式透传
  POST /v1/tavily/search     — 普通透传
  GET  /v1/models            — 普通透传
  GET  /health               — 健康检查

X-Provider 请求头决定上游：
  zhipu   → https://open.bigmodel.cn/api/paas/v4
  openai  → https://api.openai.com
  ollama  → http://localhost:11434
  tavily  → https://api.tavily.com

部署：
  pip install -r requirements.txt
  python server.py
建议用 Caddy 反代到 HTTPS。
"""

import os
import json
from flask import Flask, request, Response, stream_with_context, jsonify
import requests

app = Flask(__name__)

# 上游 URL 表 — base URL 已包含版本路径（/v1 或 /api/paas/v4）
# 这样 + "/chat/completions" 拼出来的端点才正确。
# BUG FIX v261018-14: 之前 openai=api.openai.com（缺 /v1），
# 导致 https://api.openai.com/chat/completions → 404 → iOS 收到空回复。
UPSTREAMS = {
    "zhipu":  "https://open.bigmodel.cn/api/paas/v4",  # 已含版本路径
    "openai": "https://api.openai.com/v1",             # 加上 /v1（修复！）
    "ollama": "http://localhost:11434/v1",             # 加上 /v1
    "tavily": "https://api.tavily.com",
}

# 中转服务器为每个 provider 配置的默认模型。
# 当客户端开启"使用中转服务器的模型"开关后，请求体里不带 model 字段，
# 中转服务器从这里挑一个填上。
# 可通过环境变量 TRANSIT_DEFAULT_MODEL_<PROVIDER> 覆盖。
DEFAULT_MODELS = {
    "zhipu":  os.environ.get("TRANSIT_DEFAULT_MODEL_ZHIPU",  "glm-4-flash"),
    "openai": os.environ.get("TRANSIT_DEFAULT_MODEL_OPENAI", "gpt-4o-mini"),
    "ollama": os.environ.get("TRANSIT_DEFAULT_MODEL_OLLAMA", "llama3.2"),
}

# 默认上游（如果 X-Provider 没传）
DEFAULT_PROVIDER = "openai"

# 上游连接超时（秒）
UPSTREAM_TIMEOUT = 120  # 长一些，让 AI 慢慢生成
UPSTREAM_CONNECT_TIMEOUT = 15

# 流式 chunk 大小（字节）
STREAM_CHUNK_SIZE = 4096


def _resolve_upstream():
    """根据 X-Provider 头决定上游 base URL。"""
    provider = request.headers.get("X-Provider", "").strip().lower()
    if not provider:
        provider = DEFAULT_PROVIDER
    return provider, UPSTREAMS.get(provider, UPSTREAMS[DEFAULT_PROVIDER])


def _forward_headers(upstream_url):
    """构造转发给上游的请求头。"""
    # 复制 Authorization / Content-Type / Accept。
    out = {
        "Content-Type": request.headers.get("Content-Type", "application/json"),
        "Accept": request.headers.get("Accept", "application/json"),
    }
    auth = request.headers.get("Authorization")
    if auth:
        out["Authorization"] = auth
    # 智谱需要的特殊 header
    if "open.bigmodel.cn" in upstream_url:
        # 智谱 OpenAI 兼容接口接受 Authorization Bearer
        pass
    return out


@app.route("/health")
def health():
    return jsonify({"status": "ok", "service": "online-ai-transit-server"})


@app.route("/v1/chat/completions", methods=["POST"])
def chat_completions():
    """透传 chat completions 请求，支持 SSE 流式响应。

    iOS 6 客户端用 NSURLConnection 接收流；中转服务器用 requests
    的 stream=True 接收上游 SSE，然后通过 Flask 的
    stream_with_context 生成器把 chunk 原样转发给客户端。
    """
    provider, upstream_base = _resolve_upstream()
    # UPSTREAMS 已包含版本路径 (/v1 或 /api/paas/v4)，
    # 直接拼 /chat/completions 即可。
    upstream_url = upstream_base.rstrip("/") + "/chat/completions"

    body = request.get_data(as_text=False)
    try:
        body_json = json.loads(body)
    except json.JSONDecodeError:
        return jsonify({"error": "invalid JSON body"}), 400

    # 如果客户端没传 model 字段（"使用中转服务器的模型"开关开启），
    # 用中转服务器的默认模型填上。
    if not body_json.get("model") and provider in DEFAULT_MODELS:
        body_json["model"] = DEFAULT_MODELS[provider]
        body = json.dumps(body_json).encode("utf-8")
        app.logger.info(f"substituted default model {body_json['model']} for provider {provider}")

    # 强制 stream=true 透传（如果客户端请求流式）
    is_stream = body_json.get("stream", False)
    headers = _forward_headers(upstream_url)
    # 上游期望 Accept: text/event-stream 才能正常流式返回
    if is_stream:
        headers["Accept"] = "text/event-stream"

    try:
        upstream_resp = requests.post(
            upstream_url,
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
    """透传到 Tavily API。

    客户端在请求体里放：
      {"api_key": "...", "query": "...", "max_results": N}
    我们原样转发到 https://api.tavily.com/search。
    """
    upstream_url = "https://api.tavily.com/search"
    body = request.get_data(as_text=False)
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    # Tavily 接受 api_key 在 body 里，不需要 Authorization header。
    # 但也兼容 Authorization: Bearer
    auth = request.headers.get("Authorization")
    if auth:
        headers["Authorization"] = auth

    try:
        upstream_resp = requests.post(
            upstream_url,
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


@app.route("/v1/models", methods=["GET"])
def list_models():
    """透传 GET /v1/models。"""
    provider, upstream_base = _resolve_upstream()
    upstream_url = upstream_base.rstrip("/") + "/models"
    headers = _forward_headers(upstream_url)
    # GET 请求没有 body
    try:
        upstream_resp = requests.get(
            upstream_url,
            headers=headers,
            timeout=(UPSTREAM_CONNECT_TIMEOUT, 15),
        )
    except requests.RequestException as e:
        return jsonify({"error": "upstream error", "detail": str(e)}), 502

    return Response(
        upstream_resp.content,
        status=upstream_resp.status_code,
        content_type=upstream_resp.headers.get("Content-Type", "application/json"),
    )


@app.route("/", methods=["GET"])
def index():
    return jsonify({
        "service": "online-ai-transit-server",
        "endpoints": [
            "POST /v1/chat/completions",
            "POST /v1/tavily/search",
            "GET  /v1/models",
            "GET  /health",
        ],
        "providers": list(UPSTREAMS.keys()),
    })


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8443))
    # 0.0.0.0 让容器内可访问
    app.run(host="0.0.0.0", port=port, threaded=True)
