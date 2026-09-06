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

// Mock host context: capture RPC + route registrations, expose the same shape
// as DSH runtime.
const ctx = {
  connection: {
    rpc: {
      handle(path, handler) {
        this._handlers = this._handlers || {};
        this._handlers[path] = handler;
      },
      async call(path, endpoint, payload) {
        const h = this._handlers?.[path];
        if (!h) throw new Error(`no rpc handler for ${path}`);
        const r = await h(endpoint, payload || {});
        if (r?.ok === false) throw new Error(r.error?.message || 'rpc failed');
        return r.value;
      },
    },
  },
  webServer: {
    _routes: [],
    register(spec) { this._routes.push(spec); },
    async _dispatch(method, urlPath) {
      for (const r of this._routes) {
        if ((r.kind === 'exact' && r.path === urlPath) || (r.kind === 'prefix' && urlPath.startsWith(r.path))) {
          return new Promise((resolve) => {
            const res = {
              _status: 200, _headers: {}, _body: null,
              writeHead(s, h) { this._status = s; Object.assign(this._headers, h || {}); },
              end(b) { this._body = b; resolve({ status: this._status, headers: this._headers, body: this._body }); },
            };
            r.handler({ method, url: urlPath }, res);
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
  credentials: {
    async resolve(ref) { return { value: 'sk-test-stub', ref }; },
  },
};

console.log('[verify] booting plugin host half…');
const mod = await import(LIB);
const result = mod.apply(ctx, { dataDir: DATA_ROOT });

truthy('apply() returns dataRoot', result.dataRoot === DATA_ROOT);
eq('inject[]', result.inject, ['connection', 'webServer', 'agentDefaultModel', 'credentials']);

const rpc = ctx.connection.rpc;

// 1. questionBank.list
console.log('\n[verify] questionBank.list');
const qs = await rpc.call('/ielts-examiner', 'questionBank.list');
truthy('items > 0', qs.length > 0);
truthy('has Task 1 items', qs.some((q) => q.task === '1'));
truthy('has Task 2 items', qs.some((q) => q.task === '2'));

// 2. session lifecycle
console.log('\n[verify] session lifecycle');
const firstQ = qs[0];
const { id: sid } = await rpc.call('/ielts-examiner', 'session.create', { questionId: firstQ.id });
truthy('session.create returns id', typeof sid === 'string' && sid.length === 12);

const list1 = await rpc.call('/ielts-examiner', 'session.list');
truthy('session.list includes new session', list1.some((s) => s.id === sid));

const got = await rpc.call('/ielts-examiner', 'session.get', { id: sid });
eq('get().questionId', got.questionId, firstQ.id);
eq('get().status', got.status, 'idle');

const essay = 'Some practice essay about graphs and trends in modern cities. ' +
  'It should be at least fifty words long to pass the minimum length check. ' +
  'Yes indeed there are many things to say about this topic. '.repeat(4);
const meta = await rpc.call('/ielts-examiner', 'session.updateEssay', { id: sid, essay });
truthy('updateEssay bumps wordCount', meta.wordCount > 50);
eq('updateEssay.status=running', meta.status, 'running');

// 3. session.clone
const { id: sid2 } = await rpc.call('/ielts-examiner', 'session.clone', { id: sid });
truthy('clone has different id', sid2 !== sid);
const got2 = await rpc.call('/ielts-examiner', 'session.get', { id: sid2 });
eq('clone copies questionId', got2.questionId, firstQ.id);
truthy('clone carries over essay', got2.essay.length > 50);

// 4. session.pulse (no result.json yet)
const pulse = await rpc.call('/ielts-examiner', 'session.pulse', { id: sid });
eq('pulse.running', pulse.status, 'running');
eq('pulse.hasResult', pulse.hasResult, false);

// 5. session.delete
const del = await rpc.call('/ielts-examiner', 'session.delete', { id: sid2 });
eq('delete.ok', del.ok, true);
const list2 = await rpc.call('/ielts-examiner', 'session.list');
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
try { await rpc.call('/ielts-examiner', 'session.bogus', {}); } catch { threw = true; }
truthy('unknown endpoint throws', threw);

// 10. health
const health = await rpc.call('/ielts-examiner', 'health');
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

// 12. resolveDefaultModel throws cleanly when nothing configured
let threwClean = false;
try {
  await resolveDefaultModel({});
} catch (e) {
  threwClean = /未配置default模型|未配置默认模型/.test(e.message);
}
truthy('resolveDefaultModel throws clear error when no ctx + no env', threwClean);

// Clean up verify data (don't leave .verify-data lying around).
rmSync(DATA_ROOT, { recursive: true, force: true });

console.log(`\n[verify] ${failures === 0 ? 'PASS' : `FAIL (${failures} failures)`}`);
process.exit(failures === 0 ? 0 : 1);
