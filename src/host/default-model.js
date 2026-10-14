// default-model.js
//
// Resolves which model one scoring call uses.
//
//   1. Runtime (canonical on DSH 0.2.x): read {provider, model} from the
//      agentDefaultModel service and dispatch through the `llm` service, which
//      owns endpoint + credential resolution. No provider table involved.
//   2. Standalone (verify.mjs / plain Node): fall back to a hardcoded provider
//      table plus ~/.dsh/settings.yaml, and speak HTTP directly.
//
// Returns: { provider, model, dispatch?: 'llm-service' } or
//          { provider, model, baseUrl, apiKey }
// Throws on failure with a message naming the actual gap.

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Default endpoint per provider, matches @deepseek-ai/dsh-llm-deepseek.
const PROVIDER_DEFAULTS = {
  'deepseek-official': {
    baseUrl: 'https://api.deepseek.com/v1',
    credentialRef: 'DEEPSEEK_API_KEY',
    envKey: 'DEEPSEEK_API_KEY',
  },
  deepseek: {           // legacy alias
    baseUrl: 'https://api.deepseek.com/v1',
    credentialRef: 'DEEPSEEK_API_KEY',
    envKey: 'DEEPSEEK_API_KEY',
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    credentialRef: 'OPENAI_API_KEY',
    envKey: 'OPENAI_API_KEY',
  },
  moonshot: {
    baseUrl: 'https://api.moonshot.cn/v1',
    credentialRef: 'MOONSHOT_API_KEY',
    envKey: 'MOONSHOT_API_KEY',
  },
  qwen: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    credentialRef: 'DASHSCOPE_API_KEY',
    envKey: 'DASHSCOPE_API_KEY',
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com/v1',
    credentialRef: 'ANTHROPIC_API_KEY',
    envKey: 'ANTHROPIC_API_KEY',
  },
  doubao: {
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3/v1',
    credentialRef: 'ARK_API_KEY',
    envKey: 'ARK_API_KEY',
  },
  openai_compatible: { baseUrl: '', credentialRef: '', envKey: '' },
};

function findProviderEntry(provider) {
  return PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.openai_compatible;
}

function readAgentDefaultModelFromYaml() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const p = join(home, 'settings.yaml');
  if (!existsSync(p)) return null;
  let txt;
  try { txt = readFileSync(p, 'utf8'); } catch { return null; }
  const block = txt.match(/agent-default-model:\s*\n((?:[ \t].*\n)*)/);
  if (!block) return null;
  let model = null, provider = null, baseUrlOverride = null;
  for (const line of block[1].split('\n')) {
    const pm = line.match(/^\s*model:\s*["']?([^\s"']+)/);
    if (pm) model = pm[1];
    const pv = line.match(/^\s*provider:\s*["']?([^\s"']+)/);
    if (pv) provider = pv[1];
    const pu = line.match(/^\s*baseUrl:\s*["']?([^\s"']+)/);
    if (pu) baseUrlOverride = pu[1];
  }
  return model ? { model, provider: provider || 'deepseek', baseUrlOverride } : null;
}

/**
 * Resolve the model for one scoring call.
 *
 * @param {object} [deps] — services from the DSH runtime
 * @param {object} [deps.agentDefaultModel] — exposes currentSelection()
 * @param {object} [deps.llm]               — the `llm` service; see below
 * @param {object} [deps.credentials]       — exposes resolve(ref)
 * @returns {Promise<{provider, model, dispatch?: 'llm-service', baseUrl?: string,
 *   apiKey?: string}>} — when `dispatch` is 'llm-service' the caller must send
 *   the prompt through `deps.llm.prepareCall(...)` and NOT build a URL itself.
 */
export async function resolveDefaultModel(deps = {}) {
  // Path 1 — canonical on Harness 0.2.x.
  //
  // A hand-rolled provider table can only ever be right for the providers it
  // hardcodes. `@deepseek-ai/dsh-llm` contains no baseUrl at all: endpoint and
  // credential resolution belong to the adapter (dsh-llm-pi-ai). So for any
  // provider outside PROVIDER_DEFAULTS — `minimax-cn`, for instance — the old
  // code silently fell through to the openai_compatible entry, which has an
  // empty baseUrl/credentialRef, and scoring failed with
  //   "runtime 已选中 provider=minimax-cn，但  未配置"
  // Asking the runtime for the current selection and letting `llm` dispatch is
  // the only provider-agnostic option; llm.js does the actual call.
  const selection = typeof deps.agentDefaultModel?.currentSelection === 'function'
    ? deps.agentDefaultModel.currentSelection()
    : null;
  if (selection?.provider && selection?.model) {
    if (typeof deps.llm?.prepareCall === 'function') {
      return { provider: selection.provider, model: selection.model, dispatch: 'llm-service' };
    }
    const entry = findProviderEntry(selection.provider);
    let apiKey = '';
    if (typeof deps.credentials?.resolve === 'function') {
      const r = await deps.credentials.resolve(entry.credentialRef);
      apiKey = r?.value || '';
    }
    if (!apiKey && entry.envKey) apiKey = process.env[entry.envKey] || '';
    if (apiKey && entry.baseUrl) {
      return { provider: selection.provider, model: selection.model, baseUrl: entry.baseUrl, apiKey };
    }
    if (!entry.credentialRef) {
      // The runtime picked a provider this table has no endpoint for, and the
      // `llm` service is unavailable. Say so instead of blaming credentials.
      throw new Error(
        `已选中 provider=${selection.provider} / model=${selection.model}，但本插件没有该 provider 的 endpoint 配置，` +
        `且运行时未提供 llm 服务。请在 ${process.env.DSH_HOME || join(homedir(), '.dsh')} 下补齐 provider 配置。`,
      );
    }
    throw new Error(
      `runtime 已选中 provider=${selection.provider}，但 ${entry.credentialRef} 未配置。` +
      `请在 ~/.dsh/.credentials.yaml 的 refs.${entry.credentialRef} 写入密钥。`,
    );
  }

  // Path 2: standalone HTTP fallback (verify.mjs / plain Node, no DSH runtime).
  const fromYaml = readAgentDefaultModelFromYaml();
  const candidates = [];
  if (fromYaml) candidates.push(fromYaml);
  for (const [name, entry] of Object.entries(PROVIDER_DEFAULTS)) {
    if (entry.envKey && process.env[entry.envKey]) {
      candidates.push({ provider: name, model: '' });
    }
  }

  for (const c of candidates) {
    const entry = findProviderEntry(c.provider);
    const apiKey = entry.envKey ? process.env[entry.envKey] : '';
    if (!apiKey && c.provider !== 'openai_compatible') continue;
    const model = c.model || (c.provider === 'deepseek-official' ? 'deepseek-v4-flash'
      : c.provider === 'deepseek' ? 'deepseek-chat'
      : c.provider === 'openai' ? 'gpt-4o-mini' : '');
    if (!model) continue;
    return {
      provider: c.provider,
      model,
      baseUrl: c.baseUrlOverride || entry.baseUrl,
      apiKey,
    };
  }

  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  throw new Error(
    `未配置默认模型。` +
    `请在 ${home}/settings.yaml 的 agent-default-model 块写入 model + provider，` +
    `或在 ${home}/.credentials.yaml 的 refs 中设置 DEEPSEEK_API_KEY（或其他 provider 对应的密钥）。`,
  );
}
