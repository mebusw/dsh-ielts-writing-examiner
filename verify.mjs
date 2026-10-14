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
    async _dispatch(method, urlPath, body) {
      for (const r of this._routes) {
        if ((r.kind === 'exact' && r.path === urlPath) || (r.kind === 'prefix' && urlPath.startsWith(r.path))) {
          return new Promise((resolve) => {
            const res = {
              _status: 200, _headers: {}, _body: null,
              writeHead(s, h) { this._status = s; Object.assign(this._headers, h || {}); },
              end(b) { this._body = b; resolve({ status: this._status, headers: this._headers, body: this._body }); },
            };
            // The real IncomingMessage is an async iterable; the RPC handler
            // does `for await (const c of req)`, so the mock must be too.
            const payload = Buffer.from(body || '', 'utf8');
            const req = {
              method,
              url: urlPath,
              async *[Symbol.asyncIterator]() {
                if (payload.length) yield payload;
              },
            };
            r.handler(req, res);
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

function bootClient({ dock, locale } = {}) {
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
  new Function('window', 'document', 'localStorage', 'fetch', 'console', 'location', source)(
    win,
    doc,
    { getItem: () => null, setItem: () => {} },
    () => Promise.resolve({ ok: true, json: async () => ({}) }),
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

// Clean up verify data (don't leave .verify-data lying around).
rmSync(DATA_ROOT, { recursive: true, force: true });

console.log(`\n[verify] ${failures === 0 ? 'PASS' : `FAIL (${failures} failures)`}`);
process.exit(failures === 0 ? 0 : 1);
