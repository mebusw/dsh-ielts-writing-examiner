// RPC client — direct fetch wrapper over the host /ielts-examiner endpoints.
//
// Mirrors pomasa-studio/src/client/api.js (no DSH client modules needed).
// The host registers a JSON-RPC handler; we POST {endpoint, payload} and
// get back {ok, value} (or {ok:false, error}). We unwrap here.
//
// The chat feature adds three JSON-RPC calls plus a streaming POST. streamChat
// parses the host's SSE response incrementally; `parseSseEvents` lives in
// chat.js (top-level fns are hoisted into the same concatenated bundle scope).

const RPC_BASE = '/ielts-examiner';

async function call(endpoint, payload) {
  const res = await fetch(`${RPC_BASE}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, payload: payload || {} }),
  });
  if (!res.ok) {
    throw new Error(`rpc ${endpoint}: HTTP ${res.status}`);
  }
  const data = await res.json();
  if (data && data.ok === false) {
    throw new Error(data.error?.message || `rpc ${endpoint} failed`);
  }
  return data?.value;
}

// ── chat RPCs (contract: .team/contract.md) ────────────────────

export function chatGet(key) {
  return call('chat.get', { key });
}

export function chatClear(key) {
  return call('chat.clear', { key });
}

export function chatMigrate(from, to) {
  return call('chat.migrate', { from, to });
}

function errorFromEvent(ev) {
  const raw = ev && ev.error;
  if (raw && typeof raw === 'object') {
    const msg = raw.message || raw.error || raw.reason;
    return new Error(msg ? String(msg) : JSON.stringify(raw));
  }
  return new Error(raw == null ? 'chat: request failed' : String(raw));
}

async function httpError(res) {
  let msg = `chat: HTTP ${res.status}`;
  try {
    const text = typeof res.text === 'function' ? await res.text() : '';
    if (text) {
      try {
        const data = JSON.parse(text);
        const raw = data?.error?.message || data?.error || data?.message;
        if (raw) msg = String(raw);
        else msg = text.slice(0, 300);
      } catch {
        msg = text.slice(0, 300);
      }
    }
  } catch { /* ignore body read failures */ }
  return new Error(msg);
}

function abortError() {
  try { return new DOMException('The operation was aborted.', 'AbortError'); }
  catch { const e = new Error('The operation was aborted.'); e.name = 'AbortError'; return e; }
}

/**
 * POST /ielts-examiner/chat and consume the SSE reply.
 *
 * @returns {Promise<string>} the full assistant reply
 * @throws  {Error} on HTTP/transport failure, an `{"error":...}` event, an
 *                  aborted request (AbortError, passed through untouched), or
 *                  a stream that ends without any text.
 */
export async function streamChat({
  key, lang, text, quotes, history, context, onDelta, signal,
} = {}) {
  const body = {
    key: key || 'draft',
    lang: lang === 'en' ? 'en' : 'zh',
    text: String(text == null ? '' : text),
    quotes: Array.isArray(quotes) ? quotes.slice(0, 3) : [],
    history: Array.isArray(history) ? history : [],
    context: context || null,
  };

  if (signal && signal.aborted) throw abortError();
  const res = await fetch(`${RPC_BASE}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res || !res.ok) throw await httpError(res || { status: 0 });

  const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;
  const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
  let reply = '';
  let doneContent = '';
  let buffer = '';
  let onAbort = null;

  const consume = (raw) => {
    const parsed = parseSseEvents(raw);
    for (const ev of parsed.events) {
      if (ev.error != null) throw errorFromEvent(ev);
      if (typeof ev.delta === 'string' && ev.delta) {
        reply += ev.delta;
        if (typeof onDelta === 'function') {
          try { onDelta(ev.delta); } catch { /* a UI callback must not kill the stream */ }
        }
      }
      if (ev.done && ev.message && typeof ev.message.content === 'string') {
        doneContent = ev.message.content;
      }
    }
    return parsed.rest;
  };

  try {
    if (reader) {
      // Cancel the reader on abort too: a mocked/infinite transport that does
      // not reject read() on its own still has to stop consuming the stream.
      if (signal && typeof signal.addEventListener === 'function') {
        onAbort = () => { try { reader.cancel(); } catch { /* ignore */ } };
        signal.addEventListener('abort', onAbort);
      }
      for (;;) {
        const chunk = await reader.read();
        if (!chunk || chunk.done) break;
        if (signal && signal.aborted) throw abortError();
        const piece = decoder
          ? decoder.decode(chunk.value, { stream: true })
          : String(chunk.value == null ? '' : chunk.value);
        if (piece) buffer = consume(buffer + piece);
      }
      if (signal && signal.aborted) throw abortError();
      if (decoder) {
        const tail = decoder.decode();
        if (tail) buffer += tail;
      }
      // Flush a final event that arrived without its terminating blank line.
      if (buffer.trim()) consume(buffer + '\n\n');
    } else {
      const raw = typeof res.text === 'function' ? await res.text() : '';
      consume(String(raw || '') + '\n\n');
    }
  } finally {
    if (onAbort && signal && typeof signal.removeEventListener === 'function') {
      try { signal.removeEventListener('abort', onAbort); } catch { /* ignore */ }
    }
    if (reader) { try { reader.cancel(); } catch { /* ignore */ } }
  }

  // The `done` event carries the authoritative full reply; prefer it when the
  // deltas were empty (some hosts compress a short answer into one event).
  const full = reply.trim() ? reply : doneContent;
  if (!String(full || '').trim()) throw new Error('chat: empty reply');
  return full;
}

// No service dependencies: every call is a plain fetch to the host route
// registered in src/host/apply.js. Takes no argument on purpose — the old
// `connection` parameter was threaded through from apply() and never read,
// while the client still declared `connection` as a hard inject.
export function createApi() {
  return {
    listQuestions: () => call('questionBank.list'),
    listSessions: () => call('session.list'),
    createSession: (questionId) => call('session.create', { questionId }),
    getSession: (id) => call('session.get', { id }),
    updateEssay: (id, essay) => call('session.updateEssay', { id, essay }),
    score: (id) => call('session.score', { id }),
    pulse: (id) => call('session.pulse', { id }),
    clone: (id) => call('session.clone', { id }),
    delete: (id) => call('session.delete', { id }),
    chatGet,
    chatClear,
    chatMigrate,
    streamChat,
  };
}
