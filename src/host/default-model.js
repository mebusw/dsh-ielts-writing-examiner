// default-model.ts → default-model.js (no TS toolchain needed).
//
// Reads DSH runtime's agent-default-model from ~/.dsh/settings.yaml, mirrors
// pomasa-studio/src/host/apply.js#defaultModel. Returns
//   { provider, model, baseUrl, apiKey }
// or null when not configured (caller surfaces a clean error).

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Provider → { baseUrl, defaultModel, envKey }
// Extend as new providers appear in DSH runtime.
const PROVIDERS = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    envKey: 'DEEPSEEK_API_KEY',
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    envKey: 'OPENAI_API_KEY',
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-3-5-sonnet-latest',
    envKey: 'ANTHROPIC_API_KEY',
  },
  moonshot: {
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    envKey: 'MOONSHOT_API_KEY',
  },
  qwen: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    envKey: 'DASHSCOPE_API_KEY',
  },
  doubao: {
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3/v1',
    defaultModel: 'doubao-pro-32k',
    envKey: 'ARK_API_KEY',
  },
  // OpenAI-compatible escape hatch — user supplies baseUrl + model explicitly.
  openai_compatible: {
    baseUrl: '',
    defaultModel: '',
    envKey: '',
  },
};

/** Parse `agent-default-model:` block from ~/.dsh/settings.yaml. */
function readAgentDefaultModel() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const p = join(home, 'settings.yaml');
  if (!existsSync(p)) return null;
  let txt;
  try { txt = readFileSync(p, 'utf8'); } catch { return null; }
  const block = txt.match(/agent-default-model:\s*\n((?:[ \t].*\n)*)/);
  if (!block) return null;
  let model = null;
  let provider = null;
  let baseUrlOverride = null;
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
 * Tries (in order):
 *   1. agent-default-model from DSH settings.yaml + matching env var
 *   2. any of PROVIDERS env keys present in process.env (fall back to deepseek)
 *
 * Throws a clear error when neither yields a usable config.
 */
export function resolveDefaultModel() {
  const pref = readAgentDefaultModel();
  const candidates = [];
  if (pref) candidates.push(pref);
  // Fallback: scan providers for one whose env key is set.
  for (const [name, cfg] of Object.entries(PROVIDERS)) {
    if (cfg.envKey && process.env[cfg.envKey]) {
      candidates.push({ provider: name, model: cfg.defaultModel });
    }
  }

  let chosen = null;
  for (const c of candidates) {
    const cfg = PROVIDERS[c.provider];
    if (!cfg) continue;
    const apiKey = cfg.envKey ? process.env[cfg.envKey] : '';
    if (!apiKey && c.provider !== 'openai_compatible') continue;
    chosen = {
      provider: c.provider,
      model: c.model || cfg.defaultModel,
      baseUrl: c.baseUrlOverride || cfg.baseUrl,
      apiKey,
    };
    break;
  }

  if (!chosen) {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh');
    throw new Error(
      `未配置默认模型。请在 ${home}/settings.yaml 的 agent-default-model 块写入 ` +
      `model/provider，并设置对应 provider 的环境变量（如 DEEPSEEK_API_KEY）。`
    );
  }
  return chosen;
}
