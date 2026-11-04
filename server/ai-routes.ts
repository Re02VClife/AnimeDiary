/**
 * server/ai-routes — /api/ai/* 路由
 *
 * 前端只跟这里说话，永远不直接连第三方 LLM（CORS + 密钥落盘 + 重试都在服务端做）。
 * 挂载方式与其它路由一致：registerAIRoutes(router, { DATA_DIR, fetchImpl })。
 */
import { createAIClient, AIGatewayError } from './ai-gateway';
import type { AIStoredConfig, ChatMessage, AIToolSpec, AIToolChoice } from './ai-gateway';
import { normalizeAIPermission } from '../core/ai-permission';

interface RouterLike {
  use(prefix: string, handler: (req: any, res: any) => void): void;
}

export interface AIRoutesOptions {
  DATA_DIR: string;
  fetchImpl?: (url: string, init?: Record<string, unknown>) => Promise<any>;
}

function readJsonBody(req: any, limitBytes = 4 * 1024 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf-8');
      if (!text) { resolve({}); return; }
      try { resolve(JSON.parse(text)); } catch (e) {
        reject(new Error(`请求体不是合法 JSON：${e instanceof Error ? e.message : e}`));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: any, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

/** 允许前端传入的配置字段（其余忽略，密钥只能这样写进服务端） */
function pickConfigPatch(body: any): Partial<AIStoredConfig> {
  const patch: Partial<AIStoredConfig> = {};
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

  const provider = str(body?.provider);
  if (provider) patch.provider = provider;
  const baseUrl = str(body?.baseUrl);
  if (baseUrl !== undefined) patch.baseUrl = baseUrl;
  const model = str(body?.model);
  if (model !== undefined) patch.model = model;
  // apiKey === '' 表示"不改"，显式清空要传 clearKey: true
  if (body?.clearKey === true) patch.apiKey = '';
  else {
    const apiKey = str(body?.apiKey);
    if (apiKey) patch.apiKey = apiKey;
  }
  if (typeof body?.temperature === 'number') patch.temperature = body.temperature;
  if (typeof body?.maxTokens === 'number') patch.maxTokens = body.maxTokens;
  if (typeof body?.timeoutMs === 'number') patch.timeoutMs = body.timeoutMs;
  if (typeof body?.jsonMode === 'boolean') patch.jsonMode = body.jsonMode;
  if (body?.thinking === 'auto' || body?.thinking === 'off') patch.thinking = body.thinking;
  if (typeof body?.deepMode === 'boolean') patch.deepMode = body.deepMode;
  // 三档权限：只接受三个合法值，其余忽略（非法值不等于"改成默认"，别让人猜）
  if (typeof body?.permission === 'string') {
    patch.permission = normalizeAIPermission(body.permission);
  }
  if (body?.headers && typeof body.headers === 'object') {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.headers)) {
      if (typeof v === 'string' && k.trim()) headers[k.trim()] = v;
    }
    patch.headers = headers;
  }
  return patch;
}

export function registerAIRoutes(router: RouterLike, opts: AIRoutesOptions): void {
  const client = createAIClient({ DATA_DIR: opts.DATA_DIR, fetchImpl: opts.fetchImpl });

  // ── 配置读写 ──
  router.use('/api/ai/config', async (req, res) => {
    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true, config: client.publicConfig() });
      return;
    }
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'Method Not Allowed' }); return; }
    try {
      const body = await readJsonBody(req);
      client.saveConfig(pickConfigPatch(body));
      sendJson(res, 200, { ok: true, config: client.publicConfig() });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ── 模型列表 ──
  router.use('/api/ai/models', async (_req, res) => {
    try {
      const result = await client.listModels();
      // 顺带返回预设，前端不必再拉一次 config
      sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      sendJson(res, 200, {
        ok: false,
        models: [],
        source: 'preset',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  // ── 连通性测试（真跑一次结构化请求，不只是 /models） ──
  router.use('/api/ai/test', async (req, res) => {
    if (req.method !== 'POST' && req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
      return;
    }
    const result = await client.test();
    sendJson(res, 200, result);
  });

  // ── 主对话入口（JSON / SSE） ──
  router.use('/api/ai/chat', async (req, res) => {
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'Method Not Allowed' }); return; }

    let body: any;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
      return;
    }

    // 只保留四种角色；content 允许 null（带工具调用的 assistant 消息常常没有正文）
    const VALID_ROLES = new Set(['system', 'user', 'assistant', 'tool']);
    const messages: ChatMessage[] = Array.isArray(body?.messages)
      ? body.messages
          .filter((m: any) => m && VALID_ROLES.has(m.role) && (typeof m.content === 'string' || m.content == null))
          .map((m: any) => {
            const msg: ChatMessage = {
              role: m.role,
              content: typeof m.content === 'string' ? m.content : '',
            };
            /**
             * 工具调用的往返必须完整：assistant 的 tool_calls 与 tool 消息的
             * tool_call_id 若被剥掉，模型会以为上次调用没发生过，于是一遍遍重复调用。
             */
            if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
              msg.tool_calls = m.tool_calls;
            }
            if (typeof m.tool_call_id === 'string') msg.tool_call_id = m.tool_call_id;
            return msg;
          })
      : [];
    if (messages.length === 0) {
      sendJson(res, 400, { ok: false, error: 'messages 不能为空' });
      return;
    }

    const controller = new AbortController();
    let closed = false;
    res.on('close', () => {
      if (!closed) controller.abort();
    });

    const tools: AIToolSpec[] = Array.isArray(body?.tools)
      ? body.tools.filter((t: any) => t?.type === 'function' && t?.function && typeof t.function.name === 'string')
      : [];

    const common = {
      messages,
      maxTokens: typeof body?.maxTokens === 'number' ? body.maxTokens : undefined,
      temperature: typeof body?.temperature === 'number' ? body.temperature : undefined,
      jsonMode: typeof body?.jsonMode === 'boolean' ? body.jsonMode : undefined,
      purpose: typeof body?.purpose === 'string' ? body.purpose : '',
      signal: controller.signal,
      ...(tools.length > 0 ? { tools } : {}),
      ...(body?.toolChoice ? { toolChoice: body.toolChoice as AIToolChoice } : {}),
    };

    if (body?.stream === true) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof res.flushHeaders === 'function') res.flushHeaders();

      const write = (payload: unknown) => {
        if (closed) return;
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      try {
        const result = await client.chatStream(
          { ...common, stream: true },
          (event) => {
            if (event.type === 'done') return; // 结果在下面统一发
            write({ type: event.type, text: event.text });
          },
        );
        write({ type: 'done', result });
      } catch (e) {
        const err = e instanceof AIGatewayError ? e : null;
        write({
          type: 'error',
          code: err?.code || 'http',
          message: e instanceof Error ? e.message : String(e),
        });
      } finally {
        closed = true;
        res.end();
      }
      return;
    }

    try {
      const result = await client.chat(common);
      sendJson(res, 200, { ok: true, result });
    } catch (e) {
      const err = e instanceof AIGatewayError ? e : null;
      const status = err?.code === 'no_key' || err?.code === 'no_config' ? 400
        : err?.code === 'auth' ? 401
        : err?.code === 'rate_limit' ? 429
        : err?.code === 'timeout' ? 504
        : 502;
      sendJson(res, status, {
        ok: false,
        error: {
          code: err?.code || 'http',
          message: e instanceof Error ? e.message : String(e),
          status: err?.status,
        },
      });
    }
  });

  // ── 用量记录 ──
  router.use('/api/ai/usage', (req, res) => {
    const url = String(req.url || '');
    const m = url.match(/[?&]limit=(\d+)/);
    const limit = m ? Math.min(500, Number(m[1])) : 50;
    const records = client.recentUsage(limit);
    const today = new Date().toISOString().slice(0, 10);
    const todayRecords = records.filter((r) => String(r.ts || '').startsWith(today));
    sendJson(res, 200, {
      ok: true,
      records,
      totals: {
        calls: records.length,
        promptTokens: records.reduce((s, r) => s + (Number(r.promptTokens) || 0), 0),
        completionTokens: records.reduce((s, r) => s + (Number(r.completionTokens) || 0), 0),
        cost: records.reduce((s, r) => s + (Number(r.cost) || 0), 0),
        todayCalls: todayRecords.length,
        todayCost: todayRecords.reduce((s, r) => s + (Number(r.cost) || 0), 0),
      },
    });
  });

}
