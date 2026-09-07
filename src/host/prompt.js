// prompt.ts → prompt.js
//
// Assembles system + user message for one IELTS scoring call. System is the
// compressed prompt from ~/.ielts-examiner/prompts/ (seeded on first run).
// User is the question + essay + optional persona tag.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function safeImageUrls(images, assetBase) {
  if (!Array.isArray(images) || images.length === 0) return '';
  return images
    .filter((p) => typeof p === 'string' && /^images-for-task1\//.test(p))
    .map((p) => `![题目图片](${assetBase}/${p})`)
    .join('\n\n');
}

// Trailing instructions appended after the system prompt + question +
// essay block. Forces minimum content counts (so the LLM produces rich
// output instead of one-line stubs) and a clear output template.
const OUTPUT_ENFORCEMENT = `

# 输出强制要求（必须遵守，违反任何一条都视为不合格）

## JSON 字段最小数量
- correction.originalEssay: 学生原文，原样保留（含换行）
- correction.annotatedEssayHtml: **必须**有 <del>/<ins>/<mark> 标注覆盖至少 3 处不同词或短语
- correction.grammarHighlights: 数组，**至少 3 条**，每条 {phrase, comment}
- correction.grammarFixes: 数组，**至少 8 条**，每条 {phrase, suggestion, reason}
- correction.cohesionAnalysis: 数组，**至少 3 条**，每条 {phrase, comment}
- correction.vocabularyDiversity: 数组，**至少 3 条**，每条 {phrase, comment, alternatives: 至少 1 个真实可用的同义词}
- correction.criteriaScores: 四项均**必须**填满 score / reason / examples(至少 1 个) / improvement
- correction.overallComment: **至少 3 句**，不少于 80 个汉字
- correction.overallBand: 0.0–9.0，0.5 步进
- analysis: 即使本次主要是评分，也**必须**填 taskType + strategy + keyPoints(≥3) + techniques(≥2)
- sampleEssay: 不强求；如果能写出 8 分范文则填，否则填空字符串

## 输出格式（参考，但以 JSON 为准）
\`\`\`
## 题目
WRITING TASK ...
## 总体评价
**整体得分**: X.X
**考官评语**: ...
## 分项评价
- Task Response: ...
- Coherence and Cohesion: ...
- Lexical Resource: ...
- Grammatical Range: ...
## 答题策略分析
...
## 语法批改
### 亮点
### 错误纠正
### 连接词分析
### 重复词分析
## 用颜色标注的作文
（含 <del> <ins> <mark> 标签）
## 高分范文
（可选）
\`\`\`

**再次强调**：最终输出必须是合法 JSON（以 { 开头、} 结尾），所有字段齐全，数量达标，不要 JSON 之外的纯文本。`;

export function buildScorePrompt({ dataRoot, question, essay, teacher, assetBase }) {
  const promptPath = join(dataRoot, 'prompts', '雅思写作.compressed.prompt.md');
  const system = readFileSync(promptPath, 'utf8');
  const personaLine = teacher ? `\n<persona>你现在的语气是 ${teacher}老师。</persona>\n` : '';
  const imgBlock = safeImageUrls(question.images, assetBase);
  const user = [
    `题目：${question.title}`,
    '',
    question.body || '',
    imgBlock ? `\n${imgBlock}` : '',
    '',
    '---',
    '学生作文：',
    essay,
    '---',
    '',
    `${personaLine}请严格按照 schema 输出 JSON。${OUTPUT_ENFORCEMENT}`,
  ].join('\n');
  return `${system}\n\n${user}`;
}
