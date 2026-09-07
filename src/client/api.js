// RPC client — direct fetch wrapper over the host /ielts-examiner endpoints.
//
// Mirrors pomasa-studio/src/client/api.js (no DSH client modules needed).
// The host registers a JSON-RPC handler; we POST {endpoint, payload} and
// get back {ok, value} (or {ok:false, error}). We unwrap here.

const RPC = '/ielts-examiner';

async function call(endpoint, payload) {
  const res = await fetch(`${RPC}/rpc`, {
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

export function createApi(_connection) {
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
  };
}
