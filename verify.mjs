#!/usr/bin/env node
// verify.mjs — L1+L2 offline smoke. No LLM call required.
//
// Exercises session-store + question-bank + RPC router against a temp data
// dir. Asserts:
//   - Question bank loads (>=1 item per Task)
//   - session.create / session.list / session.get round-trip
//   - session.updateEssay persists essay.txt + bumps wordCount
//   - session.clone creates a new id with the same questionId
//   - session.delete removes files + index entry
//   - prompt was seeded into ~/.ielts-examiner/prompts/
//   - asset route serves a known image with correct content-type

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = HERE;
const PLUGIN_ROOT = ROOT;
const DATA_ROOT = join(ROOT, '.verify-data');

const LIB = join(PLUGIN_ROOT, 'lib', 'index.js');

let failures = 0;
function ok(label) { console.log(`  ✓ ${label}`); }
function fail(label, why) { failures++; console.error(`  ✗ ${label} — ${why}`); }
function eq(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) ok(label);
  else fail(label, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}
function truthy(label, got) {
  if (got) ok(label); else fail(label, `expected truthy, got ${JSON.stringify(got)}`);
}

// Clean data dir before each run.
if (existsSync(DATA_ROOT)) rmSync(DATA_ROOT, { recursive: true, force: true });
mkdirSync(DATA_ROOT, { recursive: true });

// Mock host context: capture route registrations and expose the same shape as
// the DSH runtime.
const ctx = {
  // TRAP. On Harness 0.2.0-rc.2, `connection.rpc.handle()` registers through
  // dsh-client-connection's OWN fiber context and then reads `owner.webServer`,
  // but that plugin declares inject ["credentials"] only — so the call always
  // throws `cannot get property "webServer" without inject`. This plugin used to
  // call it first thing in apply(), which aborted before any route was
  // registered and left the GUI answering 405 on /ielts-examiner/rpc. The mock
  // reproduces that throw so the regression cannot come back unnoticed.
  connection: {
    rpc: {
      handle() { throw new Error('cannot get property "webServer" without inject'); },
    },
  },
  webServer: {
    _routes: [],
    register(spec) {
      const clash = this._routes.find((r) => r.kind === spec.kind && r.path === spec.path);
      if (clash) throw new Error(`webserver: duplicate ${spec.kind} route "${spec.path}"`);
      this._routes.push(spec);
    },
    // `opts` is additive; existing _dispatch(method, url, body) calls behave
    // exactly as before. It lets a test watch the stream as it is written
    // (opts.onChunk), grab the raw res to simulate a client disconnect
    // (opts.onRes), or assert on the accumulated chunks.
    async _dispatch(method, urlPath, body, opts = {}) {
      for (const r of this._routes) {
        if ((r.kind === 'exact' && r.path === urlPath) || (r.kind === 'prefix' && urlPath.startsWith(r.path))) {
          return await new Promise((resolve, reject) => {
            const listeners = new Map();
            const addListener = (name, fn) => {
              if (!listeners.has(name)) listeners.set(name, []);
              listeners.get(name).push(fn);
            };
            const emit = (name) => {
              for (const fn of listeners.get(name) || []) {
                try { fn(); } catch { /* listener errors are the handler's problem */ }
              }
            };
            // Response mock. One-shot endpoints still call end(body) once (the
            // asset route even passes a Buffer); SSE routes call
            // writeHead() → write()* → end(), so both paths have to work.
            const res = {
              _status: 200, _headers: {}, _chunks: [], _body: null,
              _ended: false, headersSent: false, writableEnded: false, destroyed: false,
              writeHead(s, h) { this._status = s; Object.assign(this._headers, h || {}); this.headersSent = true; },
              setHeader(k, v) { this._headers[k] = v; },
              getHeader(k) { return this._headers[k]; },
              removeHeader(k) { delete this._headers[k]; },
              flushHeaders() { this.headersSent = true; },
              write(chunk) {
                if (this._ended) return false;
                this.headersSent = true;
                this._chunks.push(chunk);
                try { opts.onChunk?.(chunk); } catch { /* ignore */ }
                return true;
              },
              end(chunk) {
                if (this._ended) return;
                this._ended = true;
                this.writableEnded = true;
                if (chunk !== undefined && chunk !== null && chunk !== '') this._chunks.push(chunk);
                const allStrings = this._chunks.every((c) => typeof c === 'string');
                this._body = this._chunks.length === 0
                  ? ''
                  : allStrings
                    ? this._chunks.join('')
                    : Buffer.concat(this._chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c)))));
                resolve({
                  status: this._status,
                  headers: { ...this._headers },
                  body: this._body,
                  chunks: this._chunks.slice(),
                });
              },
              on(name, fn) { addListener(name, fn); return this; },
              once(name, fn) {
                const wrap = () => { this.off(name, wrap); fn(); };
                addListener(name, wrap);
                return this;
              },
              off(name, fn) {
                const list = listeners.get(name);
                if (list) { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); }
                return this;
              },
              removeListener(name, fn) { return this.off(name, fn); },
              destroy() { this.destroyed = true; this._ended = true; emit('close'); },
              _emit: emit,
            };
            // The real IncomingMessage is an async iterable; the RPC handler
            // does `for await (const c of req)`, so the mock must be too.
            const payload = Buffer.from(body || '', 'utf8');
            const reqListeners = new Map();
            const req = {
              method,
              url: urlPath,
              headers: {},
              async *[Symbol.asyncIterator]() {
                if (payload.length) yield payload;
              },
              on(name, fn) {
                if (!reqListeners.has(name)) reqListeners.set(name, []);
                reqListeners.get(name).push(fn);
                return req;
              },
              once(name, fn) { return req.on(name, fn); },
              off(name, fn) {
                const list = reqListeners.get(name);
                if (list) { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); }
                return req;
              },
              removeListener(name, fn) { return req.off(name, fn); },
            };
            try { opts.onRes?.(res, req); } catch { /* ignore */ }
            try {
              const out = r.handler(req, res);
              if (out && typeof out.then === 'function') out.catch((e) => reject(e));
            } catch (e) {
              reject(e);
            }
          });
        }
      }
      return null;
    },
  },
  // Stub LLM services — verify that the plugin asks them for config.
  agentDefaultModel: {
    currentSelection() { return { provider: 'deepseek-official', model: 'deepseek-v4-flash' }; },
  },
  // Stand-in for @deepseek-ai/dsh-llm's LlmRuntime: a registry plus a
  // streaming model-call API. It owns endpoint + credential resolution, which is
  // why the plugin can no longer ask "what is the baseUrl for this provider?".
  llm: {
    _calls: [],
    async prepareCall(config) {
      this._calls.push(config);
      const cfg = { provider: config.provider, model: config.model, temperature: config.temperature };
      return {
        config: cfg,
        retryPolicy: undefined,
        stream: (options) => {
          // Mirrors the real guard: callConfigEquals compares only the config
          // fields, never `messages`.
          for (const k of ['provider', 'model', 'temperature']) {
            if (options[k] !== cfg[k]) throw new Error(`prepared call config changed: ${k}`);
          }
          const messages = options.messages || [];
          const last = messages[messages.length - 1];
          const text = (last?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
          return (async function* () {
            yield { type: 'chunk', chunk: { type: 'text-delta', text: text.slice(0, 10) } };
            yield { type: 'text-chunks', texts: [text.slice(10)] };
            yield { type: 'finish', reason: { kind: 'stop' } };
          })();
        },
      };
    },
  },
  credentials: {
    async resolve(ref) { return { value: 'sk-test-stub', ref }; },
  },
};

// 0. manifest coherence
//
// cordis.patch.yml's `name` is the module specifier the Loader imports, and the
// client envelope's `id` is the ModuleLoader's identity — both must equal
// package.json#name. These drifted to the pre-rename id; once that npm name was
// unpublished (2026-09-08) the row became unresolvable and the plugin stopped
// mounting *entirely*: no __DSH_BOOT__ entry, no RPC route, no entry button,
// and nothing in the logs but a generic import failure. Cheap to check, and
// the failure mode is completely silent without it.
console.log('\n[verify] manifest coherence');
{
  const pkg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'));
  const patchRows = readFileSync(join(PLUGIN_ROOT, 'cordis.patch.yml'), 'utf8')
    .split('\n')
    .map((l) => l.trim().replace(/^-\s*/, ''))   // drop YAML list-item dash
    .filter((l) => l && !l.startsWith('#'));
  const field = (key) => patchRows
    .filter((l) => l.startsWith(`${key}:`))
    .map((l) => l.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, ''));
  eq('cordis.patch.yml row name resolves to the package', field('name'), [pkg.name]);
  eq('cordis.patch.yml row id matches the package', field('id'), [pkg.name]);

  const clientId = /id:\s*"([^"]+)"/.exec(readFileSync(join(PLUGIN_ROOT, 'lib', 'client.js'), 'utf8'))?.[1];
  eq('client ModuleLoader id matches the package name', clientId, pkg.name);

  const hostName = (await import(LIB)).name;
  eq('host half exports the package name', hostName, pkg.name);

  // The client half is only served when the package exports a "./client" entry;
  // a mismatch here drops the row from __DSH_BOOT__ just as silently.
  eq('exports map points ./client at the built bundle', pkg.exports?.['./client'], './lib/client.js');
  truthy('cordis.patch.yml is inside files[]', (pkg.files || []).includes('cordis.patch.yml'));
  truthy('lib (build output) is inside files[]', (pkg.files || []).includes('lib'));
}

console.log('[verify] booting plugin host half…');
const mod = await import(LIB);
const result = mod.apply(ctx, { dataDir: DATA_ROOT });

truthy('apply() returns dataRoot', result.dataRoot === DATA_ROOT);
eq('inject[]', result.inject, ['webServer', 'agentDefaultModel', 'llm', 'credentials']);

// Drive every RPC test through the real HTTP route the browser uses, rather
// than through a `connection.rpc` channel the plugin no longer registers.
// src/client/api.js POSTs {endpoint, payload} to /ielts-examiner/rpc.
const RPC_PATH = '/ielts-examiner/rpc';
async function rpcCall(endpoint, payload) {
  const res = await ctx.webServer._dispatch('POST', RPC_PATH, JSON.stringify({ endpoint, payload }));
  if (!res) throw new Error(`no route for ${RPC_PATH} — the host half never registered`);
  if (res.status !== 200) throw new Error(`${endpoint}: HTTP ${res.status} ${res.body ?? ''}`);
  const data = JSON.parse(String(res.body));
  if (data?.ok === false) throw new Error(data.error?.message || `${endpoint} failed`);
  return data.value;
}

// The 0.2.x breakage that cost us the whole host half: connection.rpc.handle()
// throws, and apply() must still register its routes. ctx.connection is a trap
// that reproduces that exact error.
truthy('routes registered despite connection.rpc.handle throwing',
  ctx.webServer._routes.some((r) => r.kind === 'exact' && r.path === RPC_PATH));

// 1. questionBank.list
console.log('\n[verify] questionBank.list');
const qs = await rpcCall('questionBank.list');
truthy('items > 0', qs.length > 0);
truthy('has Task 1 items', qs.some((q) => q.task === '1'));
truthy('has Task 2 items', qs.some((q) => q.task === '2'));

// 2. session lifecycle
console.log('\n[verify] session lifecycle');
const firstQ = qs[0];
const { id: sid } = await rpcCall('session.create', { questionId: firstQ.id });
truthy('session.create returns id', typeof sid === 'string' && sid.length === 12);

const list1 = await rpcCall('session.list');
const listRow = list1.find((s) => s.id === sid);
truthy('session.list includes new session', !!listRow);
eq('list row carries task', listRow?.task, firstQ.task);

const got = await rpcCall('session.get', { id: sid });
eq('get().questionId', got.questionId, firstQ.id);
eq('get().status', got.status, 'idle');
eq('get().task', got.task, firstQ.task);

const essay = 'Some practice essay about graphs and trends in modern cities. ' +
  'It should be at least fifty words long to pass the minimum length check. ' +
  'Yes indeed there are many things to say about this topic. '.repeat(4);
const meta = await rpcCall('session.updateEssay', { id: sid, essay });
truthy('updateEssay bumps wordCount', meta.wordCount > 50);
eq('updateEssay.status=running', meta.status, 'running');

// 3. session.clone
const { id: sid2 } = await rpcCall('session.clone', { id: sid });
truthy('clone has different id', sid2 !== sid);
const got2 = await rpcCall('session.get', { id: sid2 });
eq('clone copies questionId', got2.questionId, firstQ.id);
eq('clone copies task', got2.task, firstQ.task);
truthy('clone carries over essay', got2.essay.length > 50);

// 4. session.pulse (no result.json yet)
const pulse = await rpcCall('session.pulse', { id: sid });
eq('pulse.running', pulse.status, 'running');
eq('pulse.hasResult', pulse.hasResult, false);

// 5. session.delete
const del = await rpcCall('session.delete', { id: sid2 });
eq('delete.ok', del.ok, true);
const list2 = await rpcCall('session.list');
truthy('deleted session not in list', !list2.some((s) => s.id === sid2));

// 6. prompt seeded
console.log('\n[verify] prompt seeding');
const seededPath = join(DATA_ROOT, 'prompts', '雅思写作.compressed.prompt.md');
truthy('prompt file exists', existsSync(seededPath));
truthy('prompt file non-empty', statSync(seededPath).size > 1000);

// 7. asset route
console.log('\n[verify] asset route');
const knownImage = qs.find((q) => q.task === '1')?.id;
// We don't have image filenames in the slim list; use first known PNG.
const IMG_DIR = join(PLUGIN_ROOT, 'assets', 'images-for-task1');
const imgName = readdirSync(IMG_DIR)[0];
truthy('found a task-1 image', !!imgName);

const resp = await ctx.webServer._dispatch('GET', `/ielts-examiner/asset/images-for-task1/${imgName}`);
truthy('asset route returns 200', resp?.status === 200);
eq('asset content-type', resp?.headers?.['content-type'], 'image/png');
truthy('asset body non-empty', resp?.body && resp.body.length > 100);

// 8. bad path blocked
const bad = await ctx.webServer._dispatch('GET', '/ielts-examiner/asset/images-for-task1/../../etc/passwd');
truthy('path-traversal blocked', bad?.status === 400);

// 9. unknown endpoint
let threw = false;
try { await rpcCall('session.bogus', {}); } catch { threw = true; }
truthy('unknown endpoint throws', threw);

// 10. health
const health = await rpcCall('health');
truthy('health.ok', health?.ok === true);

// 11. LLM wiring — resolveDefaultModel reads from ctx services
console.log('\n[verify] LLM wiring');
const { resolveDefaultModel } = await import('./src/host/default-model.js');
const resolved = await resolveDefaultModel({
  agentDefaultModel: ctx.agentDefaultModel,
  credentials: ctx.credentials,
});
eq('resolveDefaultModel.provider', resolved.provider, 'deepseek-official');
eq('resolveDefaultModel.model', resolved.model, 'deepseek-v4-flash');
eq('resolveDefaultModel.baseUrl', resolved.baseUrl, 'https://api.deepseek.com/v1');
eq('resolveDefaultModel.apiKey', resolved.apiKey, 'sk-test-stub');

// The regression that shipped: the user's profile selects minimax-cn, which is
// not in PROVIDER_DEFAULTS. The table silently fell through to
// openai_compatible (empty baseUrl/credentialRef) and scoring failed with
// "runtime 已选中 provider=minimax-cn，但  未配置". With the llm service the
// provider name never has to be in a table at all.
const foreign = {
  agentDefaultModel: { currentSelection: () => ({ provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash-Preview' }) },
  llm: ctx.llm,
};
const resolvedForeign = await resolveDefaultModel(foreign);
eq('unlisted provider still resolves', resolvedForeign.provider, 'minimax-cn');
eq('unlisted provider model preserved', resolvedForeign.model, 'MiniMax-M3.1-Flash-Preview');
eq('unlisted provider dispatches via the llm service', resolvedForeign.dispatch, 'llm-service');
eq('llm-service path invents no baseUrl', resolvedForeign.baseUrl, undefined);

// Without the llm service the failure must name the real gap (no endpoint for
// this provider), not blame a credential ref that was never resolved.
let foreignErr = null;
try {
  await resolveDefaultModel({ agentDefaultModel: foreign.agentDefaultModel, credentials: ctx.credentials });
} catch (e) { foreignErr = e; }
truthy('unlisted provider without llm service fails loudly', !!foreignErr);
truthy('error names the provider, not a bogus credential ref',
  !!foreignErr && foreignErr.message.includes('minimax-cn') && !foreignErr.message.includes('refs. 写入密钥'));

// 12. resolveDefaultModel throws cleanly when nothing configured
let threwClean = false;
try {
  await resolveDefaultModel({});
} catch (e) {
  threwClean = /未配置default模型|未配置默认模型/.test(e.message);
}
truthy('resolveDefaultModel throws clear error when no ctx + no env', threwClean);

// 13. End-to-end scoring through the llm service. The scoring path had NO
// coverage at all, which is how a provider-specific failure shipped: the
// user's profile selects minimax-cn, PROVIDER_DEFAULTS had no entry, and the
// run died before any request was made.
console.log('\n[verify] session.score end-to-end');
{
  const VALID_SCORE = {
    matchedTask: 'Task2', taskSource: 'practice',
    analysis: {
      taskType: 'Task2', questionType: 'Opinion', topic: '社会',
      imageDescription: null, strategy: '让步+反驳',
      keyPoints: ['免费供水', '公共健康'], mermaidDiagram: '',
      techniques: ['让步法'],
    },
    correction: {
      overallBand: 6.5,
      criteriaScores: {
        taskResponse: { score: 6.5, note: '切题' },
        coherenceCohesion: { score: 6.5, note: '连贯' },
        lexicalResource: { score: 6, note: '词汇尚可' },
        grammaticalRange: { score: 6.5, note: '句式多样' },
      },
    },
    sampleEssay: '示例范文',
  };
  // Route through the llm service only — no baseUrl, no apiKey anywhere.
  ctx.agentDefaultModel.currentSelection = () => ({
    provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash-Preview',
  });
  ctx.llm._calls.length = 0;
  // The mock MUST mirror the real adapter's record shape. An earlier version
  // yielded {type:'text-chunks'} — the accumulator's compact form, which the
  // plugin happened to prefer — so the test passed while the live adapter's
  // flat {type:'text-delta'} records were silently dropped and scoring died
  // with "Unexpected end of JSON input". Real pi-ai stream, per its switch:
  //   start → text_start → text_delta* → text_end → finish
  const REPLY = '```json\n' + JSON.stringify(VALID_SCORE) + '\n```';
  ctx.llm.prepareCall = async function (config) {
    this._calls.push(config);
    const cfg = { provider: config.provider, model: config.model, temperature: config.temperature };
    return {
      config: cfg,
      stream: () => (async function* () {
        yield { type: 'start' };
        yield { type: 'text_start', index: 0 };
        // Split mid-string so a read that ignores deltas cannot pass either.
        yield { type: 'text-delta', index: 0, text: REPLY.slice(0, 12) };
        yield { type: 'text-delta', index: 0, text: REPLY.slice(12) };
        yield { type: 'text_end', index: 0 };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })(),
    };
  };

  const scored = await rpcCall('session.create', { questionId: firstQ.id });
  await rpcCall('session.updateEssay', { id: scored.id, essay: 'The chart illustrates a clear trend over time.' });
  rpcCall('session.score', { id: scored.id });

  // scoreEssay runs detached; poll the session rather than racing it.
  let settled = null;
  for (let i = 0; i < 150; i++) {
    const s = await rpcCall('session.get', { id: scored.id });
    if (s.status === 'done' || s.status === 'failed') { settled = s; break; }
    await new Promise((r) => setTimeout(r, 20));
  }
  eq('score completed via the llm service', settled?.status, 'done');
  eq('llm service was asked for the user-selected provider', ctx.llm._calls[0]?.provider, 'minimax-cn');
  eq('llm service was asked for the user-selected model', ctx.llm._calls[0]?.model, 'MiniMax-M3.1-Flash-Preview');
  truthy('result persisted from the llm-service reply',
    !!settled?.result && settled.result.correction.overallBand === 6.5);
  eq('fenced JSON parsed by the service path',
    settled?.result?.correction?.criteriaScores?.taskResponse?.score, 6.5);
  eq('no hardcoded endpoint was used', resolvedForeign.baseUrl, undefined);
}

// 14. Record-shape contract for the llm stream. This is the failure that made a
// good model reply look like a failure: the plugin only understood the nested
// accumulator form, so the adapter's flat text-delta records were dropped and
// safeParseJson reported "Unexpected end of JSON input".
console.log('\n[verify] llm stream record shapes');
{
  const { streamViaLlmService } = await import('./src/host/llm.js');
  const fakeLlm = (records) => ({
    async prepareCall() {
      return { config: { provider: 'p', model: 'm', temperature: 0.4 }, stream: () => (async function* () { yield* records; })() };
    },
  });
  const run = (records) => streamViaLlmService(fakeLlm(records), { provider: 'p', model: 'm', prompt: 'x' });

  eq('flat adapter deltas (the real pi-ai shape)',
    await run([
      { type: 'start' },
      { type: 'text-delta', index: 0, text: '{"band":' },
      { type: 'text-delta', index: 0, text: '6.5}' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]), '{"band":6.5}');

  eq('compact accumulator form still accepted',
    await run([
      { type: 'chunk', chunk: { type: 'text-delta', text: 'ab' } },
      { type: 'text-chunks', texts: ['cd'] },
      { type: 'finish', reason: { kind: 'stop' } },
    ]), 'abcd');

  eq('whole-text record used when no deltas arrive',
    await run([{ type: 'text', text: 'whole' }, { type: 'finish', reason: { kind: 'stop' } }]), 'whole');

  eq('deltas and whole text are not concatenated twice',
    await run([
      { type: 'text-delta', index: 0, text: 'AB' },
      { type: 'text', text: 'AB' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]), 'AB');

  let emptyErr = null;
  try { await run([{ type: 'usage' }, { type: 'finish', reason: { kind: 'stop' } }]); }
  catch (e) { emptyErr = e; }
  truthy('a reply with no text fails loudly', !!emptyErr);
  truthy('the empty-reply error names the provider instead of blaming JSON',
    !!emptyErr && /返回了空内容/.test(emptyErr.message) && !/JSON/.test(emptyErr.message));

  let finishErr = null;
  try {
    await run([
      { type: 'text-delta', index: 0, text: 'partial' },
      { type: 'finish', reason: { kind: 'error', failure: new Error('upstream 429') } },
    ]);
  } catch (e) { finishErr = e; }
  eq('terminal finish error surfaces the adapter failure', finishErr?.message, 'upstream 429');
}

// 13. diag endpoint — the client half's entry diagnostics must land on disk.
console.log('\n[verify] diag endpoint');
await rpcCall('diag', { phase: 'entry', entry: 'dock', dock: true });
truthy('diag.jsonl written', existsSync(join(DATA_ROOT, 'diag.jsonl')));
truthy('diag line is jsonl', readFileSync(join(DATA_ROOT, 'diag.jsonl'), 'utf8').trim().split('\n').length === 1);

// ── L2c: client entry arbitration (dock first, self-owned footer fallback) ──
//
// Why this matters (regression carried over from dsh-pictor 0.2.5): dsh only
// mounts the bundle layers listed in a profile's `dsh.profile.bundles`. A dock
// that is merely an npm transitive dependency never lands there, so its client
// half never reaches __DSH_BOOT__ — and an entry point delegated purely to the
// dock means NO entry point at all. The client half therefore tries the dock,
// waits out a grace period, and only then claims `sidebar.footer.action`
// itself; a late-arriving dock wins and the self-owned button is withdrawn.
//
// These boot lib/client.js inside a fake browser realm (the factory is a fresh
// closure per call, so each boot is independent apart from the shared `window`).

/** Minimal fake dock: records register() calls on `.calls`, mirrors the real registry shape. */
function fakeDock(lang) {
  const subs = new Set();
  const calls = [];
  return {
    calls,
    register(app) { calls.push(app); return true },
    unregister() { return true },
    lang: lang ? {
      get: () => lang.value,
      set(v) { lang.value = v; for (const f of subs) f() },
      subscribe(fn) { subs.add(fn); return () => subs.delete(fn) },
    } : null,
  };
}

/** Fake LocaleRuntime as shipped by @deepseek-ai/dsh-client-locale on 0.2.x. */
function fakeLocale(active) {
  const subs = new Set();
  return {
    getSnapshot: () => ({ active, locales: [{ id: 'zh' }, { id: 'en' }], revision: 0 }),
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn) },
    emit(next) { active = next; for (const f of subs) f() },
  };
}

function bootClient({ dock, locale, fetch: fetchImpl } = {}) {
  const source = readFileSync(join(PLUGIN_ROOT, 'lib', 'client.js'), 'utf8');
  const listeners = new Map();
  const timers = [];
  const registrations = [];
  const dockCalls = [];
  let captured = null;

  const win = {
    __ModuleLoader__: { load: (def) => { captured = def.factory } },
    addEventListener: (name, fn) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
    },
    removeEventListener: (name, fn) => { listeners.get(name)?.delete(fn) },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
  };
  if (dock !== undefined) win.__dshAppDock__ = dock;

  const doc = {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild: () => {} },
    addEventListener: () => {},
    querySelector: () => null,
  };
  const fakeConsole = { info: () => {}, warn: () => {}, log: () => {}, error: () => {} };
  // The bundle is an IIFE-shaped __ModuleLoader__ envelope; shadow the few
  // browser globals it touches so it evaluates outside a browser.
  // `fetch` is per-test because the chat path streams: a test supplies a
  // Response-like whose body is a ReadableStream of SSE chunks.
  const defaultFetch = () => Promise.resolve({ ok: true, json: async () => ({}) });
  new Function('window', 'document', 'localStorage', 'fetch', 'console', 'location', source)(
    win,
    doc,
    { getItem: () => null, setItem: () => {} },
    fetchImpl || defaultFetch,
    fakeConsole,
    { href: 'http://127.0.0.1:3080/' },
  );

  const React = {
    createElement: (...args) => ({ args }),
    useState: (v) => [v, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
  };
  const slots = {
    inject: (_key, cb) => {
      const dispose = typeof cb === 'function' ? cb() : undefined;
      return typeof dispose === 'function' ? dispose : () => {};
    },
    register: (options) => {
      registrations.push(options);
      return () => {
        const at = registrations.indexOf(options);
        if (at >= 0) registrations.splice(at, 1);
      };
    },
  };
  const ctx = {
    get: (key) => {
      if (key === 'slots') return slots;
      if (key === 'locale') return locale;
      return undefined;
    },
  };
  const moduleOf = () => captured((name) => (name === 'react' ? React : undefined));

  return {
    win,
    apply: () => moduleOf().apply(ctx),
    exports: () => moduleOf(),
    testApi: () => moduleOf()._test,
    react: () => React,
    has: (name) => registrations.some((r) => r.name === name),
    count: (name) => registrations.filter((r) => r.name === name).length,
    setDock: (d) => { win.__dshAppDock__ = d },
    fireReady: () => { for (const fn of [...(listeners.get('dsh-app-dock:ready') || [])]) fn() },
    runTimers: () => { for (const t of timers.splice(0, timers.length)) t.fn() },
    dockCalls,
  };
}

console.log('\n[verify] L2c client entry arbitration');

{
  const c = bootClient({});
  c.apply();
  truthy('workbench overlay registered regardless of dock', c.has('shell.overlay'));
  truthy('no footer entry claimed during the grace period', !c.has('sidebar.footer.action'));
  c.runTimers();
  truthy('dock absent → self-owned footer entry appears', c.has('sidebar.footer.action'));
  eq('no dock registration was attempted', c.dockCalls.length, 0);
}

{
  // Practices live in the plugin's own host-side store, not in DSH sessions, so
  // the client half must not hard-depend on the workspace/session services —
  // on 0.2.x an unresolvable inject can block the client half from loading.
  // `connection` went too: every call is a plain fetch to the host route
  // (createApi takes no service), so declaring it was a dependency nothing used.
  const c = bootClient({});
  eq('client inject declares only what it reads', c.exports().inject, ['slots']);
}

{
  const dock = fakeDock(null);
  const c = bootClient({ dock });
  c.apply();
  c.runTimers();
  eq('dock present → registered exactly once', dock.calls.length, 1);
  eq('dock registration id', dock.calls[0].id, 'dsh-ielts-writing-examiner');
  truthy('dock registration carries a toggle', typeof dock.calls[0].onToggle === 'function');
  truthy('dock present → footer slot left to the dock', !c.has('sidebar.footer.action'));
}

{
  const c = bootClient({});
  c.apply();
  c.runTimers();
  truthy('footer entry held before the dock shows up', c.has('sidebar.footer.action'));
  const late = fakeDock(null);
  c.setDock(late);
  c.fireReady();
  eq('late dock completes the registration', late.calls.length, 1);
  truthy('late dock withdraws the self-owned entry (no double entry)', !c.has('sidebar.footer.action'));
}

{
  // HMR re-runs apply() against the same window. Only the newest generation's
  // timer may act, otherwise a stale closure races the live one for the slot.
  const c = bootClient({});
  c.apply();
  c.apply();
  c.runTimers();
  eq('re-apply claims the footer exactly once', c.count('sidebar.footer.action'), 1);
}

{
  // The dock owns a cluster-wide zh/en preference; the footer copy must follow
  // it, otherwise our button reads in a different language than its neighbours
  // in the same icon grid.
  const dock = fakeDock({ value: 'zh' });
  const c = bootClient({ dock });
  c.apply();
  eq('footer copy starts on the dock language', c.win.__iwLang.get(), 'zh');
  dock.lang.set('en'); // exactly what the dock's own 语言/EN buttons do
  eq('dock language switch reaches the footer copy', c.win.__iwLang.get(), 'en');
}

{
  // The dock and the host locale can disagree — e.g. the host is Chinese while
  // the cluster preference is already English. Registration must adopt the
  // dock's *current* value, not merely react to later changes.
  const dock = fakeDock({ value: 'en' });
  const c = bootClient({ dock, locale: fakeLocale('zh') });
  c.apply();
  eq('dock language adopted at registration, not only on change', c.win.__iwLang.get(), 'en');
}

{
  // Harness 0.2.x replaced the ctx.get('lang') getter with a LocaleRuntime
  // service. If this regressed, an English host would silently show zh footer.
  const locale = fakeLocale('en');
  const c = bootClient({});
  const store = c.testApi().createLangStore({ get: (k) => (k === 'locale' ? locale : undefined) });
  eq('0.2.x locale service drives the footer language', store.get(), 'en');
  const seen = [];
  store.subscribe((v) => seen.push(v));
  locale.emit('zh');
  eq('locale switch propagates to subscribers', seen, ['zh']);
  eq('store reflects the switched locale', store.get(), 'zh');
}

{
  const legacy = { get: (k) => (k === 'lang' ? () => 'en' : undefined) };
  const c = bootClient({});
  const store = c.testApi().createLangStore(legacy);
  eq('legacy ctx.get("lang") hook still honoured', store.get(), 'en');
}

{
  const c = bootClient({});
  const store = c.testApi().createLangStore({ get: () => undefined });
  eq('no locale service at all falls back to zh', store.get(), 'zh');
}

console.log('\n[verify] L2d client picker contract');
{
  // The question picker builds its options with non-selectable group headers
  // ("── Task 1 ──"). iwSelect used to drop `disabled`, which turned those
  // headers into real choices: picking one set an id matching no question, and
  // a bank that failed to load looked identical to a healthy one.
  const c = bootClient({});
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat() });
  const { iwSelect } = c.testApi().createComponents(h);
  const node = iwSelect({
    value: '',
    onChange: () => {},
    placeholder: '—— pick ——',
    options: [
      { value: 'g1', label: '── Task 1 ──', disabled: true },
      { value: 'writing-task-1-Academy/纽约人口变化', label: '【表格】纽约人口变化' },
      { value: 'g2', label: '── Task 2 ──', disabled: true },
      { value: 'writing-task-2/社会', label: '社会' },
    ],
  });
  const options = node.children.filter((n) => n && n.type === 'option');
  eq('placeholder + every option rendered', options.length, 5);
  // options[0] is the placeholder; normalise "prop absent" to false.
  eq('group headers are non-selectable, questions are not',
    options.slice(1).map((o) => o.props.disabled === true), [true, false, true, false]);
  eq('group header keeps its label', options[1].children[0], '── Task 1 ──');
}

// ════════════════════════════════════════════════════════════════════
// 1.3.0 — bottom chat box (host + client)
// ════════════════════════════════════════════════════════════════════
//
// The chat feature spans a streaming HTTP route, a persisted per-session
// transcript, a prompt builder and a stateless client dock. The sections below
// gate each seam. They live in verify.mjs (not a separate runner) so a broken
// feature fails `npm run verify` exactly like any other regression.

/** Run a whole test section without letting one missing module abort the run. */
async function sectionRun(name, fn) {
  try {
    await fn();
  } catch (e) {
    fail(`${name} section crashed`, e?.stack || e?.message || String(e));
  }
}

/** Parse an SSE body into the JSON objects carried by its `data:` lines. */
function parseSseBody(body) {
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '');
  const events = [];
  for (const frame of text.split('\n\n')) {
    for (const rawLine of frame.split('\n')) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try { events.push(JSON.parse(payload)); } catch { events.push({ _raw: payload }); }
    }
  }
  return events;
}

function utf8ReadableStream(parts) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(enc.encode(part));
      controller.close();
    },
  });
}

/** A Response-like whose body is a ReadableStream of pre-split SSE chunks. */
function streamingFetch(parts) {
  const text = parts.join('');
  return () => Promise.resolve({
    ok: true,
    status: 200,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'text/event-stream; charset=utf-8' : null) },
    body: utf8ReadableStream(parts),
    text: async () => text,
    json: async () => ({}),
  });
}

// ── fake-h toolkit (client render tests) ─────────────────────────────
function hEl(type, props, ...children) {
  const flat = [];
  for (const child of children) {
    if (Array.isArray(child)) flat.push(...child);
    else flat.push(child);
  }
  return { type, props: props || {}, children: flat };
}
function walkTree(node, fn) {
  if (!node || typeof node !== 'object') return;
  fn(node);
  for (const child of node.children || []) walkTree(child, fn);
}
function findAll(tree, pred) {
  const out = [];
  walkTree(tree, (n) => { if (pred(n)) out.push(n); });
  return out;
}
function nodeText(node) {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  return (node.children || []).map(nodeText).join('');
}
function hasCls(node, cls) {
  const value = node?.props?.className;
  return typeof value === 'string' && value.split(/\s+/).includes(cls);
}
function byCls(cls) { return (n) => hasCls(n, cls); }
function buttonsIn(tree) { return findAll(tree, (n) => n.type === 'button'); }
function buttonText(tree, label) {
  return buttonsIn(tree).find((b) => nodeText(b).trim() === String(label).trim());
}

const CHAT_CONTEXT_FIXTURE = {
  surface: 'result',
  question: {
    title: 'Task 2 · 社会 · 免费公共交通',
    body: 'Some people believe that free public transport should be provided in cities. To what extent do you agree?',
    task: '2',
    type: 'Opinion',
  },
  essay: 'Modern cities face traffic congestion, and many commuters rely on private cars every day.',
  result: {
    overallBand: 6.5,
    criteriaScores: {
      taskResponse: { score: 6.5, note: 'task is addressed but examples are thin' },
      coherenceCohesion: { score: 6.5, note: 'paragraphing is clear' },
      lexicalResource: { score: 6, note: 'vocabulary is adequate' },
      grammaticalRange: { score: 6.5, note: 'some complex structures' },
    },
    overallComment: 'The essay addresses the task with a clear position but would benefit from fuller examples.',
    grammarFixes: [{ phrase: 'a lot of cars', suggestion: 'a large number of cars', reason: 'register' }],
    vocabularyDiversity: [{ phrase: 'good', comment: 'basic word choice', alternatives: ['beneficial', 'effective'] }],
    strategy: '让步 + 反驳',
    keyPoints: ['公共交通', '环境'],
  },
};

// ── 15. chat-prompt ──────────────────────────────────────────────────
console.log('\n[verify] chat-prompt');
await sectionRun('chat-prompt', async () => {
  const prompt = await import('./src/host/chat-prompt.js');
  const {
    buildChatSystemPrompt, buildChatMessages, attachAssistantSources,
    sanitizeKey, sanitizeUserText, sanitizeQuotes, sanitizeHistory, sanitizeContext,
    CHAT_LIMITS,
  } = prompt;

  truthy('CHAT_LIMITS exposes the prompt caps',
    CHAT_LIMITS && CHAT_LIMITS.questionBody === 4000 && CHAT_LIMITS.essay === 8000 &&
    CHAT_LIMITS.quote === 1000 && CHAT_LIMITS.historyMessages === 24);

  // ── system prompt: context in, quotes out ──
  const sysZh = buildChatSystemPrompt({ lang: 'zh', context: CHAT_CONTEXT_FIXTURE });
  truthy('zh prompt is a substantial string', typeof sysZh === 'string' && sysZh.length > 500);
  truthy('zh prompt names the current screen', sysZh.includes('作文批改结果页'));
  truthy('zh prompt carries the question title', sysZh.includes(CHAT_CONTEXT_FIXTURE.question.title));
  truthy('zh prompt carries the question body', sysZh.includes('free public transport should be provided'));
  truthy('zh prompt carries task + type metadata', /Task 2/.test(sysZh) && sysZh.includes('Opinion'));
  truthy('zh prompt carries the essay', sysZh.includes('traffic congestion'));
  truthy('zh prompt carries the overall band', sysZh.includes('6.5'));
  truthy('zh prompt carries the correction comment', sysZh.includes('would benefit from fuller examples'));
  truthy('zh prompt carries criteria reasons', sysZh.includes('paragraphing is clear'));
  truthy('zh prompt carries grammar fixes', sysZh.includes('a large number of cars'));
  truthy('zh prompt carries vocabulary suggestions', sysZh.includes('basic word choice'));
  truthy('zh prompt carries strategy + key points', sysZh.includes('让步 + 反驳') && sysZh.includes('公共交通'));
  truthy('zh prompt instructs Chinese-default answers', sysZh.includes('默认中文'));

  const sysEn = buildChatSystemPrompt({ lang: 'en', context: CHAT_CONTEXT_FIXTURE });
  truthy('en prompt is English', sysEn.includes('IELTS writing examiner') && sysEn.includes('Current screen:'));
  truthy('en prompt instructs English-default answers', sysEn.includes('default English'));
  truthy('zh and en prompts differ', sysZh !== sysEn);

  // Quotes are NOT part of the system prompt; they travel in the user message.
  truthy('quotes do not leak into the system prompt', !sysZh.includes('【引用'));

  truthy('missing context does not crash', typeof buildChatSystemPrompt() === 'string' && buildChatSystemPrompt().length > 100);
  truthy('unknown surface falls back without crashing',
    buildChatSystemPrompt({ context: { surface: 'nope' } }).includes('新练习页'));

  // ── caps ──
  const longQ = buildChatSystemPrompt({
    context: { surface: 'new', question: { title: 'T', body: 'Q'.repeat(CHAT_LIMITS.questionBody + 500) } },
  });
  truthy('question body capped',
    longQ.includes('Q'.repeat(CHAT_LIMITS.questionBody)) && !longQ.includes('Q'.repeat(CHAT_LIMITS.questionBody + 1)));
  const longE = buildChatSystemPrompt({ context: { surface: 'writing', essay: 'E'.repeat(CHAT_LIMITS.essay + 500) } });
  truthy('essay capped',
    longE.includes('E'.repeat(CHAT_LIMITS.essay)) && !longE.includes('E'.repeat(CHAT_LIMITS.essay + 1)));

  const longHistory = Array.from({ length: CHAT_LIMITS.historyMessages + 12 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: `turn ${i}`,
  }));
  const cappedHistory = sanitizeHistory(longHistory);
  eq('history capped to the contract turn count', cappedHistory.length, CHAT_LIMITS.historyMessages);
  eq('history keeps the newest turns', cappedHistory[cappedHistory.length - 1].content, `turn ${CHAT_LIMITS.historyMessages + 11}`);
  eq('history drops unknown roles',
    sanitizeHistory([{ role: 'system', content: 'x' }, { role: 'user', content: 'ok' }]).map((m) => m.role), ['user']);
  const longTurn = sanitizeHistory([{ role: 'user', content: 'X'.repeat(CHAT_LIMITS.historyContent + 500) }]);
  truthy('history content capped', longTurn[0].content.length <= CHAT_LIMITS.historyContent + 1);

  eq('quotes capped to three', sanitizeQuotes(['a', 'b', 'c', 'd']), ['a', 'b', 'c']);
  truthy('a quote is capped', sanitizeQuotes(['Z'.repeat(CHAT_LIMITS.quote + 500)])[0].length <= CHAT_LIMITS.quote + 1);
  eq('quotes collapse whitespace', sanitizeQuotes(['  spaced \n out  ']), ['spaced out']);
  eq('quotes dedupe', sanitizeQuotes(['same', 'same']), ['same']);

  let keyErr = null;
  try { sanitizeKey('../etc/passwd'); } catch (e) { keyErr = e; }
  truthy('traversal key rejected', !!keyErr);
  let keyErr2 = null;
  try { sanitizeKey('Draft'); } catch (e) { keyErr2 = e; }
  truthy('non-lowercase key rejected', !!keyErr2);
  eq('draft key accepted', sanitizeKey('draft'), 'draft');
  eq('session-id key accepted', sanitizeKey('abcdef123456'), 'abcdef123456');

  let textErr = null;
  try { sanitizeUserText('   '); } catch (e) { textErr = e; }
  truthy('empty text rejected', !!textErr);
  let textErr2 = null;
  try { sanitizeUserText('x'.repeat(CHAT_LIMITS.text + 1)); } catch (e) { textErr2 = e; }
  truthy('oversized text rejected', !!textErr2);
  eq('text is trimmed', sanitizeUserText('  hello  '), 'hello');

  const ctx = sanitizeContext(CHAT_CONTEXT_FIXTURE);
  eq('context question normalized', ctx.question, CHAT_CONTEXT_FIXTURE.question);
  eq('context result lifted', [ctx.result.overallBand, ctx.result.criteriaScores.taskResponse.score], [6.5, 6.5]);
  eq('context essay preserved', ctx.essay, CHAT_CONTEXT_FIXTURE.essay);
  eq('invalid surface normalizes to new', sanitizeContext({ surface: 'bogus' }).surface, 'new');
  eq('missing context normalizes', sanitizeContext(undefined), { surface: 'new', question: null, essay: '', result: null });

  // ── provider-neutral messages + quote path ──
  const messages = buildChatMessages({
    history: [
      { role: 'user', content: 'Earlier question', quotes: ['earlier quote'] },
      { role: 'assistant', content: 'Earlier answer' },
    ],
    text: 'Why did I lose marks here?',
    quotes: ['free public transport'],
    lang: 'zh',
  });
  eq('message count = history + new turn', messages.length, 3);
  eq('final message is the new user turn', messages.at(-1).role, 'user');
  truthy('messages are block arrays', Array.isArray(messages[0].content) && messages[0].content[0].type === 'text');
  const lastUserText = messages.at(-1).content.map((b) => b.text).join('\n');
  truthy('new quotes render as 【引用 1】', lastUserText.includes('【引用 1】') && lastUserText.includes('free public transport'));
  truthy('the actual question follows 【我的问题】',
    lastUserText.includes('【我的问题】') && lastUserText.includes('Why did I lose marks here?'));
  const historyUserText = messages[0].content.map((b) => b.text).join('\n');
  truthy('history user quotes keep their quote prefix', historyUserText.includes('【引用 1】') && historyUserText.includes('earlier quote'));
  const enMessages = buildChatMessages({ text: 'hello', lang: 'en' });
  truthy('en quote/question markers',
    enMessages.at(-1).content[0].text.includes('[My question]'));

  const tagged = attachAssistantSources(
    [{ role: 'user', content: [{ type: 'text', text: 'u' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'b' }] }],
    'minimax-cn', 'MiniMax-M3.1-Flash-Preview');
  eq('assistant messages tagged with model source',
    [tagged[1].source, tagged[2].source],
    [{ kind: 'model', provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash-Preview' },
      { kind: 'model', provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash-Preview' }]);
  eq('user messages never tagged', 'source' in tagged[0], false);
});

// ── 16. chat-store ───────────────────────────────────────────────────
console.log('\n[verify] chat-store');
await sectionRun('chat-store', async () => {
  const { createChatStore, assertChatKey, sanitizeChatMessages } = await import('./src/host/chat-store.js');
  const root = join(DATA_ROOT, 'chat-store-test');
  const store = createChatStore(root);
  const CHATS = join(root, 'chats');

  const seed = [
    { role: 'user', content: 'hello', quotes: ['quote one'], ts: 1700000000000 },
    { role: 'assistant', content: 'hi there', ts: 1700000000001 },
  ];
  const saved = store.save('draft', seed);
  eq('save returns the key', saved.key, 'draft');
  eq('save round-trips the transcript', store.get('draft').messages, seed);
  truthy('transcript persisted under chats/<key>.json', existsSync(join(CHATS, 'draft.json')));

  eq('missing thread reads as empty', store.get('never-saved').messages, []);
  writeFileSync(join(CHATS, 'corrupt.json'), '{ not json', 'utf8');
  eq('corrupt transcript reads as empty', store.get('corrupt').messages, []);

  // ── key sanitization ──
  let badKey = null;
  try { assertChatKey('../escape'); } catch (e) { badKey = e; }
  truthy('assertChatKey rejects traversal', !!badKey);
  let badSave = null;
  try { store.save('Bad Key', seed); } catch (e) { badSave = e; }
  truthy('save rejects bad keys', !!badSave);
  truthy('bad key wrote no file', !readdirSync(CHATS).some((f) => f.toLowerCase().includes('bad')));
  let badGet = null;
  try { store.get('../../etc/passwd'); } catch (e) { badGet = e; }
  truthy('get rejects traversal keys', !!badGet);

  // ── message sanitation ──
  const clean = sanitizeChatMessages([
    { role: 'system', content: 'drop me' },
    { role: 'user', content: '   ' },
    { role: 'assistant', content: 'kept answer' },
    { role: 'user', content: 'with quotes', quotes: ['  one ', 'two', 'three', 'four'] },
    { role: 'user', content: 'bad ts', ts: 'not-a-number' },
    { role: 'user', content: 'good ts', ts: 123 },
  ]);
  eq('invalid turns dropped', clean.map((m) => m.content), ['kept answer', 'with quotes', 'bad ts', 'good ts']);
  eq('user quotes cleaned + capped', clean[1].quotes, ['one', 'two', 'three']);
  eq('bad ts dropped', 'ts' in clean[2], false);
  eq('finite ts preserved', clean[3].ts, 123);
  eq('assistant quotes never kept', 'quotes' in clean[0], false);

  // ── caps ──
  const many = Array.from({ length: 250 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
  store.save('capped', many);
  eq('message count capped at 200', store.get('capped').messages.length, 200);
  eq('cap keeps the newest', store.get('capped').messages.at(-1).content, 'm249');
  store.save('long', [{ role: 'user', content: 'Z'.repeat(25000) }]);
  truthy('content capped at 20000', store.get('long').messages[0].content.length <= 20000);

  // ── migrate: copy, drop provenance, clear source, never clobber a target ──
  store.save('draft', [
    { role: 'user', content: 'draft question' },
    { role: 'assistant', content: 'draft answer', source: { kind: 'model', provider: 'p', model: 'm' } },
  ]);
  eq('migrate copies the draft', store.migrate('draft', 'sess1'), { ok: true, migrated: true });
  eq('migrated transcript readable', store.get('sess1').messages.map((m) => m.content), ['draft question', 'draft answer']);
  truthy('migrate drops transport provenance', !('source' in store.get('sess1').messages[1]));
  truthy('migrate removes the source file', !existsSync(join(CHATS, 'draft.json')));

  store.save('draft', [{ role: 'user', content: 'second draft' }]);
  store.save('target', [{ role: 'user', content: 'keep me' }, { role: 'assistant', content: 'kept' }]);
  eq('migrate no-ops onto a non-empty target', store.migrate('draft', 'target'), { ok: true, migrated: false });
  eq('non-empty target untouched', store.get('target').messages.map((m) => m.content), ['keep me', 'kept']);

  store.remove('draft');
  eq('migrate no-ops when the source is empty', store.migrate('draft', 'sess2'), { ok: true, migrated: false });
  eq('empty-source target stays empty', store.get('sess2').messages, []);

  // ── clear / remove aliases ──
  store.save('todelete', [{ role: 'user', content: 'bye' }]);
  eq('clear returns ok+key', store.clear('todelete'), { ok: true, key: 'todelete' });
  truthy('clear deletes the file', !existsSync(join(CHATS, 'todelete.json')));
  store.save('todelete2', [{ role: 'user', content: 'bye' }]);
  eq('remove is an alias of clear', store.remove('todelete2'), { ok: true, key: 'todelete2' });
  truthy('remove deletes the file', !existsSync(join(CHATS, 'todelete2.json')));

  // ── abandoned per-practice draft threads ──
  // Every "+ new practice" uses draft-<random> so unsaved practices never share
  // a conversation; abandoned ones are pruned at boot. The welcome 'draft'
  // thread is not a per-practice draft and must be kept.
  store.save('draft-abc123', [{ role: 'user', content: 'abandoned practice' }]);
  store.save('draft', [{ role: 'user', content: 'welcome thread' }]);
  eq('pruneDrafts removes only abandoned draft-* threads', store.pruneDrafts(-1), 1);
  truthy('abandoned draft-* thread removed', !existsSync(join(CHATS, 'draft-abc123.json')));
  truthy('welcome-screen draft thread kept', existsSync(join(CHATS, 'draft.json')));
  store.remove('draft');
});

// ── 17. POST /ielts-examiner/chat — SSE happy path ───────────────────
console.log('\n[verify] chat SSE happy path');
await sectionRun('chat SSE happy path', async () => {
  const origPrepare = ctx.llm.prepareCall;
  const origSelection = ctx.agentDefaultModel.currentSelection;
  const origLastOptions = ctx.llm.lastOptions;
  ctx.agentDefaultModel.currentSelection = () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash' });
  const streamed = [];
  const prepareArgs = [];
  ctx.llm.prepareCall = async function (config) {
    prepareArgs.push(config);
    const cfg = { provider: config.provider, model: config.model, temperature: config.temperature };
    return {
      config: cfg,
      stream(options) {
        ctx.llm.lastOptions = options;
        return (async function* () {
          yield { type: 'start' };
          for (const text of ['Hello', ' from', ' the', ' examiner']) {
            streamed.push(text);
            yield { type: 'text-delta', index: 0, text };
          }
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
      },
    };
  };
  try {
    const seenChunks = [];
    const res = await ctx.webServer._dispatch('POST', '/ielts-examiner/chat', JSON.stringify({
      key: 'chatsse',
      lang: 'en',
      text: 'Why was my grammar score low?',
      quotes: ['I think government should'],
      history: [
        { role: 'user', content: 'Previous question', quotes: ['an earlier quote'] },
        { role: 'assistant', content: 'Previous answer' },
      ],
      context: CHAT_CONTEXT_FIXTURE,
    }), { onChunk: (c) => seenChunks.push(String(c)) });

    truthy('chat stream route registered', !!res);
    eq('SSE status is 200', res?.status, 200);
    truthy('SSE content-type', String(res?.headers?.['content-type'] || '').includes('text/event-stream'));
    truthy('route really streams (write() called before end())', seenChunks.length >= 2);

    const events = parseSseBody(res.body);
    const deltas = events.filter((e) => typeof e.delta === 'string');
    eq('delta events arrive in order', deltas.map((e) => e.delta).join(''), 'Hello from the examiner');
    const done = events.find((e) => e.done === true);
    truthy('done event present', !!done);
    eq('done carries the full assistant message content', done?.message?.content, 'Hello from the examiner');
    eq('done message role', done?.message?.role, 'assistant');

    // Dispatch-time contract: the adapters read `source` on assistant history.
    const options = ctx.llm.lastOptions;
    truthy('llm service received dispatch options', !!options);
    truthy('system prompt dispatched', typeof options?.system === 'string' && options.system.includes('free public transport'));
    const dispatched = options?.messages || [];
    const assistants = dispatched.filter((m) => m.role === 'assistant');
    truthy('assistant history dispatched with source', assistants.length > 0);
    eq('source kind/provider/model', assistants.map((m) => m.source),
      assistants.map(() => ({ kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' })));
    eq('user messages dispatched without source', dispatched.filter((m) => m.role === 'user').every((m) => !('source' in m)), true);
    const lastUser = dispatched.filter((m) => m.role === 'user').at(-1);
    const lastUserText = (lastUser?.content || []).map((b) => b.text).join('\n');
    truthy('quoted fragment reaches the model in the final user turn',
      lastUserText.includes('[Quote 1]') && lastUserText.includes('I think government should'));
    truthy('the new question reaches the model',
      lastUserText.includes('[My question]') && lastUserText.includes('Why was my grammar score low?'));
    eq('prepareCall receives only the resolved model tuple',
      Object.keys(prepareArgs[0] || {}).sort(), ['model', 'provider', 'temperature']);

    // Persistence: prior history + user turn + assistant turn.
    const thread = await rpcCall('chat.get', { key: 'chatsse' });
    eq('chat.get returns saved key', thread.key, 'chatsse');
    eq('persisted roles', thread.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
    eq('persisted new user turn', thread.messages[2].content, 'Why was my grammar score low?');
    eq('persisted user quotes', thread.messages[2].quotes, ['I think government should']);
    eq('persisted assistant reply', thread.messages[3].content, 'Hello from the examiner');
    truthy('persisted new turns carry ts', thread.messages.slice(-2).every((m) => typeof m.ts === 'number'));

    // ── failure path: stream dies mid-reply ──
    ctx.llm.prepareCall = async function () {
      return {
        config: { provider: 'deepseek-official', model: 'deepseek-v4-flash', temperature: 0.5 },
        stream() {
          return (async function* () {
            yield { type: 'text-delta', index: 0, text: 'partial' };
            yield { type: 'finish', reason: { kind: 'error', failure: new Error('upstream 429') } };
          })();
        },
      };
    };
    const failRes = await ctx.webServer._dispatch('POST', '/ielts-examiner/chat', JSON.stringify({
      key: 'chatfail',
      lang: 'zh',
      text: '这会失败吗？',
      quotes: [],
      history: [{ role: 'assistant', content: '前一轮回答' }],
      context: { surface: 'result' },
    }));
    eq('failure path still returns 200 once SSE started', failRes?.status, 200);
    const failEvents = parseSseBody(failRes.body);
    truthy('error event present', failEvents.some((e) => typeof e.error === 'string' && e.error.length > 0));
    truthy('no done event on failure', !failEvents.some((e) => e.done === true));
    const failedThread = await rpcCall('chat.get', { key: 'chatfail' });
    eq('failure persists history + user only', failedThread.messages.map((m) => m.role), ['assistant', 'user']);
    eq('failed user turn kept', failedThread.messages[1].content, '这会失败吗？');

    // ── model-prepare failure (before any delta) follows the same contract ──
    ctx.llm.prepareCall = async function () { throw new Error('no model configured'); };
    const prepFail = await ctx.webServer._dispatch('POST', '/ielts-examiner/chat', JSON.stringify({
      key: 'chatprepfail', lang: 'en', text: 'question', quotes: [], history: [], context: { surface: 'new' },
    }));
    eq('prepare failure returns 200 SSE', prepFail?.status, 200);
    const prepEvents = parseSseBody(prepFail.body);
    truthy('prepare failure emits error event',
      prepEvents.some((e) => typeof e.error === 'string' && e.error.includes('no model configured')));
  } finally {
    ctx.llm.prepareCall = origPrepare;
    ctx.agentDefaultModel.currentSelection = origSelection;
    if (origLastOptions === undefined) delete ctx.llm.lastOptions;
    else ctx.llm.lastOptions = origLastOptions;
  }
});

// ── 18. chat route validation + history capping ──────────────────────
console.log('\n[verify] chat SSE validation');
await sectionRun('chat SSE validation', async () => {
  const invalid = [
    ['missing text', { key: 'draft', lang: 'en', quotes: [], history: [], context: { surface: 'new' } }],
    ['empty text', { key: 'draft', lang: 'en', text: '   ', quotes: [], history: [], context: { surface: 'new' } }],
    ['oversized text', { key: 'draft', lang: 'en', text: 'x'.repeat(8001), quotes: [], history: [], context: { surface: 'new' } }],
    ['bad key', { key: '../escape', lang: 'en', text: 'hi', quotes: [], history: [], context: { surface: 'new' } }],
    ['missing key', { lang: 'en', text: 'hi', quotes: [], history: [], context: { surface: 'new' } }],
  ];
  for (const [label, payload] of invalid) {
    const res = await ctx.webServer._dispatch('POST', '/ielts-examiner/chat', JSON.stringify(payload));
    eq(`${label} -> HTTP 400`, res?.status, 400);
    truthy(`${label} -> JSON content-type`, String(res?.headers?.['content-type'] || '').includes('application/json'));
    let body = null;
    try { body = JSON.parse(String(res?.body)); } catch { /* asserted below */ }
    truthy(`${label} -> {ok:false,error.message}`, body?.ok === false && typeof body?.error?.message === 'string');
  }

  const notJson = await ctx.webServer._dispatch('POST', '/ielts-examiner/chat', 'not json at all');
  eq('non-JSON body -> HTTP 400', notJson?.status, 400);

  const getRes = await ctx.webServer._dispatch('GET', '/ielts-examiner/chat', '');
  eq('GET -> HTTP 405', getRes?.status, 405);

  // >24 history turns is silently capped, not an error.
  const origPrepare = ctx.llm.prepareCall;
  const origSelection = ctx.agentDefaultModel.currentSelection;
  ctx.agentDefaultModel.currentSelection = () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash' });
  ctx.llm.prepareCall = async function () {
    return {
      config: { provider: 'deepseek-official', model: 'deepseek-v4-flash', temperature: 0.5 },
      stream(options) {
        ctx.llm.lastOptions = options;
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: 'ok' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
      },
    };
  };
  try {
    const history = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: `history turn ${i}`,
    }));
    const res = await ctx.webServer._dispatch('POST', '/ielts-examiner/chat', JSON.stringify({
      key: 'caphistory', lang: 'en', text: 'last question', quotes: [], history, context: { surface: 'writing' },
    }));
    eq('long history is accepted (capped, not rejected)', res?.status, 200);
    const events = parseSseBody(res.body);
    truthy('long history stream completes', events.some((e) => e.done === true));
    const dispatched = ctx.llm.lastOptions?.messages || [];
    truthy('history is capped before dispatch',
      dispatched.filter((m) => m.role === 'user' || m.role === 'assistant').length <= 26);
  } finally {
    ctx.llm.prepareCall = origPrepare;
    ctx.agentDefaultModel.currentSelection = origSelection;
    delete ctx.llm.lastOptions;
  }
});

// ── 19. chat RPCs + session.delete housekeeping ──────────────────────
console.log('\n[verify] chat RPCs');
await sectionRun('chat RPCs', async () => {
  const { createChatStore } = await import('./src/host/chat-store.js');
  const store = createChatStore(DATA_ROOT);

  store.save('rpcseed', [{ role: 'user', content: 'seeded question', quotes: ['seeded quote'], ts: 1 }]);
  const got = await rpcCall('chat.get', { key: 'rpcseed' });
  eq('chat.get returns the saved thread', got.messages[0].content, 'seeded question');
  eq('chat.get keeps user quotes', got.messages[0].quotes, ['seeded quote']);

  eq('chat.clear returns ok', await rpcCall('chat.clear', { key: 'rpcseed' }), { ok: true, key: 'rpcseed' });
  truthy('chat.clear removed the file', !existsSync(join(DATA_ROOT, 'chats', 'rpcseed.json')));

  let badKeyErr = null;
  try { await rpcCall('chat.get', { key: '../escape' }); } catch (e) { badKeyErr = e; }
  truthy('chat.get rejects a bad key through the RPC envelope', !!badKeyErr);

  store.save('draft', [{ role: 'user', content: 'draft message' }]);
  eq('chat.migrate returns migrated:true', await rpcCall('chat.migrate', { from: 'draft', to: 'migrated1' }),
    { ok: true, migrated: true });
  eq('migrated thread readable over RPC', (await rpcCall('chat.get', { key: 'migrated1' })).messages[0].content, 'draft message');
  truthy('migrate cleared the draft file', !existsSync(join(DATA_ROOT, 'chats', 'draft.json')));
  eq('chat.migrate no-ops onto a non-empty target',
    await rpcCall('chat.migrate', { from: 'draft', to: 'migrated1' }), { ok: true, migrated: false });

  // session.delete must not leave an orphaned chat file behind.
  const { id: doomed } = await rpcCall('session.create', { questionId: firstQ.id });
  store.save(doomed, [{ role: 'user', content: 'belongs to the practice' }]);
  truthy('chat file seeded for the session', existsSync(join(DATA_ROOT, 'chats', `${doomed}.json`)));
  await rpcCall('session.delete', { id: doomed });
  truthy('session.delete removes the chat file', !existsSync(join(DATA_ROOT, 'chats', `${doomed}.json`)));
});

// ── 20. client chat helpers (createChat pure functions) ──────────────
console.log('\n[verify] client chat helpers');
await sectionRun('client chat helpers', async () => {
  const c = bootClient({});
  const testApi = c.testApi();
  const components = testApi.createComponents(hEl);
  const chat = testApi.createChat(c.react(), hEl, components);
  truthy('createChat is exposed on _test', !!chat && typeof chat.ChatDock === 'function');

  // normalizeQuote
  eq('normalizeQuote collapses whitespace', chat.normalizeQuote('  hello \n\t  world  '), 'hello world');
  eq('normalizeQuote of blank is empty', chat.normalizeQuote('   '), '');
  truthy('normalizeQuote caps at 1000', chat.normalizeQuote('x'.repeat(1500)).length <= 1000);

  // mergeQuotes
  eq('mergeQuotes ignores an empty addition', chat.mergeQuotes(['a'], '   '), ['a']);
  eq('mergeQuotes dedupes an exact copy', chat.mergeQuotes(['a', 'b'], 'a'), ['a', 'b']);
  const merged = chat.mergeQuotes(['a', 'b'], 'c');
  truthy('mergeQuotes appends', merged.includes('c') && merged.length >= 2);
  eq('mergeQuotes keeps only three', chat.mergeQuotes(['a', 'b', 'c'], 'd').length, 3);

  // buildChatContext
  const baseArgs = { view: 'new', active: null, question: null, essay: '' };
  eq('surface empty view', chat.buildChatContext({ ...baseArgs, view: 'empty' }).surface, 'empty');
  eq('surface boot view maps to empty', chat.buildChatContext({ ...baseArgs, view: 'boot' }).surface, 'empty');
  eq('surface new practice without an essay', chat.buildChatContext({ ...baseArgs, view: 'new' }).surface, 'new');
  eq('surface writing when an essay is present', chat.buildChatContext({ ...baseArgs, view: 'new', essay: 'draft' }).surface, 'writing');
  eq('surface loading', chat.buildChatContext({ ...baseArgs, view: 'loading' }).surface, 'loading');
  eq('surface failed', chat.buildChatContext({ ...baseArgs, view: 'failed' }).surface, 'failed');

  const context = chat.buildChatContext({
    view: 'result',
    active: {
      id: 'abcdef123456',
      questionId: 'writing-task-2/社会',
      status: 'done',
      result: {
        correction: {
          overallBand: 6.5,
          criteriaScores: { taskResponse: { score: 6.5, note: 'thin examples' } },
          overallComment: 'Clear position, thin examples.',
          grammarFixes: [{ phrase: 'a lot of', suggestion: 'many', reason: 'register' }],
          vocabularyDiversity: [{ phrase: 'good', comment: 'basic', alternatives: ['beneficial'] }],
        },
        analysis: { strategy: '让步+反驳', keyPoints: ['公共交通'] },
      },
    },
    question: { title: 'Q title', body: 'Q body', task: '2', type: 'Opinion' },
    essay: 'An essay.',
  });
  eq('surface result', context.surface, 'result');
  eq('question mapped', context.question, { title: 'Q title', body: 'Q body', task: '2', type: 'Opinion' });
  eq('essay mapped', context.essay, 'An essay.');
  eq('result.band lifted from correction', context.result?.overallBand, 6.5);
  eq('result.criteriaScores lifted', context.result?.criteriaScores?.taskResponse?.score, 6.5);
  eq('result.overallComment lifted', context.result?.overallComment, 'Clear position, thin examples.');
  eq('result.strategy lifted from analysis', context.result?.strategy, '让步+反驳');
  eq('result.keyPoints lifted', context.result?.keyPoints, ['公共交通']);
  truthy('result.grammarFixes lifted', Array.isArray(context.result?.grammarFixes) && context.result.grammarFixes.length === 1);
  truthy('result.vocabularyDiversity lifted',
    Array.isArray(context.result?.vocabularyDiversity) && context.result.vocabularyDiversity.length === 1);

  // messagesForRequest
  eq('messagesForRequest drops ts, keeps quotes',
    chat.messagesForRequest([
      { role: 'user', content: 'q', quotes: ['x'], ts: 1 },
      { role: 'assistant', content: 'a', ts: 2 },
    ]),
    [{ role: 'user', content: 'q', quotes: ['x'] }, { role: 'assistant', content: 'a' }]);
  const wireHistory = chat.messagesForRequest(
    Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `t${i}`, ts: i })));
  eq('messagesForRequest caps history at 24', wireHistory.length, 24);
  eq('messagesForRequest keeps the newest turns', wireHistory.at(-1).content, 't29');
  truthy('messagesForRequest caps content',
    chat.messagesForRequest([{ role: 'user', content: 'X'.repeat(9000) }])[0].content.length <= 6000);
  const quoteWire = chat.messagesForRequest([{
    role: 'user', content: 'q',
    quotes: ['q'.repeat(1500), 'r'.repeat(1500), 's'.repeat(1500), 'fourth'],
  }]);
  eq('messagesForRequest caps quotes to 3', quoteWire[0].quotes.length, 3);
  truthy('messagesForRequest caps each quote at 1000 chars',
    quoteWire[0].quotes.every((q) => typeof q === 'string' && q.length <= 1000));

  // client-side caps (the host caps again; the client must not inflate bodies)
  const cappedContext = chat.buildChatContext({
    view: 'new', active: null,
    question: { title: 't', body: 'B'.repeat(12000), task: '2', type: 'Opinion' },
    essay: 'E'.repeat(12000),
  });
  truthy('client caps the question body', cappedContext.question.body.length <= 4000);
  truthy('client caps the essay', cappedContext.essay.length <= 8000);

  // parseSseEvents
  const p1 = chat.parseSseEvents('data: {"delta":"he"}\n\ndata: {"del');
  eq('parses complete frames', p1.events, [{ delta: 'he' }]);
  eq('keeps the partial trailing frame', p1.rest, 'data: {"del');
  const p2 = chat.parseSseEvents(p1.rest + 'ta":"llo"}\n\n');
  eq('parses a frame split across chunks', p2.events, [{ delta: 'llo' }]);
  eq('rest is consumed', p2.rest, '');
  const p3 = chat.parseSseEvents(': ping\n\ndata: {"done":true}\n\n');
  eq('ignores SSE comments', p3.events, [{ done: true }]);
  const p4 = chat.parseSseEvents('event: x\ndata: {"error":"bad"}\n\ndata: {"weird":1}\n\n');
  eq('keeps error events', p4.events[0], { error: 'bad' });
  eq('keeps unknown events', p4.events[1], { weird: 1 });
});

// ── 21. client ChatDock render contract ──────────────────────────────
console.log('\n[verify] client ChatDock');
await sectionRun('client ChatDock', async () => {
  const { t } = await import('./src/client/strings.js');
  const Tzh = t('zh');
  const Ten = t('en');
  const i18nKeys = ['chatTitle', 'chatHint', 'chatPlaceholder', 'chatSend', 'chatStop', 'chatThinking',
    'chatEmpty', 'chatQuotesLabel', 'chatQuotesClear', 'chatQuoteRemove', 'chatClear',
    'chatClearConfirm', 'chatExpand', 'chatCollapse'];
  for (const key of i18nKeys) {
    truthy(`i18n ${key} exists in zh+en`, typeof Tzh[key] === 'string' && typeof Ten[key] === 'string');
  }
  truthy('chatError is a formatter in zh+en', typeof Tzh.chatError === 'function' && typeof Ten.chatError === 'function');
  truthy('no sample-question example copy', !/示例问题|sample question/i.test(JSON.stringify(Tzh) + JSON.stringify(Ten)));

  const c = bootClient({});
  const testApi = c.testApi();
  const h = hEl;
  const components = testApi.createComponents(h);
  const { ChatDock } = testApi.createChat(c.react(), h, components);

  const baseProps = {
    lang: 'zh', messages: [], quotes: [], draft: '', streaming: false, error: null, expanded: true,
    onDraftChange: () => {}, onSend: () => {}, onStop: () => {}, onToggleExpanded: () => {},
    onRemoveQuote: () => {}, onClearQuotes: () => {}, onClearThread: () => {},
  };
  const render = (overrides = {}) => ChatDock({ ...baseProps, ...overrides });

  // empty state
  const empty = render();
  eq('root carries .iw-chat', hasCls(empty, 'iw-chat'), true);
  eq('expanded root carries .open', hasCls(empty, 'open'), true);
  truthy('header title rendered', nodeText(findAll(empty, byCls('iw-chat-head-title'))[0]).trim().length > 0);
  truthy('header hint rendered', nodeText(findAll(empty, byCls('iw-chat-head-hint'))[0]).trim().length > 0);
  eq('log only when expanded', findAll(empty, byCls('iw-chat-log')).length, 1);
  eq('empty log shows .iw-chat-empty', findAll(empty, byCls('iw-chat-empty')).length, 1);
  eq('no messages rendered', findAll(empty, byCls('iw-chat-msg')).length, 0);
  eq('no clear button without messages', !!buttonText(empty, Tzh.chatClear), false);
  eq('send button disabled when draft is empty',
    buttonText(empty, Tzh.chatSend)?.props?.disabled, true);
  eq('no stop button while idle', !!buttonText(empty, Tzh.chatStop), false);
  eq('no quotes bar when no quotes', findAll(empty, byCls('iw-chat-quotes')).length, 0);
  truthy('input row always rendered', findAll(empty, byCls('iw-chat-input')).length === 1);

  // collapsed dock keeps the input + quotes, hides the log
  const collapsed = render({ expanded: false, quotes: ['a quote'] });
  eq('collapsed hides the log', findAll(collapsed, byCls('iw-chat-log')).length, 0);
  truthy('collapsed keeps the input', findAll(collapsed, byCls('iw-chat-input')).length === 1);
  truthy('collapsed still shows quote chips', findAll(collapsed, byCls('iw-chat-quote-chip')).length === 1);
  eq('collapsed root has no .open', hasCls(collapsed, 'iw-chat'), true);

  // quote chips
  const quoted = render({ quotes: ['first quoted sentence', 'second quoted sentence'] });
  const chips = findAll(quoted, byCls('iw-chat-quote-chip'));
  eq('one chip per quote', chips.length, 2);
  truthy('quotes label rendered', nodeText(findAll(quoted, byCls('iw-chat-quotes-label'))[0]).length > 0);
  eq('chip exposes the full quote in its title', chips[0].props.title, 'first quoted sentence');
  truthy('chip text element exists', findAll(chips[0], byCls('iw-chat-quote-text')).length === 1);
  const removeBtn = findAll(chips[0], byCls('iw-chat-quote-x'))[0];
  truthy('chip has a remove button', !!removeBtn && removeBtn.type === 'button');
  eq('remove button is labelled', removeBtn?.props?.title, Tzh.chatQuoteRemove);
  eq('remove button aria-label matches', removeBtn?.props?.['aria-label'], Tzh.chatQuoteRemove);
  eq('clear-quotes button rendered', !!buttonText(quoted, Tzh.chatQuotesClear), true);

  // message bubbles
  const withMessages = render({
    messages: [
      { role: 'user', content: 'What does this mean?', quotes: ['the quoted sentence'], ts: 1 },
      { role: 'assistant', content: '**Bold** point and `code`.', ts: 2 },
    ],
  });
  const bubbles = findAll(withMessages, byCls('iw-chat-msg'));
  eq('one bubble per message', bubbles.length, 2);
  const userBubble = bubbles.find((b) => hasCls(b, 'user'));
  const assistantBubble = bubbles.find((b) => hasCls(b, 'assistant'));
  truthy('user bubble exists', !!userBubble);
  truthy('assistant bubble exists', !!assistantBubble);
  eq('user message quote rendered as blockquote',
    findAll(userBubble, (n) => n.type === 'blockquote' && hasCls(n, 'iw-chat-quote')).length, 1);
  truthy('user message shows its text', nodeText(userBubble).includes('What does this mean?'));
  const md = findAll(assistantBubble, byCls('iw-md'))[0];
  const mdHtml = String(md?.props?.dangerouslySetInnerHTML?.__html || '');
  truthy('assistant content rendered as markdown HTML', mdHtml.includes('<strong>Bold</strong>'));
  eq('clear-thread button appears once there are messages', !!buttonText(withMessages, Tzh.chatClear), true);

  // streaming + send/stop states
  const streaming = render({
    messages: [{ role: 'user', content: 'q', ts: 1 }, { role: 'assistant', content: 'partial', ts: 2 }],
    streaming: true,
  });
  const streamingBubble = findAll(streaming, byCls('iw-chat-msg')).find((n) => hasCls(n, 'assistant'));
  truthy('streaming assistant bubble marked', hasCls(streamingBubble, 'streaming'));
  truthy('thinking indicator rendered', findAll(streaming, byCls('iw-chat-thinking')).length === 1);
  eq('stop button appears while streaming', !!buttonText(streaming, Tzh.chatStop), true);
  eq('send button disabled while streaming',
    buttonText(streaming, Tzh.chatSend)?.props?.disabled, true);
  eq('send enabled with a non-empty draft',
    buttonText(render({ draft: 'hello' }), Tzh.chatSend)?.props?.disabled, false);

  // error banner
  const errored = render({ error: 'boom' });
  eq('error banner rendered', findAll(errored, byCls('iw-error')).length, 1);
  truthy('error banner shows the localised message', nodeText(errored).includes(Tzh.chatError('boom')));

  // ── interaction wiring (all state lives in Root; the dock only calls props) ──
  const calls = { drafted: null, sent: 0, stopped: 0, cleared: 0, removed: -1, clearedQuotes: 0, toggled: 0 };
  const interactive = render({
    draft: 'hi',
    messages: [{ role: 'user', content: 'q', ts: 1 }],
    quotes: ['a', 'b'],
    streaming: true,
    onDraftChange: (v) => { calls.drafted = v; },
    onSend: () => { calls.sent++; },
    onStop: () => { calls.stopped++; },
    onClearThread: () => { calls.cleared++; },
    onRemoveQuote: (i) => { calls.removed = i; },
    onClearQuotes: () => { calls.clearedQuotes++; },
    onToggleExpanded: () => { calls.toggled++; },
  });
  findAll(interactive, byCls('iw-chat-input'))[0].props.onChange({ target: { value: 'typed' } });
  eq('input change calls onDraftChange', calls.drafted, 'typed');
  buttonText(interactive, Tzh.chatSend).props.onClick();
  eq('send button calls onSend', calls.sent, 1);
  buttonText(interactive, Tzh.chatStop).props.onClick();
  eq('stop button calls onStop', calls.stopped, 1);
  buttonText(interactive, Tzh.chatClear).props.onClick();
  eq('clear button calls onClearThread', calls.cleared, 1);
  const quoteRemoveButtons = findAll(interactive, byCls('iw-chat-quote-x'));
  quoteRemoveButtons[1].props.onClick();
  eq('quote remove reports its index', calls.removed, 1);
  buttonText(interactive, Tzh.chatQuotesClear).props.onClick();
  eq('clear-quotes calls onClearQuotes', calls.clearedQuotes, 1);
  buttonText(interactive, Tzh.chatCollapse).props.onClick();
  eq('collapse control calls onToggleExpanded', calls.toggled, 1);

  // Enter sends, Shift+Enter newlines, Enter never sends while streaming.
  let prevented = 0;
  const pressEnter = (tree, extra = {}) => findAll(tree, byCls('iw-chat-input'))[0].props.onKeyDown({
    key: 'Enter', shiftKey: false, isComposing: false, preventDefault: () => { prevented++; }, ...extra,
  });
  calls.sent = 0;
  const onSend = () => { calls.sent++; };
  const idleDock = render({ draft: 'hello', onSend });
  pressEnter(idleDock);
  eq('Enter sends', calls.sent, 1);
  eq('Enter prevents the textarea newline', prevented, 1);
  pressEnter(idleDock, { shiftKey: true });
  eq('Shift+Enter does not send', calls.sent, 1);
  pressEnter(idleDock, { key: 'a' });
  eq('non-Enter keys do not send', calls.sent, 1);
  pressEnter(idleDock, { isComposing: true });
  eq('IME-composing Enter does not send', calls.sent, 1);
  pressEnter(render({ draft: 'hello', streaming: true, onSend }));
  eq('Enter while streaming does not send', calls.sent, 1);

  // Focusing/typing expands a collapsed dock.
  let expandCalls = 0;
  const collapsedDock = render({ expanded: false, onToggleExpanded: () => { expandCalls++; } });
  const collapsedInput = findAll(collapsedDock, byCls('iw-chat-input'))[0];
  collapsedInput.props.onFocus();
  eq('focusing the input expands a collapsed dock', expandCalls, 1);
  collapsedInput.props.onChange({ target: { value: 'x' } });
  eq('typing expands a collapsed dock', expandCalls, 2);
});

// ── 22. client api.streamChat (fetch + SSE parsing) ──────────────────
console.log('\n[verify] client api.streamChat');
await sectionRun('client api.streamChat', async () => {
  const chunks = [
    'data: {"delta":"Hello"}\n\ndata: {"delta":" fr',
    'om the"}\n\ndata: {"delta":" examiner"}\n\ndata: {"done":true,"message":{"role":"assistant","content":"Hello from the examiner"}}\n\n',
  ];
  const c = bootClient({ fetch: streamingFetch(chunks) });
  const api = c.testApi().createApi();
  truthy('createApi exposes streamChat', typeof api.streamChat === 'function');
  const deltas = [];
  const full = await api.streamChat({
    key: 'draft', lang: 'en', text: 'hi', quotes: [], history: [], context: { surface: 'new' },
    onDelta: (d) => deltas.push(d),
  });
  eq('onDelta fires in order', deltas, ['Hello', ' from the', ' examiner']);
  eq('resolves with the accumulated reply', full, 'Hello from the examiner');

  // error event -> throws
  const errClient = bootClient({ fetch: streamingFetch(['data: {"error":"upstream 429"}\n\n']) });
  let streamErr = null;
  try {
    await errClient.testApi().createApi().streamChat({
      key: 'draft', lang: 'en', text: 'hi', quotes: [], history: [], context: { surface: 'new' },
      onDelta: () => {},
    });
  } catch (e) { streamErr = e; }
  truthy('error event rejects streamChat', !!streamErr && /429/.test(String(streamErr.message)));

  // empty reply -> throws
  const emptyClient = bootClient({ fetch: streamingFetch(['data: {"done":true,"message":{"role":"assistant","content":""}}\n\n']) });
  let emptyErr = null;
  try {
    await emptyClient.testApi().createApi().streamChat({
      key: 'draft', lang: 'en', text: 'hi', quotes: [], history: [], context: { surface: 'new' },
      onDelta: () => {},
    });
  } catch (e) { emptyErr = e; }
  truthy('empty reply rejects streamChat', !!emptyErr);
});

// ── 23. markdown renderer termination (chat streams partial markdown) ──
//
// The chat box re-renders markdown on every token. A partially-arrived table
// (bare `| a | b |` header line, no separator yet) used to leave the renderer's
// line cursor unmoved: an infinite loop that froze the whole browser tab until
// the chat stream was eventually aborted. Probe in a CHILD process with a
// timeout so the regression fails the suite instead of hanging it.
console.log('\n[verify] markdown renderer termination');
await sectionRun('markdown renderer termination', async () => {
  const { spawnSync } = await import('node:child_process');
  const mdUrl = new URL('./src/client/md.js', import.meta.url).href;
  const inputs = [
    '| Criterion | Band |',
    '| Criterion | Band |\n| --- ',
    'text before\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\ntext after',
    '```mermaid\ngraph TD; A-->B',
    '| a | b |\n|:-:|-:|',
  ];
  const script = `
    import { renderMarkdown } from ${JSON.stringify(mdUrl)};
    for (const s of ${JSON.stringify(inputs)}) renderMarkdown(s);
    process.stdout.write('ok');
  `;
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    timeout: 5000,
    encoding: 'utf8',
  });
  truthy('renderer terminates on partially streamed markdown (no page freeze)',
    probe.status === 0 && probe.stdout === 'ok');
  const { renderMarkdown } = await import('./src/client/md.js');
  truthy('a completed pipe table still renders as <table>',
    renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |').includes('<table>'));
  truthy('a half-streamed table header renders as text instead of stalling',
    renderMarkdown('| a | b |').includes('<p>'));
});

// ── 24. built client bundle hygiene ──────────────────────────────────
// build.mjs strips imports/exports and concatenates every src/client/*.js into
// ONE ModuleLoader factory closure. A stray `export` keyword or a duplicate
// top-level identifier (e.g. two `const STYLE`) silently breaks the browser
// half while the source still looks fine, so check the artifact.
console.log('\n[verify] built client bundle hygiene');
await sectionRun('client bundle hygiene', async () => {
  const bundlePath = join(PLUGIN_ROOT, 'lib', 'client.js');
  const source = readFileSync(bundlePath, 'utf8');

  eq('exactly one __ModuleLoader__.load envelope',
    source.split('\n').filter((line) => /^window\s*\.\s*__ModuleLoader__\s*\.\s*load\s*\(/.test(line)).length, 1);
  eq('no leftover import statements',
    source.split('\n').filter((line) => /^\s*import\s+/.test(line)), []);
  eq('no leftover export statements',
    source.split('\n').filter((line) => /^\s*export\s+/.test(line)), []);
  truthy('no ES module syntax anywhere in the bundle', !/^\s*(?:import|export)\b/m.test(source));

  // Top-level declarations of every source file share the factory closure.
  const ids = new Map();
  for (const line of source.split('\n')) {
    const m = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(line)
      || /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(line);
    if (!m) continue;
    ids.set(m[1], (ids.get(m[1]) || 0) + 1);
  }
  eq('no duplicate top-level client identifiers',
    [...ids].filter(([, n]) => n > 1).map(([name, n]) => `${name}×${n}`), []);
  truthy('createChat is declared exactly once', ids.get('createChat') === 1);
  truthy('STYLE is declared exactly once', ids.get('STYLE') === 1);
  truthy('single __iw_exports__ object', (source.match(/const __iw_exports__\s*=/g) || []).length === 1);
  truthy('ModuleLoader id matches the package name',
    source.includes('id: "dsh-ielts-writing-examiner"'));
  truthy('_test exposes createChat plus the SSE api',
    /_test\s*=\s*\{[\s\S]*?createChat[\s\S]*?createApi[\s\S]*?\}/.test(source));
});

// Clean up verify data (don't leave .verify-data lying around).
rmSync(DATA_ROOT, { recursive: true, force: true });

console.log(`\n[verify] ${failures === 0 ? 'PASS' : `FAIL (${failures} failures)`}`);
process.exit(failures === 0 ? 0 : 1);
