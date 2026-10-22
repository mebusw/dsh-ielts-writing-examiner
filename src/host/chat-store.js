// chat-store.js — one persisted chat thread per practice session.
//
// Layout (under ~/.ielts-examiner/):
//   chats/<key>.json     { key, updatedAt, messages: DisplayMessage[] }
//
// `key` is a 12-char session id or the literal `draft` (the thread used before
// the first session is created). The route saves the host-visible transcript
// (no injected context, no system prompt) so reloading the page restores exactly
// what the student saw.
//
// All writes are tmp → rename, same safety pattern as session-store.js.

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_MESSAGES = 200;
const MAX_CONTENT = 20000;
const MAX_QUOTES = 3;
const MAX_QUOTE = 1000;
// Per-practice unsaved threads (`draft-<random>`). They are migrated onto a
// session id on submission or abandoned when the user walks away; prune the
// abandoned ones so ~/.ielts-examiner/chats/ does not grow forever.
const DRAFT_FILE_RE = /^draft-[a-z0-9]+\.json$/;
const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Validate a thread key; throws for anything that could escape the chats dir. */
export function assertChatKey(key) {
  if (typeof key !== 'string' || !KEY_RE.test(key)) {
    throw new Error('chat: invalid key (expected a session id or "draft")');
  }
  return key;
}

function sanitizeQuotes(quotes) {
  if (!Array.isArray(quotes)) return [];
  const out = [];
  for (const raw of quotes) {
    if (typeof raw !== 'string') continue;
    const q = raw.replace(/\s+/g, ' ').trim();
    if (!q) continue;
    out.push(q.length > MAX_QUOTE ? q.slice(0, MAX_QUOTE) : q);
    if (out.length >= MAX_QUOTES) break;
  }
  return out;
}

/**
 * Validate + cap a persisted transcript. Invalid turns are dropped rather than
 * throwing: a corrupt chat file must never break the workbench or the RPC.
 */
export function sanitizeChatMessages(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    let content = typeof m.content === 'string' ? m.content : '';
    if (content.length > MAX_CONTENT) content = content.slice(0, MAX_CONTENT);
    content = content.replace(/\s+$/, '');
    const quotes = m.role === 'user' ? sanitizeQuotes(m.quotes) : [];
    if (!content && !quotes.length) continue;
    const row = { role: m.role, content };
    if (quotes.length) row.quotes = quotes;
    if (typeof m.ts === 'number' && Number.isFinite(m.ts)) row.ts = m.ts;
    out.push(row);
  }
  return out.slice(-MAX_MESSAGES);
}

export function createChatStore(dataRoot) {
  const DIR = join(dataRoot, 'chats');

  const ensure = () => {
    mkdirSync(DIR, { recursive: true });
  };

  const fileFor = (key) => join(DIR, `${assertChatKey(key)}.json`);

  function get(key) {
    const k = assertChatKey(key);
    try {
      const raw = JSON.parse(readFileSync(fileFor(k), 'utf8'));
      return { key: k, messages: sanitizeChatMessages(raw?.messages) };
    } catch {
      return { key: k, messages: [] };
    }
  }

  function save(key, messages) {
    const k = assertChatKey(key);
    const clean = sanitizeChatMessages(messages);
    ensure();
    const file = fileFor(k);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ key: k, updatedAt: Date.now(), messages: clean }, null, 2));
    renameSync(tmp, file);
    return { key: k, messages: clean };
  }

  function clear(key) {
    const k = assertChatKey(key);
    const file = fileFor(k);
    if (existsSync(file)) rmSync(file, { force: true });
    return { ok: true, key: k };
  }

  /**
   * Move one unsaved-practice thread (a unique `draft-*` key, or the legacy
   * constant `draft`) onto a real session id. Never overwrites a non-empty
   * target.
   */
  function migrate(from, to) {
    const src = get(from);
    const dst = get(to);
    if (src.key === dst.key) return { ok: true, migrated: false };
    if (dst.messages.length > 0 || src.messages.length === 0) {
      return { ok: true, migrated: false };
    }
    save(to, src.messages);
    clear(from);
    return { ok: true, migrated: true };
  }

  /**
   * Delete abandoned per-practice draft threads (`draft-<random>.json`) older
   * than maxAgeMs. The welcome-screen `draft.json` is intentionally kept.
   * Best-effort: prune failures never affect chat functionality.
   */
  function pruneDrafts(maxAgeMs = DRAFT_MAX_AGE_MS) {
    let removed = 0;
    try {
      ensure();
      const now = Date.now();
      for (const name of readdirSync(DIR)) {
        if (!DRAFT_FILE_RE.test(name)) continue;
        const file = join(DIR, name);
        try {
          if (now - statSync(file).mtimeMs > maxAgeMs) {
            rmSync(file, { force: true });
            removed++;
          }
        } catch { /* race with another prune/write: ignore */ }
      }
    } catch { /* chat pruning is never worth a boot failure */ }
    return removed;
  }

  return {
    get,
    save,
    clear,
    migrate,
    pruneDrafts,
    remove: clear,
    paths: { dir: DIR },
  };
}
