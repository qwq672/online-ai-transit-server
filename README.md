# online-ai-transit-server

iOS 6 设备的 NSURLConnection 在现代 TLS（Let's Encrypt ECDSA 等）下经常握手失败。
中转服务器把 iOS 6 设备的请求转发到上游 AI/Tavily，自己用现代 Python `requests`
发起 HTTPS，规避 iOS 6 的 TLS 兼容问题。

## 路由

| 路径 | 方法 | 用途 |
|------|------|------|
| `/v1/chat/completions` | POST | 透传到 AI 后端（SSE 流式原样转发） |
| `/v1/tavily/search` | POST | 透传到 Tavily API |
| `/v1/models` | GET | 透传到 AI 后端 |
| `/health` | GET | 健康检查 |

## X-Provider 路由

请求头 `X-Provider: zhipu|openai|ollama|tavily` 决定上游：

| Provider | 上游 BaseURL |
|----------|--------------|
| zhipu | `https://open.bigmodel.cn/api/paas/v4` |
| openai | `https://api.openai.com` |
| ollama | `http://localhost:11434` (本地) |
| tavily | `https://api.tavily.com` |

`Authorization: Bearer <key>` 原样转发。

## 部署

```bash
pip install -r requirements.txt
export PORT=8443
python server.py
```

建议用 Caddy / Nginx 反代到 HTTPS（用 Let's Encrypt 现代证书，让 iOS 6 通过中转域名访问即可）。

## 关键文件

- `server.py` — Flask app + SSE 透传
- `requirements.txt` — 依赖
- `Dockerfile` — 容器化部署
- `README.md` — 本文件
