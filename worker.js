/**
 * online-ai-transit-server — Cloudflare Worker 版本
 * =================================================
 *
 * 部署方法：
 *   1. 登录 https://dash.cloudflare.com → Workers & Pages → Create
 *   2. 创建 Worker，把本文件完整粘贴进去
 *   3. 部署后会得到一个 https://your-worker.workers.dev 域名
 *   4. 在 iOS 6 AI Chat 设置里把这个域名填到「Transit URL」
 *
 * 优势：免费 10万 请求/月、全球边缘节点、零运维、自带 HTTPS 证书
 * 限制：单请求 6 个 CPU 秒、流式响应最长 30s（Worker 限制）、单请求体 100MB
 *
 * 支持路由：
 *   POST /v1/chat/completions  — SSE 流式透传
 *   POST /v1/tavily/search     — 普通透传
 *   GET  /v1/models            — 普通透传
 *   GET  /health                — 健康检查
 *
 * X-Provider 请求头决定上游：
 *   zhipu   → https://open.bigmodel.cn/api/paas/v4
 *   openai  → https://api.openai.com
 *   ollama  → http://localhost:11434（Worker 内无法访问本地，仅作占位）
 *   tavily  → https://api.tavily.com
 */

// 上游 URL 表 — base URL 已包含版本路径（/v1 或 /api/paas/v4）
// 这样 + "/chat/completions" 拼出来的端点才正确。
// BUG FIX v261018-14: 之前 openai=api.openai.com（缺 /v1），
// 导致 https://api.openai.com/chat/completions → 404 → iOS 收到空回复。
const UPSTREAMS = {
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',  // 已含版本路径
  openai: 'https://api.openai.com/v1',            // 加上 /v1（修复！）
  ollama: 'http://localhost:11434/v1',            // 加上 /v1
  tavily: 'https://api.tavily.com',
};

const DEFAULT_PROVIDER = 'openai';

// 中转服务器为每个 provider 配置的默认模型。
// 客户端开启「使用中转服务器的模型」后，请求体里不带 model 字段，
// 中转服务器从这里挑一个填上。
// 可通过环境变量（Worker 的 Variables）覆盖：DEFAULT_MODEL_ZHIPU 等。
const DEFAULT_MODELS = {
  zhipu: DEFAULT_MODEL_ZHIPU || 'glm-4-flash',
  openai: DEFAULT_MODEL_OPENAI || 'gpt-4o-mini',
  ollama: DEFAULT_MODEL_OLLAMA || 'llama3.2',
};

const UPSTREAM_TIMEOUT_MS = 30000; // Worker 限制单请求 30s
const STREAM_CHUNK_SIZE = 4096;

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
        providers: Object.keys(UPSTREAMS),
      });
    }

    if (path === '/' && request.method === 'GET') {
      return jsonResponse({
        service: 'online-ai-transit-server-cfworker',
        endpoints: [
          'POST /v1/chat/completions',
          'POST /v1/tavily/search',
          'GET  /v1/models',
          'GET  /health',
        ],
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

    if (path === '/v1/models' && request.method === 'GET') {
      return listModels(request, env);
    }

    return jsonResponse({ error: 'not found', path }, 404);
  },
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, X-Provider, X-Model',
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

function resolveProvider(request) {
  const p = (request.headers.get('X-Provider') || '').toLowerCase().trim();
  return p && UPSTREAMS[p] ? p : DEFAULT_PROVIDER;
}

function forwardHeaders(request, upstreamUrl) {
  const out = {
    'Content-Type': request.headers.get('Content-Type') || 'application/json',
    'Accept': request.headers.get('Accept') || 'application/json',
  };
  const auth = request.headers.get('Authorization');
  if (auth) out['Authorization'] = auth;
  return out;
}

async function chatCompletions(request, env) {
  const provider = resolveProvider(request);
  const upstreamBase = UPSTREAMS[provider];
  // UPSTREAMS already includes /v1 (for openai/ollama) or /api/paas/v4 (zhipu).
  // Just append /chat/completions.
  const upstreamUrl = upstreamBase.replace(/\/$/, '') + '/chat/completions';

  const rawBody = await request.text();
  let bodyJson;
  try {
    bodyJson = JSON.parse(rawBody);
  } catch (e) {
    return jsonResponse({ error: 'invalid JSON body' }, 400);
  }

  // 「使用中转服务器的模型」开关：客户端不带 model 字段时填默认
  if (!bodyJson.model && DEFAULT_MODELS[provider]) {
    bodyJson.model = DEFAULT_MODELS[provider];
    console.log(`substituted default model ${bodyJson.model} for provider ${provider}`);
  }

  const isStream = bodyJson.stream === true;
  const headers = forwardHeaders(request, upstreamUrl);
  if (isStream) headers['Accept'] = 'text/event-stream';

  const upstreamReq = new Request(upstreamUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(bodyJson),
  });

  let upstreamResp;
  try {
    upstreamResp = await fetch(upstreamReq, {
      // Cloudflare Worker 的 fetch 自动支持流式响应
    });
  } catch (e) {
    return jsonResponse({ error: 'upstream error', detail: String(e) }, 502);
  }

  if (!isStream) {
    // 非流式：直接返回 JSON
    const text = await upstreamResp.text();
    return new Response(text, {
      status: upstreamResp.status,
      headers: {
        'Content-Type': upstreamResp.headers.get('Content-Type') || 'application/json',
        ...corsHeaders(),
      },
    });
  }

  // 流式：用 ReadableStream + TransformStream 逐 chunk 转发 SSE
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
      // 上游中断 — 发送错误 SSE 事件
      const errPayload = JSON.stringify({
        error: { message: `transit stream error: ${e}` },
      });
      const encoder = new TextEncoder();
      await writer.write(encoder.encode(`data: ${errPayload}\n\ndata: [DONE]\n\n`));
    } finally {
      await writer.close();
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
  const upstreamUrl = 'https://api.tavily.com/search';
  const rawBody = await request.text();
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  const auth = request.headers.get('Authorization');
  if (auth) headers['Authorization'] = auth;

  const upstreamReq = new Request(upstreamUrl, {
    method: 'POST',
    headers,
    body: rawBody,
  });

  try {
    const upstreamResp = await fetch(upstreamReq);
    const text = await upstreamResp.text();
    return new Response(text, {
      status: upstreamResp.status,
      headers: {
        'Content-Type': upstreamResp.headers.get('Content-Type') || 'application/json',
        ...corsHeaders(),
      },
    });
  } catch (e) {
    return jsonResponse({ error: 'upstream error', detail: String(e) }, 502);
  }
}

async function listModels(request, env) {
  const provider = resolveProvider(request);
  const upstreamBase = UPSTREAMS[provider];
  const upstreamUrl = upstreamBase.replace(/\/$/, '') + '/models';
  const headers = forwardHeaders(request, upstreamUrl);

  const upstreamReq = new Request(upstreamUrl, {
    method: 'GET',
    headers,
  });

  try {
    const upstreamResp = await fetch(upstreamReq);
    const text = await upstreamResp.text();
    return new Response(text, {
      status: upstreamResp.status,
      headers: {
        'Content-Type': upstreamResp.headers.get('Content-Type') || 'application/json',
        ...corsHeaders(),
      },
    });
  } catch (e) {
    return jsonResponse({ error: 'upstream error', detail: String(e) }, 502);
  }
}

// POST /v1/images/generations — 透传到上游图片生成 API
// X-Provider 决定上游：
//   openai → https://api.openai.com/v1/images/generations
//   zhipu  → https://open.bigmodel.cn/api/paas/v4/images/generations
async function imagesGenerations(request, env) {
  const provider = resolveProvider(request);
  const upstreamBase = UPSTREAMS[provider];
  const upstreamUrl = upstreamBase.replace(/\/$/, '') + '/images/generations';
  const rawBody = await request.text();
  const headers = forwardHeaders(request, upstreamUrl);

  const upstreamReq = new Request(upstreamUrl, {
    method: 'POST',
    headers,
    body: rawBody,
  });

  try {
    const upstreamResp = await fetch(upstreamReq);
    const text = await upstreamResp.text();
    return new Response(text, {
      status: upstreamResp.status,
      headers: {
        'Content-Type': upstreamResp.headers.get('Content-Type') || 'application/json',
        ...corsHeaders(),
      },
    });
  } catch (e) {
    return jsonResponse({ error: 'upstream error', detail: String(e) }, 502);
  }
}

// GET /v1/fetch_image?url=... — 拉取任意图片 URL，返回原始字节
// 用于规避 iOS 6 与某些图片托管服务的 TLS 兼容问题
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
    return new Response(buf, {
      status: upstreamResp.status,
      headers: {
        'Content-Type': upstreamResp.headers.get('Content-Type') || 'application/octet-stream',
        ...corsHeaders(),
      },
    });
  } catch (e) {
    return jsonResponse({ error: 'fetch failed', detail: String(e) }, 502);
  }
}
