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
    `${personaLine}请严格按照 schema 输出 JSON。`,
  ].join('\n');
  return `${system}\n\n${user}`;
}
