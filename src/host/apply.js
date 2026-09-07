// dsh-ielts-examiner host half.
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
//
// v1 deliberately omits config.get/set/test (no LLM channel config in plugin —
// DSH runtime decides) and session.exportPdf (PDF is pure client-side html2pdf.js).

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createSessionStore } from './session-store.js';
import { loadBank, findById } from './question-bank.js';

export const name = 'dsh-ielts-examiner';
export const inject = ['connection', 'webServer', 'agentDefaultModel', 'credentials'];

const HERE = dirname(fileURLToPath(import.meta.url));
// After esbuild bundles src/host/* into lib/index.js, HERE is the lib/ dir.
// One level up is the package root where package.json + assets/ + prompts/ live.
const PLUGIN_ROOT = resolve(join(HERE, '..'));
const ASSETS_DIR = join(PLUGIN_ROOT, 'assets');
const IMG_DIR = join(ASSETS_DIR, 'images-for-task1');
const PROMPT_SRC = join(PLUGIN_ROOT, 'prompts', '雅思写作.compressed.prompt.md');

function logError(scope, e) {
  console.error(`[dsh-ielts-examiner] ${scope}:`, e?.stack || e);
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

/**
 * One-shot migration: backfill meta.completedAt for sessions that have
 * result.json but no completedAt field (older runs from before markDone
 * stored it). Best-effort — missing result mtime falls back to createdAt.
 */
function backfillCompletedAt(store) {
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const list = store.list();
    let n = 0;
    for (const s of list) {
      if (s.status !== 'done') continue;
      if (s.completedAt) continue;
      const dir = path.join(store.paths.dataRoot, 'sessions', s.id);
      const resultP = path.join(dir, 'result.json');
      const metaP = path.join(dir, 'meta.json');
      let ts = s.createdAt || 0;
      try {
        const st = fs.statSync(resultP);
        if (st.mtimeMs > ts) ts = st.mtimeMs;
      } catch {}
      try {
        const meta = JSON.parse(fs.readFileSync(metaP, 'utf8'));
        meta.completedAt = ts;
        fs.writeFileSync(metaP, JSON.stringify(meta, null, 2) + '\n');
        // also patch the in-memory index
        const idxP = store.paths.INDEX;
        const idx = JSON.parse(fs.readFileSync(idxP, 'utf8'));
        const i = idx.findIndex((x) => x.id === s.id);
        if (i >= 0) { idx[i].completedAt = ts; fs.writeFileSync(idxP, JSON.stringify(idx, null, 2) + '\n'); }
        n++;
      } catch {}
    }
    if (n > 0) console.log(`[dsh-ielts-examiner] backfilled completedAt on ${n} sessions`);
  } catch (e) {
    console.error('[dsh-ielts-examiner] backfill migration failed:', e?.message || e);
  }
}

export function apply(ctx, config = {}) {
  try {
    return _applyInner(ctx, config);
  } catch (e) {
    // Surface the real error so the loader message isn't just "Reflect.has called on non-object".
    console.error('[dsh-ielts-examiner] apply failed:', e?.stack || e);
    throw e;
  }
}

function _applyInner(ctx, config = {}) {
  const dataRoot = config.dataDir
    || process.env.IELTS_EXAMINER_HOME
    || join(homedir(), '.ielts-examiner');

  const store = createSessionStore(dataRoot);
  store.ensure();
  store.seedPrompt({ src: PROMPT_SRC, destName: '雅思写作.compressed.prompt.md' });
  loadBank(PLUGIN_ROOT); // prime cache
  backfillCompletedAt(store);

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
        const meta = store.create({ questionId, questionTitle: q.title });
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
        console.log(`[dsh-ielts-examiner] session.score fired id=${id} status=${s.status} deps.agentDefaultModel=${!!ctx.agentDefaultModel} deps.credentials=${!!ctx.credentials}`);
        store.markRunning(id);
        const deps = {
          agentDefaultModel: ctx.agentDefaultModel || ctx.get?.('agentDefaultModel'),
          credentials: ctx.credentials || ctx.get?.('credentials'),
        };
        const { scoreEssay } = await import('./llm.js');
        scoreEssay({ store, sessionId: id, dataRoot, pluginRoot: PLUGIN_ROOT, deps })
          .then(() => console.log(`[dsh-ielts-examiner] scoreEssay resolved for ${id}`))
          .catch((e) => {
            console.error(`[dsh-ielts-examiner] scoreEssay REJECTED for ${id}:`, e?.message || e);
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
        });
        // Reuse the original essay as starting draft.
        if (src.essay) store.updateEssay(meta.id, src.essay);
        return { id: meta.id };
      }
      case 'session.delete': {
        const { id } = payload || {};
        if (!id) throw new Error('session.delete: id required');
        return store.remove(id);
      }
      case 'health': {
        return { ok: true, pluginRoot: PLUGIN_ROOT, dataRoot, time: nowIso() };
      }
      default:
        throw new Error(`dsh-ielts-examiner: unknown endpoint ${endpoint}`);
    }
  }

  const connection = ctx.connection || ctx.get?.('connection');
  if (connection && connection.rpc && typeof connection.rpc.handle === 'function') {
    connection.rpc.handle('/ielts-examiner', async (endpoint, payload) => {
      try {
        return { ok: true, value: await handle(endpoint, payload || {}) };
      } catch (e) {
        logError(`rpc:${endpoint}`, e);
        return { ok: false, error: { code: 'internal', message: String(e?.message || e), details: {} } };
      }
    }, { authority: 'loopback' });
  }

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
