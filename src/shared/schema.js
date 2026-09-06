// Shared schema (runtime validation for LLM JSON output).
//
// Mirror of compressed prompt §"JSON 输出 schema" (§ 9 of migration guide).
// Used by host llm.ts to validate parsed model output before persisting to
// result.json; client does not import this file (it works off the data shape
// directly). Keeping it as .js so the host bundle does not need a TS toolchain
// in production — types live in comments.

/**
 * @typedef {Object} CriterionScore
 * @property {number} score                 0-9 integer
 * @property {string} reason
 * @property {string[]} examples
 * @property {string} improvement
 *
 * @typedef {Object} Correction
 * @property {string} originalEssay
 * @property {string} annotatedEssayHtml
 * @property {{phrase:string,comment:string}[]} grammarHighlights
 * @property {{phrase:string,suggestion:string,reason:string}[]} grammarFixes
 * @property {{phrase:string,comment:string}[]} cohesionAnalysis
 * @property {{phrase:string,comment:string,alternatives:string[]}}[] vocabularyDiversity
 * @property {{taskResponse:CriterionScore, coherenceCohesion:CriterionScore, lexicalResource:CriterionScore, grammaticalRange:CriterionScore}} criteriaScores
 * @property {string} overallComment
 * @property {number} overallBand           0.0-9.0, 0.5 step
 *
 * @typedef {Object} Analysis
 * @property {"Task1"|"Task2"} taskType
 * @property {string} questionType
 * @property {string} topic
 * @property {string|null} imageDescription
 * @property {string} strategy
 * @property {string[]} keyPoints
 * @property {string} mermaidDiagram
 * @property {string[]} techniques
 *
 * @typedef {Object} ScoreResult
 * @property {string|null} matchedTask
 * @property {string|null} taskSource
 * @property {Analysis} analysis
 * @property {Correction} correction
 * @property {string} sampleEssay
 */

function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }

/**
 * Light-weight runtime validator. Returns { ok: true, value } or
 * { ok: false, error }. Keeps the LLM failure mode loud (no silent partial data).
 */
export function validateScoreResult(input) {
  if (!isObj(input)) return { ok: false, error: 'root not object' };
  const c = input.correction;
  if (!isObj(c)) return { ok: false, error: 'correction missing' };
  const cs = c.criteriaScores;
  if (!isObj(cs)) return { ok: false, error: 'criteriaScores missing' };
  for (const k of ['taskResponse', 'coherenceCohesion', 'lexicalResource', 'grammaticalRange']) {
    if (!isObj(cs[k]) || typeof cs[k].score !== 'number') {
      return { ok: false, error: `criteriaScores.${k}.score missing` };
    }
  }
  if (typeof c.overallBand !== 'number') return { ok: false, error: 'overallBand missing' };
  return { ok: true, value: input };
}
