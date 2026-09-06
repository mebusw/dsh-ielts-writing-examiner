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
  console.log(`[dsh-ielts-examiner] ${scope}: ${msg}`);
}

function logError(scope, e) {
  // eslint-disable-next-line no-console
  console.error(`[dsh-ielts-examiner] ${scope}:`, e?.stack || e);
}

async function streamChatJson({ baseUrl, apiKey, model, prompt, signal }) {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const resp = await fetch(url, {
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
    signal,
  });
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

export async function scoreEssay({ store, sessionId, dataRoot, pluginRoot }) {
  const session = store.get(sessionId);
  if (!session) throw new Error(`scoreEssay: no such session ${sessionId}`);
  const question = findById(pluginRoot, session.questionId);
  if (!question) throw new Error(`scoreEssay: question ${session.questionId} not found in bank`);

  const m = resolveDefaultModel();
  const assetBase = `${m.baseUrl.replace(/\/v1\/?$/, '')}/ielts-examiner/asset`;
  // Note: assetBase is only used to render image links inside the prompt; the
  // browser actually fetches them from DSH's webServer, but LLM doesn't read
  // them anyway — imageDescription is the LLM's job for Task 1.

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

  logInfo('scoreEssay', `session=${sessionId} provider=${m.provider} model=${m.model} essayLen=${session.essay.length}`);
  const ac = new AbortController();
  const raw = await streamChatJson({
    baseUrl: m.baseUrl,
    apiKey: m.apiKey,
    model: m.model,
    prompt,
    signal: ac.signal,
  });
  const parsed = safeParseJson(raw);
  const check = validateScoreResult(parsed);
  if (!check.ok) {
    throw new Error(`LLM 输出不符合 schema: ${check.error}`);
  }
  store.markDone(sessionId, parsed);
  logInfo('scoreEssay', `session=${sessionId} done band=${parsed.correction.overallBand}`);
  return parsed;
}
