# online-ai-transit-server

iOS 6 设备的 NSURLConnection 在现代 TLS（Let's Encrypt ECDSA 等）下经常握手失败。
中转服务器把 iOS 6 设备的请求转发到上游 AI/Tavily，自己用现代 Python `requests`
发起 HTTPS，规避 iOS 6 的 TLS 兼容问题。

## 路由

| 路径 | 方法 | 用途 |
|------|------|------|
| `/v1/chat/completions` | POST | 透传到 AI 后端（SSE 流式原样转发） |
| `/v1/tavily/search` | POST | 透传到 Tavily API |
| `/v1/images/generations` | POST | 透传到图片生成 API（CogView / DALL·E 等） |
| `/v1/fetch_image?url=` | GET | 拉取任意图片 URL（规避 iOS 6 TLS） |
| `/v1/models` | GET | 透传到 AI 后端 |
| `/health` | GET | 健康检查（含版本号） |
| `/version` | GET | **部署验证** — 返回当前版本号 |

## X-Provider 路由

请求头 `X-Provider: zhipu|openai|ollama|tavily` 决定上游：

| Provider | 上游 BaseURL |
|----------|--------------|
| zhipu | `https://open.bigmodel.cn/api/paas/v4` |
| openai | `https://api.openai.com/v1` |
| ollama | `http://localhost:11434/v1` (本地) |
| tavily | `https://api.tavily.com` |

`Authorization: Bearer <key>` 原样转发。

## 部署（Python Flask 版）

```bash
pip install -r requirements.txt
export PORT=8443
python server.py
```

建议用 Caddy / Nginx 反代到 HTTPS（用 Let's Encrypt 现代证书，让 iOS 6 通过中转域名访问即可）。

## 部署（Cloudflare Worker 版）

`worker.js` 是零运维的 Worker 版本（免费额度足够个人使用）。在 Cloudflare Dashboard 里创建 Worker → 粘贴 `worker.js` 全文 → 部署。

## 升级后如何确认线上是新版？

**每次升级后务必验证**（很多"中转不正常"的问题其实是线上还跑着旧版）：

```bash
curl https://<你的中转域名>/version
# 应返回 {"version":"v261024-1", ...}
```

Docker 部署的话重新拉取并重启：

```bash
git pull
docker restart <容器名>        # 或者重新 build + run
curl https://<你的中转域名>/version
```

排障：每个请求都会记录 `method path provider 状态码 耗时`，
Docker 用 `docker logs -f <容器名>` 查看。

## 关键文件

- `server.py` — Flask app + SSE 透传 + 请求日志
- `worker.js` — Cloudflare Worker 版（同一路由集合）
- `requirements.txt` — 依赖
- `Dockerfile` — 容器化部署
- `Caddyfile` — Caddy 反代示例
