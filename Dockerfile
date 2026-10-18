FROM python:3.11-slim

LABEL org.opencontainers.image.title="online-ai-transit-server"
LABEL org.opencontainers.image.description="iOS 6 AI/Tavily HTTPS transit server"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app

# 安装依赖
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 拷贝源码
COPY server.py .

ENV PORT=8443
EXPOSE 8443

# 用 gunicorn 跑生产，--workers 2 --threads 4 够大部分负载
CMD ["gunicorn", "--bind", "0.0.0.0:8443", "--workers", "2", "--threads", "4", "--timeout", "120", "server:app"]
