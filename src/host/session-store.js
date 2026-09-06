// Session store — filesystem-first session lifecycle (mirror of dsh-pictor/lib/index.js).
//
// On-disk layout (under ~/.ielts-examiner/):
//   index.json                       SessionRecord[] (newest first)
//   sessions/<sid>/
//     meta.json                      { id, questionId, questionTitle, createdAt, status, wordCount, overallBand? }
//     essay.txt                      raw user input
//     result.json                    full parsed model output (shared/schema.ts)
//
// All writes are tmp → rename for half-write safety (pictor's pattern).

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { customAlphabet } from 'node:crypto';

// 12-char URL-safe id; collision risk negligible for personal use.
const newId = () => {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  const bytes = new Uint8Array(12);
  // Pull from crypto.getRandomValues without importing node:crypto.randomBytes
  // (works under both node and bun); fallback below.
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
    for (const b of bytes) s += a[b & 31];
    return s;
  }
  for (let i = 0; i < 12; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
};

function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, file);
}

function writeTextAtomic(file, text) {
  const tmp = file + '.tmp';
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
}

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Filesystem-derived stage for a session dir.
 *
 * Returns the same 4-state enum the UI uses:
 *   - 'failed'  : meta.json exists with status='failed'
 *   - 'done'    : result.json exists
 *   - 'running' : essay.txt exists but no result yet (LLM in flight or pending)
 *   - 'idle'    : session created but no essay written yet
 */
function stageOf(sessionDir) {
  const meta = existsSync(join(sessionDir, 'meta.json'))
    ? readJsonSafe(join(sessionDir, 'meta.json'))
    : null;
  if (meta?.status === 'failed') return 'failed';
  if (existsSync(join(sessionDir, 'result.json'))) return 'done';
  if (existsSync(join(sessionDir, 'essay.txt'))) return 'running';
  return 'idle';
}

export function createSessionStore(dataRoot) {
  const INDEX = join(dataRoot, 'index.json');
  const SESSIONS_DIR = join(dataRoot, 'sessions');
  const PROMPTS_DIR = join(dataRoot, 'prompts');

  function ensure() {
    mkdirSync(dataRoot, { recursive: true });
    mkdirSync(SESSIONS_DIR, { recursive: true });
    mkdirSync(PROMPTS_DIR, { recursive: true });
    if (!existsSync(INDEX)) writeJsonAtomic(INDEX, []);
  }

  function readIndex() {
    ensure();
    return readJsonSafe(INDEX) || [];
  }

  function writeIndex(list) {
    writeJsonAtomic(INDEX, list);
  }

  function sessionDir(id) {
    return join(SESSIONS_DIR, id);
  }

  function ensureSession(id) {
    const d = sessionDir(id);
    mkdirSync(d, { recursive: true });
    return d;
  }

  function getMeta(id) {
    return readJsonSafe(join(sessionDir(id), 'meta.json'));
  }

  function getEssay(id) {
    const p = join(sessionDir(id), 'essay.txt');
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
  }

  function getResult(id) {
    return readJsonSafe(join(sessionDir(id), 'result.json'));
  }

  /** Create a new session bound to a question. */
  function create({ questionId, questionTitle }) {
    ensure();
    const id = newId();
    const dir = ensureSession(id);
    const meta = {
      id,
      questionId,
      questionTitle: questionTitle || questionId,
      createdAt: Date.now(),
      status: 'idle',
      wordCount: 0,
    };
    writeJsonAtomic(join(dir, 'meta.json'), meta);
    const list = readIndex();
    list.unshift(meta);
    writeIndex(list);
    return meta;
  }

  /** Persist essay text and update index row wordCount. */
  function updateEssay(id, essay) {
    const dir = ensureSession(id);
    const meta = getMeta(id) || { id, questionId: '', questionTitle: '', createdAt: Date.now() };
    writeTextAtomic(join(dir, 'essay.txt'), essay);
    const wc = String(essay || '').trim() ? String(essay).trim().split(/\s+/).length : 0;
    meta.wordCount = wc;
    meta.status = stageOf(dir); // 'running' once essay + meta exist, 'done' if result exists
    writeJsonAtomic(join(dir, 'meta.json'), meta);
    const list = readIndex();
    const i = list.findIndex((s) => s.id === id);
    if (i >= 0) list[i] = { ...list[i], ...meta };
    else list.unshift(meta);
    writeIndex(list);
    return meta;
  }

  /** Mark session as running and return it for the LLM call. */
  function markRunning(id) {
    const meta = getMeta(id);
    if (!meta) throw new Error(`session.markRunning: no such session ${id}`);
    meta.status = 'running';
    meta.startedAt = Date.now();
    const dir = ensureSession(id);
    writeJsonAtomic(join(dir, 'meta.json'), meta);
    const list = readIndex();
    const i = list.findIndex((s) => s.id === id);
    if (i >= 0) list[i] = { ...list[i], ...meta };
    writeIndex(list);
    return meta;
  }

  /** Persist parsed LLM output + flip status to done. */
  function markDone(id, result) {
    const dir = ensureSession(id);
    const meta = getMeta(id);
    if (!meta) throw new Error(`session.markDone: no such session ${id}`);
    const band = typeof result?.correction?.overallBand === 'number'
      ? result.correction.overallBand
      : undefined;
    meta.status = 'done';
    meta.completedAt = Date.now();
    if (band !== undefined) meta.overallBand = band;
    writeJsonAtomic(join(dir, 'result.json'), result);
    writeJsonAtomic(join(dir, 'meta.json'), meta);
    const list = readIndex();
    const i = list.findIndex((s) => s.id === id);
    if (i >= 0) list[i] = { ...list[i], ...meta };
    writeIndex(list);
    return meta;
  }

  function markFailed(id, errorMessage) {
    const meta = getMeta(id);
    if (!meta) throw new Error(`session.markFailed: no such session ${id}`);
    meta.status = 'failed';
    meta.error = String(errorMessage || 'unknown');
    meta.failedAt = Date.now();
    const dir = ensureSession(id);
    writeJsonAtomic(join(dir, 'meta.json'), meta);
    const list = readIndex();
    const i = list.findIndex((s) => s.id === id);
    if (i >= 0) list[i] = { ...list[i], ...meta };
    writeIndex(list);
    return meta;
  }

  function list() {
    return readIndex();
  }

  function get(id) {
    const meta = getMeta(id);
    if (!meta) return null;
    const status = stageOf(sessionDir(id));
    return {
      ...meta,
      status,
      essay: getEssay(id),
      result: status === 'done' ? getResult(id) : null,
    };
  }

  function pulse(id) {
    const status = stageOf(sessionDir(id));
    return { status, hasResult: status === 'done' };
  }

  function remove(id) {
    const dir = sessionDir(id);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    writeIndex(readIndex().filter((s) => s.id !== id));
    return { ok: true, id };
  }

  /** Copy bundled prompt into ~/.ielts-examiner/prompts/ on first run. */
  function seedPrompt({ src, destName }) {
    ensure();
    const dest = join(PROMPTS_DIR, destName);
    if (existsSync(dest)) return dest;
    writeFileSync(dest, readFileSync(src, 'utf8'));
    return dest;
  }

  return {
    ensure,
    list,
    get,
    create,
    updateEssay,
    markRunning,
    markDone,
    markFailed,
    pulse,
    remove,
    seedPrompt,
    paths: { dataRoot, INDEX, SESSIONS_DIR, PROMPTS_DIR },
  };
}
