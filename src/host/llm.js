// llm.ts → llm.js
//
// Drives one IELTS scoring call against the DSH runtime's default model.
//
//   scoreEssay({ store, sessionId, dataRoot, pluginRoot })
//     1. reads question + essay from session
//     2. assembles prompt via ./prompt.js
//     3. resolves {provider, model, baseUrl, apiKey} via ./default-model.js
//     4. POSTs SSE chat/completions with response_format=json_object
//     5. parses accumulated JSON, validates via ../shared/schema.js
//     6. persists to result.json + flips status=done (or status=failed)

import { resolveDefaultModel } from './default-model.js';
import { buildScorePrompt } from './prompt.js';
import { validateScoreResult } from '../shared/schema.js';
import { findById } from './question-bank.js';

function logInfo(scope, msg) {
  // eslint-disable-next-line no-console
  console.log(`[dsh-ielts-writing-examiner] ${scope}: ${msg}`);
}

function logError(scope, e) {
  // eslint-disable-next-line no-console
  console.error(`[dsh-ielts-writing-examiner] ${scope}:`, e?.stack || e);
}

async function streamChatJson({ baseUrl, apiKey, model, prompt, signal, timeoutMs = 300_000 }) {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  // Combine caller's signal with a hard timeout so a hung fetch can't
  // strand the session in 'running' forever.
  const timeoutAc = new AbortController();
  const timer = setTimeout(() => timeoutAc.abort(new Error('LLM fetch timeout')), timeoutMs);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutAc.signal])
    : timeoutAc.signal;
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: true,
        response_format: { type: 'json_object' },
        temperature: 0.4,
      }),
      signal: combinedSignal,
    });
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
  clearTimeout(timer);
  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => '');
    throw new Error(`LLM HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let accumulated = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) accumulated += delta;
      } catch { /* skip malformed chunk */ }
    }
  }
  return accumulated;
}

function safeParseJson(text) {
  // Most providers return clean JSON; some wrap it in ```json fences.
  let s = String(text || '').trim();
  const fence = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fence) s = fence[1].trim();
  return JSON.parse(s);
}

/**
 * Send one prompt through the runtime's `llm` service and collect its text.
 *
 * This is the provider-agnostic path. `@deepseek-ai/dsh-llm` exposes no baseUrl
 * at all — endpoint and credentials live in the adapter — so a plugin cannot
 * assemble the HTTP request itself for an arbitrary provider. The service
 * contract (dsh-llm 0.2.x):
 *
 *   const call = await llm.prepareCall({ provider, model }, signal);
 *   const stream = call.stream({ ...call.config, messages });   // one-shot
 *
 * `callConfigEquals` only compares provider/model/reasoningEffort/temperature/
 * maxTokens/stop, so attaching `messages` cannot break the prepared-call guard.
 * Messages are block arrays, not strings: `{ role, content: [{ type, text }] }`.
 *
 * Record shapes vary by adapter. The raw adapter stream (dsh-llm-pi-ai) yields
 * FLAT records — `{ type: 'text-delta', index, text }`, bracketed by text_start
 * / text_end markers, plus a terminal finish. The nested
 * `{ type: 'chunk', chunk: {...} }` and `{ type: 'text-chunks', texts: [...] }`
 * forms belong to the accumulator's compact representation, so both are
 * accepted. Guessing wrong here fails silently: the reply reads as empty and
 * safeParseJson reports "Unexpected end of JSON input" long after a perfectly
 * good model response arrived.
 */
export async function streamViaLlmService(llm, { provider, model, prompt, signal, timeoutMs = 300_000 }) {
  const timeoutAc = new AbortController();
  const timer = setTimeout(() => timeoutAc.abort(new Error('LLM call timeout')), timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutAc.signal]) : timeoutAc.signal;
  try {
    const call = await llm.prepareCall({ provider, model, temperature: 0.4 }, combinedSignal);
    const stream = call.stream({
      ...call.config,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    });
    let deltas = '';
    let whole = '';
    let sawText = false;
    for await (const record of stream) {
      if (record == null || typeof record !== 'object') continue;
      if (record.type === 'text-delta') { deltas += record.text || ''; sawText = true; continue; }
      if (record.type === 'text-chunks') { deltas += (record.texts || []).join(''); sawText = true; continue; }
      if (record.type === 'text') { whole += record.text || ''; continue; }
      if (record.type === 'chunk' && record.chunk) {
        if (record.chunk.type === 'text-delta') { deltas += record.chunk.text || ''; sawText = true; }
        else if (record.chunk.type === 'text') { whole += record.chunk.text || ''; }
        continue;
      }
      if (record.type === 'finish') {
        const kind = record.reason?.kind;
        if (kind === 'error' || kind === 'aborted') {
          throw record.reason.failure || new Error(`LLM call ${kind}`);
        }
      }
    }
    // Prefer streamed deltas; a whole-text record is the fallback for adapters
    // that emit none. Never emit both — that would duplicate the content.
    const out = sawText ? deltas : whole;
    if (!out.trim()) {
      throw new Error(`LLM 通过 llm 服务返回了空内容 (provider=${provider}, model=${model})`);
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

export async function scoreEssay({ store, sessionId, dataRoot, pluginRoot, deps = {} }) {
  const session = store.get(sessionId);
  if (!session) throw new Error(`scoreEssay: no such session ${sessionId}`);
  // Idempotent: if we already scored this session, no-op.
  if (session.result) {
    logInfo('scoreEssay', `session=${sessionId} already scored band=${session.result?.correction?.overallBand}, skipping`);
    return session.result;
  }
  const question = findById(pluginRoot, session.questionId);
  if (!question) throw new Error(`scoreEssay: question ${session.questionId} not found in bank`);

  const m = await resolveDefaultModel(deps);
  // Only the standalone HTTP path knows the origin; the llm-service path gets
  // the endpoint from the adapter. assetBase only decorates image links inside
  // the prompt — the browser fetches them from DSH's own webServer route.
  const assetBase = m.baseUrl ? `${m.baseUrl.replace(/\/v1\/?$/, '')}/ielts-examiner/asset` : '';

  const prompt = buildScorePrompt({
    dataRoot,
    question: {
      title: question.title,
      body: question.body,
      images: question.images,
    },
    essay: session.essay,
    assetBase,
  });

  logInfo('scoreEssay', `session=${sessionId} provider=${m.provider} model=${m.model} dispatch=${m.dispatch || 'http'} essayLen=${session.essay.length}`);
  const ac = new AbortController();
  let raw;
  try {
    raw = m.dispatch === 'llm-service'
      ? await streamViaLlmService(deps.llm, {
        provider: m.provider, model: m.model, prompt, signal: ac.signal,
      })
      : await streamChatJson({
        baseUrl: m.baseUrl,
        apiKey: m.apiKey,
        model: m.model,
        prompt,
        signal: ac.signal,
      });
  } catch (e) {
    logError('scoreEssay.fetch', e);
    throw e;
  }
  const parsed = safeParseJson(raw);
  const check = validateScoreResult(parsed);
  if (!check.ok) {
    throw new Error(`LLM 输出不符合 schema: ${check.error}`);
  }
  store.markDone(sessionId, parsed);
  logInfo('scoreEssay', `session=${sessionId} done band=${parsed.correction.overallBand}`);
  return parsed;
}
