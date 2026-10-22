// dsh-ielts-writing-examiner host half.
//
// Mounts:
//   - JSON RPC router at /ielts-examiner (loopback authority)
//   - Static asset routes at /ielts-examiner/asset/* (path-traversal safe)
//   - Prompt seeding from bundle to ~/.ielts-examiner/prompts/ on first run
//
// RPC methods (see migration-guide §7):
//   questionBank.list                          -> QuestionBankItem[]
//   session.list                               -> SessionRecord[]
//   session.create({questionId})               -> {id}
//   session.get({id})                          -> SessionRecord & {essay, result?}
//   session.updateEssay({id, essay})           -> meta
//   session.score({id})                        -> {ok, status:'running'}   (async)
//   session.pulse({id})                        -> {status, hasResult}
//   session.clone({id})                        -> {id}
//   session.delete({id})                       -> {ok, id}
//   chat.get({key})                            -> {key, messages: DisplayMessage[]}
//   chat.clear({key})                          -> {ok, key}
//   chat.migrate({from, to})                   -> {ok, migrated}
//   health                                     -> {ok, pluginRoot, dataRoot, time}
//   diag(payload)                              -> {ok}  (append-only to diag.jsonl)
//
// HTTP route (streaming, not RPC):
//   POST /ielts-examiner/chat  {key,lang,text,quotes,history,context}
//     -> text/event-stream: data: {"delta":"…"} / data: {"done":true,"message":{…}}
//                           / data: {"error":"…"}
//
// v1 deliberately omits config.get/set/test (no LLM channel config in plugin —
// DSH runtime decides) and session.exportPdf (PDF is pure client-side html2pdf.js).

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createSessionStore } from './session-store.js';
import { loadBank, findById } from './question-bank.js';
import { createChatStore } from './chat-store.js';
import {
  buildChatSystemPrompt,
  buildChatMessages,
  sanitizeKey,
  sanitizeUserText,
  sanitizeQuotes,
  sanitizeHistory,
} from './chat-prompt.js';
import { chatStreamDeltas } from './chat.js';

export const name = 'dsh-ielts-writing-examiner';
// `connection` is deliberately absent: the only thing this half ever used it
// for was the `connection.rpc.handle` channel, which is broken on 0.2.x (see
// the note above the route registrations). Every request arrives over HTTP.
// `llm` is what resolves endpoint + credentials for whichever provider the user
// actually selected — this plugin must not assume deepseek, or anything else.
export const inject = ['webServer', 'agentDefaultModel', 'llm', 'credentials'];

const HERE = dirname(fileURLToPath(import.meta.url));
// After esbuild bundles src/host/* into lib/index.js, HERE is the lib/ dir.
// One level up is the package root where package.json + assets/ + prompts/ live.
const PLUGIN_ROOT = resolve(join(HERE, '..'));
const ASSETS_DIR = join(PLUGIN_ROOT, 'assets');
const IMG_DIR = join(ASSETS_DIR, 'images-for-task1');
const PROMPT_SRC = join(PLUGIN_ROOT, 'prompts', '雅思写作.compressed.prompt.md');

function logError(scope, e) {
  console.error(`[dsh-ielts-writing-examiner] ${scope}:`, e?.stack || e);
}

function nowIso() {
  return new Date().toISOString();
}

function mimeFor(filename) {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'gif') return 'image/gif';
  return 'application/octet-stream';
}

/** Whitelist image filename. Mirrors pomasa's path-traversal guard. */
function isSafeImageName(name) {
  return typeof name === 'string'
    && name.length > 0
    && name.length < 200
    && !name.includes('/')
    && !name.includes('\\')
    && !name.includes('..')
    && !name.includes('\0')
    && /^[A-Za-z0-9._\-一-龥 ()（）]+$/.test(name);
}

/** Read and JSON-parse a request body, refusing anything over `limit` bytes. */
async function readJsonBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error(`request body too large (max ${limit} bytes)`);
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res, status, body, extraHeaders) {
  if (res.writableEnded) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(extraHeaders || {}),
  });
  res.end(JSON.stringify(body));
}

/**
 * One-shot migration: backfill meta.completedAt for sessions that have
 * result.json but no completedAt field (older runs from before markDone
 * stored it). Best-effort — missing result mtime falls back to createdAt.
 */
function backfillCompletedAt(store) {
  try {
    const list = store.list();
    let n = 0;
    for (const s of list) {
      if (s.status !== 'done') continue;
      if (s.completedAt) continue;
      const dir = join(store.paths.dataRoot, 'sessions', s.id);
      const resultP = path.join(dir, 'result.json');
      const metaP = path.join(dir, 'meta.json');
      let ts = s.createdAt || 0;
      try {
        const st = statSync(resultP);
        if (st.mtimeMs > ts) ts = st.mtimeMs;
      } catch {}
      try {
        const meta = JSON.parse(readFileSync(metaP, 'utf8'));
        meta.completedAt = ts;
        writeFileSync(metaP, JSON.stringify(meta, null, 2) + '\n');
        const idxP = store.paths.INDEX;
        const idx = JSON.parse(readFileSync(idxP, 'utf8'));
        const i = idx.findIndex((x) => x.id === s.id);
        if (i >= 0) { idx[i].completedAt = ts; writeFileSync(idxP, JSON.stringify(idx, null, 2) + '\n'); }
        n++;
      } catch {}
    }
    if (n > 0) console.log(`[dsh-ielts-writing-examiner] backfilled completedAt on ${n} sessions`);
  } catch (e) {
    console.error('[dsh-ielts-writing-examiner] backfill migration failed:', e?.message || e);
  }
}

/**
 * One-shot migration: backfill meta.task for sessions that pre-date the
 * task field. Looks up the question bank by questionId and copies task
 * ('1' or '2') into both meta.json and index.json. Skips sessions whose
 * questionId no longer resolves (e.g., bank was edited).
 */
function backfillTask(store, pluginRoot) {
  try {
    const list = store.list();
    let n = 0;
    for (const s of list) {
      if (s.task) continue;
      const q = findById(pluginRoot, s.questionId);
      if (!q || !q.task) continue;
      const dir = join(store.paths.dataRoot, 'sessions', s.id);
      const metaP = join(dir, 'meta.json');
      try {
        const meta = JSON.parse(readFileSync(metaP, 'utf8'));
        meta.task = q.task;
        writeFileSync(metaP, JSON.stringify(meta, null, 2) + '\n');
        const idxP = store.paths.INDEX;
        const idx = JSON.parse(readFileSync(idxP, 'utf8'));
        const i = idx.findIndex((x) => x.id === s.id);
        if (i >= 0) { idx[i].task = q.task; writeFileSync(idxP, JSON.stringify(idx, null, 2) + '\n'); }
        n++;
      } catch {}
    }
    if (n > 0) console.log(`[dsh-ielts-writing-examiner] backfilled task on ${n} sessions`);
  } catch (e) {
    console.error('[dsh-ielts-writing-examiner] backfill task migration failed:', e?.message || e);
  }
}

export function apply(ctx, config = {}) {
  try {
    return _applyInner(ctx, config);
  } catch (e) {
    // Surface the real error so the loader message isn't just "Reflect.has called on non-object".
    console.error('[dsh-ielts-writing-examiner] apply failed:', e?.stack || e);
    throw e;
  }
}

function _applyInner(ctx, config = {}) {
  const dataRoot = config.dataDir
    || process.env.IELTS_EXAMINER_HOME
    || join(homedir(), '.ielts-examiner');

  const store = createSessionStore(dataRoot);
  store.ensure();
  const chatStore = createChatStore(dataRoot);
  try {
    const pruned = chatStore.pruneDrafts();
    if (pruned > 0) console.log(`[dsh-ielts-writing-examiner] pruned ${pruned} abandoned draft chat(s)`);
  } catch { /* never block boot on chat housekeeping */ }
  store.seedPrompt({ src: PROMPT_SRC, destName: '雅思写作.compressed.prompt.md' });
  loadBank(PLUGIN_ROOT); // prime cache
  backfillCompletedAt(store);
  backfillTask(store, PLUGIN_ROOT);

  // Services the model calls need. `llm` owns endpoint/credential resolution;
  // without it only the standalone HTTP path exists. Mirrors session.score.
  const runtimeDeps = () => ({
    agentDefaultModel: ctx.agentDefaultModel || ctx.get?.('agentDefaultModel'),
    llm: ctx.llm || ctx.get?.('llm'),
    credentials: ctx.credentials || ctx.get?.('credentials'),
  });

  // ───────────────────────── RPC router ─────────────────────────
  async function handle(endpoint, payload) {
    switch (endpoint) {
      case 'questionBank.list': {
        const bank = loadBank(PLUGIN_ROOT);
        return bank.items.map((i) => ({
          id: i.id,
          task: i.task,
          title: i.title,
          type: i.type,
          date: i.date,
          topic: i.title,
          body: i.body,
          images: i.images,
          region: i.region,
          tags: i.tags,
        }));
      }
      case 'session.list': {
        // Augment with scoredAt (alias of completedAt) and overallBand for
        // the sidebar UI; everything else the client can pull via session.get.
        return store.list().map((s) => ({
          ...s,
          overallBand: s.overallBand,
          scoredAt: s.completedAt || null,
        }));
      }
      case 'session.create': {
        const { questionId } = payload || {};
        if (!questionId) throw new Error('session.create: questionId required');
        const q = findById(PLUGIN_ROOT, questionId);
        if (!q) throw new Error(`session.create: unknown questionId ${questionId}`);
        const meta = store.create({ questionId, questionTitle: q.title, task: q.task });
        return { id: meta.id };
      }
      case 'session.get': {
        const { id } = payload || {};
        if (!id) throw new Error('session.get: id required');
        const s = store.get(id);
        if (!s) throw new Error(`session.get: no such session ${id}`);
        return s;
      }
      case 'session.updateEssay': {
        const { id, essay } = payload || {};
        if (!id) throw new Error('session.updateEssay: id required');
        const s = store.get(id);
        if (!s) throw new Error(`session.updateEssay: no such session ${id}`);
        return store.updateEssay(id, String(essay || ''));
      }
      case 'session.score': {
        const { id } = payload || {};
        if (!id) throw new Error('session.score: id required');
        const s = store.get(id);
        if (!s) throw new Error(`session.score: no such session ${id}`);
        // No early-return on 'running' — stageOf reports 'running' as soon as
        // essay.txt exists (not "score in flight"). scoreEssay itself checks
        // for result.json and is idempotent. Always invoke so the LLM call
        // actually runs.
        console.log(`[dsh-ielts-writing-examiner] session.score fired id=${id} status=${s.status} deps.agentDefaultModel=${!!ctx.agentDefaultModel} deps.llm=${!!ctx.llm} deps.credentials=${!!ctx.credentials}`);
        store.markRunning(id);
        const deps = {
          agentDefaultModel: ctx.agentDefaultModel || ctx.get?.('agentDefaultModel'),
          // Without this, llm.js cannot resolve the endpoint for any provider
          // outside its hardcoded table and scoring fails outright.
          llm: ctx.llm || ctx.get?.('llm'),
          credentials: ctx.credentials || ctx.get?.('credentials'),
        };
        const { scoreEssay } = await import('./llm.js');
        scoreEssay({ store, sessionId: id, dataRoot, pluginRoot: PLUGIN_ROOT, deps })
          .then(() => console.log(`[dsh-ielts-writing-examiner] scoreEssay resolved for ${id}`))
          .catch((e) => {
            console.error(`[dsh-ielts-writing-examiner] scoreEssay REJECTED for ${id}:`, e?.message || e);
            logError('scoreEssay', e);
            try { store.markFailed(id, e?.message || String(e)); } catch {}
          });
        return { ok: true, status: 'running' };
      }
      case 'session.pulse': {
        const { id } = payload || {};
        if (!id) throw new Error('session.pulse: id required');
        return store.pulse(id);
      }
      case 'session.clone': {
        const { id } = payload || {};
        if (!id) throw new Error('session.clone: id required');
        const src = store.get(id);
        if (!src) throw new Error(`session.clone: no such session ${id}`);
        const meta = store.create({
          questionId: src.questionId,
          questionTitle: src.questionTitle,
          task: src.task,
        });
        // Reuse the original essay as starting draft.
        if (src.essay) store.updateEssay(meta.id, src.essay);
        return { id: meta.id };
      }
      case 'session.delete': {
        const { id } = payload || {};
        if (!id) throw new Error('session.delete: id required');
        const removed = store.remove(id);
        // The chat thread belongs to the practice; deleting the practice must
        // not leave an orphaned chat file behind.
        try { chatStore.remove(id); } catch { /* never fail the delete for this */ }
        return removed;
      }
      // ── chat-box transcript (see /ielts-examiner/chat for streaming) ──
      case 'chat.get': {
        const key = sanitizeKey(payload?.key);
        return chatStore.get(key);
      }
      case 'chat.clear': {
        const key = sanitizeKey(payload?.key);
        return chatStore.clear(key);
      }
      case 'chat.migrate': {
        const from = sanitizeKey(payload?.from);
        const to = sanitizeKey(payload?.to);
        return chatStore.migrate(from, to);
      }
      case 'health': {
        return { ok: true, pluginRoot: PLUGIN_ROOT, dataRoot, time: nowIso() };
      }
      // Client-side entry diagnostics. The single most common install failure
      // is "the IELTS button never appeared", which has two very different
      // causes (never registered vs. registered but not rendered). The browser
      // half can't be inspected without DevTools, so append to a JSONL the
      // user can just cat. Loopback-only, best-effort: a failure here must
      // never break the UI, hence the try/catch that swallows everything.
      case 'diag': {
        try {
          const line = JSON.stringify({ ts: nowIso(), ...(payload || {}) });
          if (typeof line === 'string' && line.length < 4096) {
            mkdirSync(dataRoot, { recursive: true });
            appendFileSync(join(dataRoot, 'diag.jsonl'), `${line}\n`);
          }
        } catch { /* diagnostics are never worth a user-visible error */ }
        return { ok: true };
      }
      default:
        throw new Error(`dsh-ielts-writing-examiner: unknown endpoint ${endpoint}`);
    }
  }

  // ───────────────────── chat streaming route ─────────────────────
  // The chat box streams model output to the browser. The JSON-RPC route cannot
  // stream, so this is a plain POST that owns a text/event-stream response.
  const SSE_HEADERS = {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no',
  };

  async function handleChatStream(req, res) {
    if ((req.method || 'POST').toUpperCase() !== 'POST') {
      sendJson(res, 405, { ok: false, error: { message: 'method not allowed' } });
      return;
    }
    // Validate before any stream bytes so malformed requests get a clean HTTP
    // error instead of a half-open stream.
    let parsed;
    try {
      const body = await readJsonBody(req, 2 * 1024 * 1024);
      const key = sanitizeKey(body?.key);
      const text = sanitizeUserText(body?.text);
      parsed = {
        key,
        text,
        quotes: sanitizeQuotes(body?.quotes),
        history: sanitizeHistory(body?.history),
        context: body?.context || {},
        lang: body?.lang === 'en' ? 'en' : 'zh',
      };
    } catch (e) {
      sendJson(res, 400, { ok: false, error: { message: String(e?.message || e) } });
      return;
    }

    res.writeHead(200, SSE_HEADERS);
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    let closed = false;
    const writeEvent = (obj) => {
      if (closed || res.writableEnded) return;
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* socket gone */ }
    };
    const ac = new AbortController();
    const onClose = () => {
      if (closed) return;
      closed = true;
      ac.abort(new Error('client disconnected'));
    };
    if (typeof res.on === 'function') res.on('close', onClose);
    // A slow first token must not look like a dead connection to a proxy; the
    // client parser ignores comment frames (`: ping`).
    const ping = setInterval(() => {
      if (!closed && !res.writableEnded) {
        try { res.write(': ping\n\n'); } catch { /* socket gone */ }
      }
    }, 15000);

    const userMessage = { role: 'user', content: parsed.text, quotes: parsed.quotes, ts: Date.now() };
    let full = '';
    try {
      const system = buildChatSystemPrompt({ lang: parsed.lang, context: parsed.context });
      const messages = buildChatMessages({
        history: parsed.history,
        text: parsed.text,
        quotes: parsed.quotes,
        lang: parsed.lang,
      });
      for await (const delta of chatStreamDeltas({
        deps: runtimeDeps(), system, messages, signal: ac.signal,
      })) {
        full += delta;
        writeEvent({ delta });
      }
      if (!full.trim()) throw new Error('LLM 返回了空内容');
      const assistantMessage = { role: 'assistant', content: full, ts: Date.now() };
      try {
        chatStore.save(parsed.key, [...parsed.history, userMessage, assistantMessage]);
      } catch (e) {
        logError('chat.save', e);
      }
      writeEvent({ done: true, message: assistantMessage });
    } catch (e) {
      logError('chat.stream', e);
      // Keep the question even when the answer failed, so a reload does not
      // silently lose what the student asked.
      try { chatStore.save(parsed.key, [...parsed.history, userMessage]); } catch { /* ignore */ }
      if (!ac.signal.aborted) writeEvent({ error: String(e?.message || e) });
    } finally {
      clearInterval(ping);
      closed = true;
      try { if (typeof res.off === 'function') res.off('close', onClose); } catch { /* ignore */ }
      if (!res.writableEnded) {
        try { res.end(); } catch { /* ignore */ }
      }
    }
  }

  // NOTE: the `connection.rpc.handle()` channel is deliberately NOT registered.
  // On Harness 0.2.0-rc.2 that API is unusable from a plugin: it registers
  // through *its own* fiber context (`owner = this.ctx`) and then reads
  // `owner.webServer`, but dsh-client-connection declares inject
  // ["credentials"] only — so the call always throws
  // `cannot get property "webServer" without inject`. Because this module
  // throws out of apply(), every route below was left unregistered and the
  // plugin answered 405 on /ielts-examiner/rpc. Nothing read this channel
  // anyway: src/client/api.js talks to the HTTP route below via fetch, and
  // every working sibling (pictor, dsh-rag-qmd-wiki, dsh-app-dock) registers
  // webServer routes the same way.

  // ───────────────────────── asset routes ─────────────────────────
  const ws = ctx.webServer || ctx.get?.('webServer');
  if (ws && typeof ws.register === 'function') {
    // /ielts-examiner/rpc — POST {endpoint, payload} → {ok, value} or {ok:false, error}.
    // Direct HTTP path (no DSH client-modules required). Mirrors pomasa's
    // /pomasa/* routes and the pictor /pictor/* static asset endpoint.
    ws.register({
      kind: 'exact',
      path: '/ielts-examiner/rpc',
      handler: async (req, res) => {
        try {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
          const value = await handle(body.endpoint, body.payload || {});
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, value }));
        } catch (e) {
          logError(`rpc:${req?.url}`, e);
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: { code: 'internal', message: String(e?.message || e) } }));
        }
      },
    });

    // /ielts-examiner/chat — POST, streams the chat-box reply as SSE.
    ws.register({
      kind: 'exact',
      path: '/ielts-examiner/chat',
      handler: handleChatStream,
    });

    const IMG_CACHE = { 'cache-control': 'public, max-age=3600' };

    // /ielts-examiner/asset/images-for-task1/<safe-filename>
    ws.register({
      kind: 'prefix',
      path: '/ielts-examiner/asset/images-for-task1',
      handler: (req, res) => {
        try {
          const url = new URL(req.url || '/', 'http://x');
          const base = '/ielts-examiner/asset/images-for-task1';
          const name = decodeURIComponent(url.pathname.slice(base.length).replace(/^\/+/, ''));
          if (!isSafeImageName(name)) {
            res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('bad request');
            return;
          }
          const p = join(IMG_DIR, name);
          if (!p.startsWith(IMG_DIR + sep) && p !== IMG_DIR) {
            res.writeHead(400); res.end('bad request'); return;
          }
          if (!existsSync(p)) {
            res.writeHead(404); res.end('not found'); return;
          }
          res.writeHead(200, { ...IMG_CACHE, 'content-type': mimeFor(name) });
          res.end(readFileSync(p));
        } catch (e) {
          logError('asset:images', e);
          res.writeHead(500); res.end('asset error');
        }
      },
    });
  }

  return {
    name,
    inject,
    dataRoot,
    paths: { pluginRoot: PLUGIN_ROOT, assetsDir: ASSETS_DIR, imgDir: IMG_DIR, promptSrc: PROMPT_SRC },
  };
}
