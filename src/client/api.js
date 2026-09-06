// RPC fetch wrappers. Talks to host's /ielts-examiner router via the
// connection.rpc bridge exposed by DSH runtime. Falls back to direct fetch
// (same path) for environments where the wrapper isn't injected.

const RPC_PATH = '/ielts-examiner';

async function call(connection, endpoint, payload = {}) {
  if (connection && connection.rpc && typeof connection.rpc.call === 'function') {
    return connection.rpc.call(RPC_PATH, endpoint, payload);
  }
  // Direct fetch fallback — same JSON-RPC contract.
  const resp = await fetch(`${RPC_PATH}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, payload }),
  });
  if (!resp.ok) throw new Error(`rpc ${endpoint}: HTTP ${resp.status}`);
  const data = await resp.json();
  if (data && data.ok === false) {
    throw new Error(data.error?.message || `rpc ${endpoint} failed`);
  }
  return data?.value;
}

export function createApi(connection) {
  return {
    listQuestions: () => call(connection, 'questionBank.list'),
    listSessions: () => call(connection, 'session.list'),
    createSession: (questionId) => call(connection, 'session.create', { questionId }),
    getSession: (id) => call(connection, 'session.get', { id }),
    updateEssay: (id, essay) => call(connection, 'session.updateEssay', { id, essay }),
    score: (id) => call(connection, 'session.score', { id }),
    pulse: (id) => call(connection, 'session.pulse', { id }),
    clone: (id) => call(connection, 'session.clone', { id }),
    delete: (id) => call(connection, 'session.delete', { id }),
  };
}
