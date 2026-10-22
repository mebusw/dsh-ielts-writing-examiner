// chat.js — drives one chat-box turn against the DSH runtime's default model.
//
// The chat box is a multi-turn conversation with the examiner/tutor. The host
// resolves the runtime default model exactly like scoring does, tags historical
// assistant messages with their `source` (both DSH adapters project assistant
// history through it), then streams text deltas back to the SSE route.
//
// This module owns no transport and no persistence: apply.js writes the SSE
// frames and chat-store.js stores the transcript.

import { resolveDefaultModel } from './default-model.js';
import { streamViaLlmServiceDeltas, streamHttpChatDeltas } from './llm.js';
import { attachAssistantSources } from './chat-prompt.js';

/**
 * Stream one chat turn as text deltas.
 *
 * @param {{deps?: object, system?: string, messages: object[],
 *   signal?: AbortSignal, temperature?: number, timeoutMs?: number}} opts
 * @returns {AsyncGenerator<string>}
 */
export async function* chatStreamDeltas({
  deps = {}, system, messages, signal, temperature = 0.5, timeoutMs = 180_000,
}) {
  const m = await resolveDefaultModel(deps);
  // Historical assistant turns must carry provider/model provenance before an
  // adapter sees them: dsh-llm-deepseek's replay validator and dsh-llm-pi-ai's
  // assistant projection both read `message.source`.
  const ready = attachAssistantSources(messages, m.provider, m.model);
  if (m.dispatch === 'llm-service') {
    yield* streamViaLlmServiceDeltas(deps.llm, {
      provider: m.provider,
      model: m.model,
      system,
      messages: ready,
      signal,
      timeoutMs,
      temperature,
    });
    return;
  }
  yield* streamHttpChatDeltas({
    baseUrl: m.baseUrl,
    apiKey: m.apiKey,
    model: m.model,
    system,
    messages: ready,
    signal,
    timeoutMs,
    temperature,
  });
}
