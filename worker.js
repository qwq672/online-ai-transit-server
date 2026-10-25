/**
 * online-ai-transit-server — Cloudflare Worker 版本 (v261025-3)
 * ============================================================
 *
 * v261025-3 设计大改：中转服务器不再维护 UPSTREAMS 上游路由表，
 * 也不再根据 X-Provider 头路由到 zhipu/openai/ollama/tavily。
 * 现在中转是一个**纯 TLS 透传代理**：
 *
 *   关闭中转默认模型（默认）：
 *     客户端在 HTTP header `X-Target-URL` 里指定真正的目标地址，
 *     中转原样转发 body（含 model、messages、Authorization、stream=true）
 *     到 X-Target-URL，SSE 流式原样回流。
 *
 *   开启中转默认模型：
 *     客户端可以拉中转服务器自带的模型列表 (GET /v1/transit/models)。
 *     服务端通过 Worker 变量 TRANSIT_MODELS_ENABLED / TRANSIT_MODELS 控制。
 *
 * 部署方法：
 *   1. 登录 https://dash.cloudflare.com → Workers & Pages → Create
 *   2. 创建 Worker，把本文件完整粘贴进去
 *   3. 部署后会得到一个 https://your-worker.workers.dev 域名
 *   4. 在 iOS 6 AI Chat 设置里把这个域名填到「Transit URL」
 *
 * 限制：单请求 6 个 CPU 秒、流式响应最长 30s（Worker 限制）、单请求体 100MB
 */

// 部署版本号 — curl https://<worker域名>/version 验证。
const SERVER_VERSION = 'v261025-3';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    if (path === '/health' && request.method === 'GET') {
      return jsonResponse({
        status: 'ok',
        service: 'online-ai-transit-server-cfworker',
        version: SERVER_VERSION,
      });
    }

    // 部署验证端点 — 升级后 curl 这个路径确认版本号。
    if (path === '/version' && request.method === 'GET') {
      return jsonResponse({
        version: SERVER_VERSION,
        endpoints: [
          'POST /v1/chat/completions',
          'POST /v1/tavily/search',
          'POST /v1/images/generations',
          'GET  /v1/fetch_image',
          'GET  /v1/transit/models',
          'GET  /v1/models',
          'GET  /health',
          'GET  /version',
        ],
      });
    }

    if ((path === '/' ) && request.method === 'GET') {
      const { enabled, models } = transitModelsFromEnv(env);
      return jsonResponse({
        service: 'online-ai-transit-server-cfworker',
        version: SERVER_VERSION,
        endpoints: [
          'POST /v1/chat/completions',
          'POST /v1/tavily/search',
          'POST /v1/images/generations',
          'GET  /v1/fetch_image',
          'GET  /v1/transit/models',
          'GET  /v1/models',
          'GET  /health',
          'GET  /version',
        ],
        transit_models_enabled: enabled,
        transit_models: models,
      });
    }

    if ((path === '/v1/transit/models' || path === '/v1/models') && request.method === 'GET') {
      const { enabled, models } = transitModelsFromEnv(env);
      return jsonResponse({
        enabled,
        models,
        count: models.length,
      });
    }

    if (path === '/v1/chat/completions' && request.method === 'POST') {
      return chatCompletions(request, env);
    }

    if (path === '/v1/tavily/search' && request.method === 'POST') {
      return tavilySearch(request, env);
    }

    if (path === '/v1/images/generations' && request.method === 'POST') {
      return imagesGenerations(request, env);
    }

    if (path === '/v1/fetch_image' && request.method === 'GET') {
      return fetchImage(request, env);
    }

    return jsonResponse({ error: 'not found', path }, 404);
  },
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, X-Target-URL, X-Model',
  };
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
    },
  });
}

function transitModelsFromEnv(env) {
  if (!env) return { enabled: false, models: [] };
  const rawEnabled = String(env.TRANSIT_MODELS_ENABLED || '0').toLowerCase().trim();
  const enabled = ['1', 'true', 'yes', 'on'].includes(rawEnabled);
  const rawModels = String(env.TRANSIT_MODELS || '').trim();
  const models = rawModels
    ? rawModels.split(',').map(s => s.trim()).filter(s => s.length > 0)
    : [];
  return { enabled, models };
}

function resolveTargetUrl(request, fallback) {
  const t = (request.headers.get('X-Target-URL') || '').trim();
  return t || fallback || '';
}

function forwardHeaders(request) {
  // 只转发真正给上游的 header：Content-Type / Accept / Authorization。
  // X-Target-URL 是中转控制信号，不转发。
  const out = {
    'Content-Type': request.headers.get('Content-Type') || 'application/json',
    'Accept': request.headers.get('Accept') || 'application/json',
  };
  const auth = request.headers.get('Authorization');
  if (auth) out['Authorization'] = auth;
  return out;
}

async function chatCompletions(request, env) {
  const targetUrl = resolveTargetUrl(request);
  if (!targetUrl) {
    return jsonResponse({ error: 'missing X-Target-URL header' }, 400);
  }

  const rawBody = await request.text();
  let bodyJson;
  try {
    bodyJson = JSON.parse(rawBody);
  } catch (e) {
    console.log(`[chat] 400 invalid JSON from client (${rawBody.length}B)`);
    return jsonResponse({ error: 'invalid JSON body' }, 400);
  }

  const isStream = bodyJson.stream === true;
  const headers = forwardHeaders(request);
  if (isStream) headers['Accept'] = 'text/event-stream';

  console.log(`[chat] → ${targetUrl} model=${bodyJson.model || '(none)'} stream=${isStream} msgs=${(bodyJson.messages || []).length}B=${rawBody.length}`);

  const t0 = Date.now();
  const upstreamReq = new Request(targetUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(bodyJson),
  });

  let upstreamResp;
  try {
    upstreamResp = await fetch(upstreamReq, {});
  } catch (e) {
    console.log(`[chat] ✗ upstream fetch failed after ${Date.now() - t0}ms: ${e}`);
    return jsonResponse({ error: 'upstream error', detail: String(e) }, 502);
  }

  console.log(`[chat] ← HTTP ${upstreamResp.status} after ${Date.now() - t0}ms`);

  if (!isStream) {
    const text = await upstreamResp.text();
    console.log(`[chat] done ${Date.now() - t0}ms total, ${text.length}B body`);
    return new Response(text, {
      status: upstreamResp.status,
      headers: {
        'Content-Type': upstreamResp.headers.get('Content-Type') || 'application/json',
        ...corsHeaders(),
      },
    });
  }

  // 流式：用 TransformStream 逐 chunk 转发 SSE
  const { readable, writable } = new TransformStream({});
  const writer = writable.getWriter();
  const reader = upstreamResp.body.getReader();

  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length) {
          await writer.write(value);
        }
      }
    } catch (e) {
      console.log(`[chat] ✗ stream broke after ${Date.now() - t0}ms: ${e}`);
      const errPayload = JSON.stringify({
        error: { message: `transit stream error: ${e}` },
      });
      const encoder = new TextEncoder();
      await writer.write(encoder.encode(`data: ${errPayload}\n\ndata: [DONE]\n\n`));
    } finally {
      await writer.close();
      console.log(`[chat] stream closed after ${Date.now() - t0}ms total`);
    }
  })();

  return new Response(readable, {
    status: upstreamResp.status,
    headers: {
      'Content-Type': upstreamResp.headers.get('Content-Type') || 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...corsHeaders(),
    },
  });
}

async function tavilySearch(request, env) {
  const targetUrl = resolveTargetUrl(request, 'https://api.tavily.com/search');
  const rawBody = await request.text();
  const t0 = Date.now();
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  const auth = request.headers.get('Authorization');
  if (auth) headers['Authorization'] = auth;

  console.log(`[tavily] → ${targetUrl} ${rawBody.length}B`);

  const upstreamReq = new Request(targetUrl, {
    method: 'POST',
    headers,
    body: rawBody,
  });

  try {
    const upstreamResp = await fetch(upstreamReq);
    const text = await upstreamResp.text();
    console.log(`[tavily] ← HTTP ${upstreamResp.status} after ${Date.now() - t0}ms, ${text.length}B`);
    return new Response(text, {
      status: upstreamResp.status,
      headers: {
        'Content-Type': upstreamResp.headers.get('Content-Type') || 'application/json',
        ...corsHeaders(),
      },
    });
  } catch (e) {
    console.log(`[tavily] ✗ ${e}`);
    return jsonResponse({ error: 'upstream error', detail: String(e) }, 502);
  }
}

async function imagesGenerations(request, env) {
  const targetUrl = resolveTargetUrl(request);
  if (!targetUrl) {
    return jsonResponse({ error: 'missing X-Target-URL header' }, 400);
  }
  const rawBody = await request.text();
  const headers = forwardHeaders(request);
  const t0 = Date.now();

  console.log(`[images] → ${targetUrl} ${rawBody.length}B`);

  const upstreamReq = new Request(targetUrl, {
    method: 'POST',
    headers,
    body: rawBody,
  });

  try {
    const upstreamResp = await fetch(upstreamReq);
    const text = await upstreamResp.text();
    console.log(`[images] ← HTTP ${upstreamResp.status} after ${Date.now() - t0}ms, ${text.length}B`);
    return new Response(text, {
      status: upstreamResp.status,
      headers: {
        'Content-Type': upstreamResp.headers.get('Content-Type') || 'application/json',
        ...corsHeaders(),
      },
    });
  } catch (e) {
    console.log(`[images] ✗ ${e}`);
    return jsonResponse({ error: 'upstream error', detail: String(e) }, 502);
  }
}

// GET /v1/fetch_image?url=... — 拉取任意图片 URL，返回原始字节
async function fetchImage(request, env) {
  const url = new URL(request.url);
  const imageUrl = url.searchParams.get('url');
  if (!imageUrl) {
    return jsonResponse({ error: "missing 'url' query parameter" }, 400);
  }

  const upstreamReq = new Request(imageUrl, {
    method: 'GET',
    headers: { 'Accept': 'image/*, application/octet-stream' },
  });

  try {
    const upstreamResp = await fetch(upstreamReq);
    const buf = await upstreamResp.arrayBuffer();
    console.log(`[fetch_image] ← HTTP ${upstreamResp.status} ${buf.byteLength}B`);
    return new Response(buf, {
      status: upstreamResp.status,
      headers: {
        'Content-Type': upstreamResp.headers.get('Content-Type') || 'application/octet-stream',
        ...corsHeaders(),
      },
    });
  } catch (e) {
    console.log(`[fetch_image] ✗ ${e}`);
    return jsonResponse({ error: 'fetch failed', detail: String(e) }, 502);
  }
}
