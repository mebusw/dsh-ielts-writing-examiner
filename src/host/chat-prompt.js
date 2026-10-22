// chat-prompt.js — assembles the system prompt + provider-neutral message
// history for the bottom chat box (feature added in 1.3.0).
//
// The chat is one continuous conversation per practice session (`~/.ielts-exam
// chats/<key>.json`). Every turn the client also sends a snapshot of what the
// student is looking at (screen, question, essay, correction summary); this file
// folds that snapshot into one compact system prompt and appends the current
// user turn (with any quoted fragments) as the last user message.
//
// Everything is capped here, not in the route: a pasted correction or a very
// long essay must never push the model over its context window.

const CAPS = {
  questionTitle: 200,
  questionBody: 4000,
  essay: 8000,
  quote: 1000,
  quotes: 3,
  historyMessages: 24,
  historyContent: 6000,
  overallComment: 2000,
  strategy: 1500,
  fixField: 300,
  grammarFixes: 20,
  vocabulary: 15,
  keyPoints: 12,
  criterionReason: 800,
  text: 8000,
};

const SURFACES = new Set(['empty', 'new', 'writing', 'loading', 'result', 'failed']);

const SURFACE_LABEL = {
  zh: {
    empty: '工作台首页（还没开始练习）',
    new: '新练习页：正在选题/写作',
    writing: '写作页：作文已自动保存，尚未评分',
    loading: '评分进行中',
    failed: '评分失败页',
    result: '作文批改结果页',
  },
  en: {
    empty: 'Workbench home (no practice started yet)',
    new: 'New practice screen: choosing a question / writing',
    writing: 'Writing screen: draft auto-saved, not scored yet',
    loading: 'Scoring in progress',
    failed: 'Scoring failed screen',
    result: 'Essay correction result page',
  },
};

export function clipText(value, max) {
  const s = String(value ?? '');
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Chat thread keys are session ids (12 lowercase alnum) or `draft`. */
export function sanitizeKey(key) {
  if (typeof key !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(key)) {
    throw new Error('chat: invalid key (expected a session id or "draft")');
  }
  return key;
}

/** One new user turn: required, trimmed, capped. */
export function sanitizeUserText(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('chat: text required');
  }
  const s = text.trim();
  if (s.length > CAPS.text) throw new Error(`chat: text too long (max ${CAPS.text} chars)`);
  return s;
}

/** Selections quoted from the page: keep the newest three, dedupe exact copies. */
export function sanitizeQuotes(quotes) {
  if (!Array.isArray(quotes)) return [];
  const out = [];
  for (const raw of quotes) {
    if (typeof raw !== 'string') continue;
    const q = raw.replace(/\s+/g, ' ').trim();
    if (!q) continue;
    const clipped = clipText(q, CAPS.quote);
    if (out.includes(clipped)) continue;
    out.push(clipped);
    if (out.length >= CAPS.quotes) break;
  }
  return out;
}

/** Trim the persisted history to the last N valid turns; content is capped. */
export function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  const rows = [];
  for (const m of history) {
    if (!m || typeof m !== 'object') continue;
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const content = clipText(typeof m.content === 'string' ? m.content : '', CAPS.historyContent).trim();
    if (!content) continue;
    const row = { role: m.role, content };
    if (m.role === 'user') {
      const quotes = sanitizeQuotes(m.quotes);
      if (quotes.length) row.quotes = quotes;
    }
    rows.push(row);
  }
  return rows.slice(-CAPS.historyMessages);
}

function sanitizeCriterion(value) {
  if (!value || typeof value !== 'object') return null;
  const score = typeof value.score === 'number' && Number.isFinite(value.score) ? value.score : null;
  const reason = clipText(value.reason || value.note || '', CAPS.criterionReason);
  if (score === null && !reason) return null;
  return { score, reason };
}

function sanitizeResult(result) {
  if (!result || typeof result !== 'object') return null;
  const cs = result.criteriaScores && typeof result.criteriaScores === 'object' ? result.criteriaScores : {};
  const criteriaScores = {};
  for (const k of ['taskResponse', 'coherenceCohesion', 'lexicalResource', 'grammaticalRange']) {
    const c = sanitizeCriterion(cs[k]);
    if (c) criteriaScores[k] = c;
  }
  const grammarFixes = (Array.isArray(result.grammarFixes) ? result.grammarFixes : [])
    .filter((g) => g && typeof g === 'object' && (g.phrase || g.suggestion))
    .slice(0, CAPS.grammarFixes)
    .map((g) => ({
      phrase: clipText(g.phrase, CAPS.fixField),
      suggestion: clipText(g.suggestion, CAPS.fixField),
      reason: clipText(g.reason, CAPS.fixField),
    }));
  const vocabularyDiversity = (Array.isArray(result.vocabularyDiversity) ? result.vocabularyDiversity : [])
    .filter((v) => v && typeof v === 'object' && v.phrase)
    .slice(0, CAPS.vocabulary)
    .map((v) => ({
      phrase: clipText(v.phrase, CAPS.fixField),
      comment: clipText(v.comment, CAPS.fixField),
      alternatives: (Array.isArray(v.alternatives) ? v.alternatives : [])
        .filter((a) => typeof a === 'string' && a.trim())
        .slice(0, 5)
        .map((a) => clipText(a, 80)),
    }));
  return {
    overallBand: typeof result.overallBand === 'number' && Number.isFinite(result.overallBand)
      ? result.overallBand
      : null,
    criteriaScores,
    overallComment: clipText(result.overallComment, CAPS.overallComment),
    grammarFixes,
    vocabularyDiversity,
    strategy: clipText(result.strategy, CAPS.strategy),
    keyPoints: (Array.isArray(result.keyPoints) ? result.keyPoints : [])
      .filter((p) => typeof p === 'string' && p.trim())
      .slice(0, CAPS.keyPoints)
      .map((p) => clipText(p, CAPS.fixField)),
  };
}

/** Cap + normalize the client's context snapshot. Never throws. */
export function sanitizeContext(context) {
  const c = context && typeof context === 'object' ? context : {};
  const q = c.question && typeof c.question === 'object'
    ? {
      title: clipText(c.question.title, CAPS.questionTitle),
      body: clipText(c.question.body, CAPS.questionBody),
      task: clipText(c.question.task, 8),
      type: clipText(c.question.type, 80),
    }
    : null;
  return {
    surface: SURFACES.has(c.surface) ? c.surface : 'new',
    question: q && (q.title || q.body) ? q : null,
    essay: clipText(c.essay, CAPS.essay),
    result: sanitizeResult(c.result),
  };
}

function resultLines(result, lang) {
  if (!result) return [];
  const isEn = lang === 'en';
  const out = [];
  const cs = result.criteriaScores || {};
  const labels = {
    taskResponse: 'Task Response',
    coherenceCohesion: 'Coherence & Cohesion',
    lexicalResource: 'Lexical Resource',
    grammaticalRange: 'Grammatical Range',
  };
  const overall = result.overallBand === null ? '—' : result.overallBand.toFixed(1);
  out.push(`${isEn ? 'Overall band' : '总分'}: ${overall}`);
  for (const [key, label] of Object.entries(labels)) {
    const c = cs[key];
    if (!c) continue;
    out.push(`- ${label}: ${c.score === null ? '—' : c.score}${c.reason ? ` — ${c.reason}` : ''}`);
  }
  if (result.overallComment) {
    out.push(`${isEn ? 'Examiner comment' : '总体评语'}: ${result.overallComment}`);
  }
  if (result.grammarFixes?.length) {
    out.push(isEn ? 'Grammar fixes:' : '语法批改:');
    for (const g of result.grammarFixes) {
      out.push(`- ${g.phrase || '—'} → ${g.suggestion || '—'}${g.reason ? ` (${g.reason})` : ''}`);
    }
  }
  if (result.vocabularyDiversity?.length) {
    out.push(isEn ? 'Vocabulary suggestions:' : '用词建议:');
    for (const v of result.vocabularyDiversity) {
      const alts = v.alternatives?.length ? ` [${v.alternatives.join(' / ')}]` : '';
      out.push(`- ${v.phrase}: ${v.comment}${alts}`);
    }
  }
  if (result.strategy) out.push(`${isEn ? 'Strategy' : '答题策略'}: ${result.strategy}`);
  if (result.keyPoints?.length) {
    out.push(`${isEn ? 'Key points' : '写作重点'}: ${result.keyPoints.join('; ')}`);
  }
  return out;
}

/**
 * System prompt for one chat turn.
 *
 * @param {{ lang?: 'zh'|'en', context?: object }} opts
 * @returns {string}
 */
export function buildChatSystemPrompt({ lang, context } = {}) {
  const L = lang === 'en' ? 'en' : 'zh';
  const isEn = L === 'en';
  const ctx = sanitizeContext(context);
  const lines = [];

  if (isEn) {
    lines.push(
      'You are an experienced IELTS writing examiner and tutor, talking with a student inside a writing-practice app.',
      '',
      'How to answer:',
      '- Answer the student\'s actual question directly and concretely, in Markdown (short paragraphs, bullet lists where useful).',
      '- Use the question / essay / correction context below when it is relevant. Never invent essay text, scores, criteria comments or corrections that are not present in the context.',
      '- If the student quoted a fragment, locate and interpret that fragment in the essay or in the correction, explain what it means and why the examiner said it. If a judgement is debatable, say so and back it with evidence from the essay.',
      '- Be precise about band descriptors and language; when suggesting a rewrite, show the original and the improved version.',
      '- Keep the reply focused (normally under 400 English words) unless the student asks for a full rewrite or a long explanation.',
      '- Reply in the same language the student used in the current message (default English).',
    );
    lines.push('', `Current screen: ${SURFACE_LABEL.en[ctx.surface]}`);
    if (ctx.question) {
      lines.push('', 'Writing question:');
      lines.push(`- Title: ${ctx.question.title || '—'}`);
      if (ctx.question.task) lines.push(`- Task: ${ctx.question.task}`);
      if (ctx.question.type) lines.push(`- Type: ${ctx.question.type}`);
      if (ctx.question.body) lines.push(`- Prompt: ${ctx.question.body}`);
    }
    if (ctx.essay) {
      lines.push('', 'Student essay (as written):', '"""', ctx.essay, '"""');
    } else {
      lines.push('', 'Student essay: (not written / not submitted yet)');
    }
    if (ctx.result) {
      lines.push('', 'AI correction result (the student is looking at this):');
      lines.push(...resultLines(ctx.result, L));
      lines.push(
        '',
        'The correction result above is the examiner\'s output. Treat it as the artefact under discussion, not as unquestionable truth: explain it, and disagree with it with reasons if the student challenges it and the essay supports them.',
      );
    } else {
      lines.push('', 'AI correction result: (this practice has not been scored yet)');
    }
  } else {
    lines.push(
      '你是一位经验丰富的雅思写作考官兼写作助教，正在一个雅思写作练习插件里和学生对话。',
      '',
      '回答要求：',
      '- 直接、具体地回答学生真正问的问题，用 Markdown 组织（短段落、必要时用列表）。',
      '- 结合下面的题目 / 学生作文 / 批改结果来回答；绝不能编造上下文里没有的作文内容、分数、评分项评语或语法批改。',
      '- 如果学生引用了某段文字，先在作文或批改结果里定位这段文字，解释它在这篇作文/这次批改里的含义以及考官为什么这么说；如果这个判断本身有争议，就说明争议点并用作文里的证据解释。',
      '- 涉及评分标准或语言点时要说准确；给修改建议时同时给出原句和改写后的版本。',
      '- 回答聚焦（一般不超过 400 字），除非学生明确要求整篇重写或长篇解释。',
      '- 用学生当前提问所用的语言回答（默认中文）。',
    );
    lines.push('', `当前界面：${SURFACE_LABEL.zh[ctx.surface]}`);
    if (ctx.question) {
      lines.push('', '写作题目：');
      lines.push(`- 标题：${ctx.question.title || '—'}`);
      if (ctx.question.task) lines.push(`- 任务：Task ${ctx.question.task}`);
      if (ctx.question.type) lines.push(`- 类型：${ctx.question.type}`);
      if (ctx.question.body) lines.push(`- 题干：${ctx.question.body}`);
    }
    if (ctx.essay) {
      lines.push('', '学生作文（原文）：', '"""', ctx.essay, '"""');
    } else {
      lines.push('', '学生作文：（尚未写作或尚未提交）');
    }
    if (ctx.result) {
      lines.push('', 'AI 批改结果（学生当前正在看这份结果）：');
      lines.push(...resultLines(ctx.result, L));
      lines.push(
        '',
        '上面的批改结果是考官的输出。把它当作「正在讨论的对象」而不是不可质疑的真理：解释它；如果学生提出异议且作文确实支持学生的观点，也可以指出考官判断可能有问题并给出理由。',
      );
    } else {
      lines.push('', 'AI 批改结果：（这次练习还没有评分）');
    }
  }

  return lines.join('\n');
}

function quoteBlock(quotes, lang) {
  const isEn = lang === 'en';
  return quotes
    .map((q, i) => (isEn ? `[Quote ${i + 1}]\n${q}` : `【引用 ${i + 1}】\n${q}`))
    .join('\n\n');
}

/**
 * Provider-neutral messages array for the `llm` service.
 *
 * Historical assistant turns get no `source` here — the dispatcher must call
 * `attachAssistantSources()` once the target provider/model is resolved,
 * because both DSH adapters read `source` on assistant messages.
 *
 * @param {{ history?: object[], text: string, quotes?: string[], lang?: 'zh'|'en' }} opts
 * @returns {Array<{role: 'user'|'assistant', content: Array<{type:'text',text:string}>}>}
 */
export function buildChatMessages({ history, text, quotes, lang } = {}) {
  const L = lang === 'en' ? 'en' : 'zh';
  const isEn = L === 'en';
  const out = [];
  for (const m of sanitizeHistory(history)) {
    const heads = [];
    if (m.role === 'user' && m.quotes?.length) heads.push(quoteBlock(m.quotes, L));
    heads.push(m.content);
    out.push({
      role: m.role,
      content: [{ type: 'text', text: heads.filter(Boolean).join('\n\n') }],
    });
  }
  const cleanQuotes = sanitizeQuotes(quotes);
  const parts = [];
  if (cleanQuotes.length) parts.push(quoteBlock(cleanQuotes, L));
  parts.push(`${isEn ? '[My question]' : '【我的问题】'}\n${text}`);
  out.push({ role: 'user', content: [{ type: 'text', text: parts.join('\n\n') }] });
  return out;
}

/**
 * The DSH adapters (`dsh-llm-deepseek` / `dsh-llm-pi-ai`) project assistant
 * history through `message.source`; a hand-built assistant message without one
 * throws inside the adapter. Tag them with the resolved target.
 */
export function attachAssistantSources(messages, provider, model) {
  if (typeof provider !== 'string' || typeof model !== 'string') return messages;
  return messages.map((m) => (m.role === 'assistant'
    ? { ...m, source: { kind: 'model', provider, model } }
    : m));
}

export const CHAT_LIMITS = CAPS;
