// default-model.js
//
// Resolves the LLM config for one scoring call. Two paths:
//
//   1. ctx-injected (canonical when running under DSH runtime):
//      - ctx.agentDefaultModel.currentSelection() → { provider, model }
//      - ctx.credentials.resolve(ref)             → api key
//      Provider "deepseek-official" → baseURL https://api.deepseek.com/v1
//
//   2. standalone (for verify.mjs / unit tests / non-DSH Node):
//      - ~/.dsh/settings.yaml "agent-default-model:" block (pomasa pattern)
//      - or env var fallback per provider
//
// Returns: { provider, model, baseUrl, apiKey }
// Throws on failure with a clear message.

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
 * Resolve { provider, model, baseUrl, apiKey }.
 *
 * @param {object} [deps] — injected services from DSH runtime
 * @param {object} [deps.agentDefaultModel] — service exposing currentSelection()
 * @param {object} [deps.credentials]      — service exposing resolve(ref)
 */
export async function resolveDefaultModel(deps = {}) {
  // Path 1: ctx-injected agentDefaultModel
  if (deps.agentDefaultModel && typeof deps.agentDefaultModel.currentSelection === 'function') {
    try {
      const sel = deps.agentDefaultModel.currentSelection();
      const provider = sel.provider;
      const model = sel.model;
      const entry = findProviderEntry(provider);
      let apiKey = '';
      if (deps.credentials && typeof deps.credentials.resolve === 'function') {
        const r = await deps.credentials.resolve(entry.credentialRef);
        apiKey = r?.value || '';
      }
      if (!apiKey && entry.envKey) apiKey = process.env[entry.envKey] || '';
      if (!apiKey) {
        throw new Error(
          `runtime 已选中 provider=${provider}，但 ${entry.credentialRef} 未配置。` +
          `请在 ~/.dsh/.credentials.yaml 的 refs.${entry.credentialRef} 写入密钥。`,
        );
      }
      return {
        provider,
        model,
        baseUrl: process.env.DEEPSEEK_BASE_URL || entry.baseUrl,
        apiKey,
      };
    } catch (e) {
      // Fall through to env-based path on errors.
      console.warn('[dsh-ielts-examiner] agentDefaultModel path failed:', e?.message || e);
    }
  }

  // Path 2: env-based fallback (used for tests + when ctx is empty)
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
