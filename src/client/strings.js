// strings.js — i18n dictionary for the plugin UI.
//
// The plugin targets Chinese learners of IELTS writing, so v1 keeps the
// translation surface small. Per-card text (titles, buttons, hints) lives
// here so toggling the sidebar language switch actually changes what the
// user sees, instead of just highlighting a button.
//
// Adding a new language: add a key to STRINGS (mirror the zh keys), no
// other code changes needed. `t(lang)` falls back to zh when the key is
// missing or lang is unknown.

const STRINGS = {
  zh: {
    // shell
    footerGlyph: '◈',
    footerLabel: 'IELTS 写作',
    footerOpenTitle: '打开 IELTS 写作工作台',
    footerCloseTitle: '关闭 IELTS 写作工作台',
    headerTitle: 'IELTS 写作 · AI 评分工作台',
    closeBtn: '✕ 关闭',

    // sidebar
    navTitle: 'IELTS 写作',
    navSubtitle: '题目 → 作文 → AI 评分',
    newPractice: '+ 新练习',
    emptyList: '暂无练习',
    sessionCount: (n) => `共 ${n} 次练习`,
    taskSmall: '小作',
    taskBig: '大作',
    taskGeneric: '题目',
    cloneTooltip: '用同一题再来一次',
    deleteTooltip: '删除这次练习',
    deleteConfirm: '确认删除这次练习？',

    // welcome / empty state
    welcomeTitle: '欢迎使用 IELTS 写作练习',
    welcomeBody: '点左上方 "+ 新练习" 开始你的第一次练习。',

    // new practice page
    chooseQuestion: '1. 选择题目',
    questionBank: '题库',
    selectPlaceholder: '—— 请选择一道题 ——',
    taskGroup1: '── Task 1 ──',
    taskGroup2: '── Task 2 ──',
    questionHint: '从下拉里选一题，下面会显示题干和图片。',
    writeCard: '2. 写作',
    essayLabel: '把你的作文写在这里',
    essayPlaceholder: '把你的作文写在这里…',
    wordCount: (n) => `${n} 词`,
    submitScore: '提交评分',
    saving: '保存中…',
    expand: '展开',
    collapse: '收起',
    pleaseSelectQuestion: '请先选择一道题',

    // loading / failed
    loading: 'AI 考官正在批改，请稍候...',
    failedTitle: '本次评分失败。',
    retry: '重试',
    newPracticeBtn: '新练习',

    // result page
    stripTaskResponse: 'Task Response',
    stripCoherence: 'Coherence & Cohesion',
    stripLexical: 'Lexical Resource',
    stripGrammar: 'Grammatical Range',
    again: '再来一次',
    cardQuestion: '题目',
    cardStrategy: '思路解析',
    strategyTitle: '答题策略',
    keyPointsTitle: '写作重点',
    techniquesTitle: '写作技巧',
    structureTitle: '段落结构',
    cardCorrection: '批改',
    noCorrection: '(无批改)',
    grammarTitle: (n) => `语法批改（${n} 条）`,
    vocabTitle: (n) => `用词多样性（${n} 条）`,
    vocabAlt: (alts) => `（替代：${alts.join(' / ')}）`,
    cardOverall: '总体评语',
    noComment: '(无评语)',
    cardSample: '高分范文',
    untitled: '(untitled)',

    // session detail (inline summary on top of right pane)
    summaryHint: '向下滚动查看完整批改',
    summaryMeta: (title, ago, wc) => `${title} · ${ago} · ${wc} 词`,
    summaryTruncate: (s) => s + '…',

    // errors
    initError: (e) => '初始化失败：' + e,
    loadSessionError: (e) => '读取 session 失败：' + e,
    cloneError: (e) => '克隆失败：' + e,
    deleteError: (e) => '删除失败：' + e,
    scoreError: (e) => '提交评分失败：' + e,
  },

  en: {
    // shell
    footerGlyph: '◈',
    footerLabel: 'IELTS Writing',
    footerOpenTitle: 'Open the IELTS Writing workbench',
    footerCloseTitle: 'Close the IELTS Writing workbench',
    headerTitle: 'IELTS Writing · AI Scoring Workbench',
    closeBtn: '✕ Close',

    // sidebar
    navTitle: 'IELTS Writing',
    navSubtitle: 'Question → Essay → AI scoring',
    newPractice: '+ New practice',
    emptyList: 'No practices yet',
    sessionCount: (n) => (n === 1 ? '1 practice' : `${n} practices`),
    taskSmall: 'Task 1',
    taskBig: 'Task 2',
    taskGeneric: 'Question',
    cloneTooltip: 'Practice again with the same question',
    deleteTooltip: 'Delete this practice',
    deleteConfirm: 'Delete this practice?',

    // welcome / empty state
    welcomeTitle: 'IELTS Writing Practice',
    welcomeBody: 'Click "+ New practice" on the top-left to begin.',

    // new practice page
    chooseQuestion: '1. Choose question',
    questionBank: 'Question bank',
    selectPlaceholder: '—— Please choose a question ——',
    taskGroup1: '── Task 1 ──',
    taskGroup2: '── Task 2 ──',
    questionHint: 'Pick a question from the dropdown; the prompt and image show below.',
    writeCard: '2. Write',
    essayLabel: 'Write your essay here',
    essayPlaceholder: 'Write your essay here…',
    wordCount: (n) => (n === 1 ? '1 word' : `${n} words`),
    submitScore: 'Submit for scoring',
    saving: 'Saving…',
    expand: 'Expand',
    collapse: 'Collapse',
    pleaseSelectQuestion: 'Please choose a question first',

    // loading / failed
    loading: 'AI examiner is scoring, please wait...',
    failedTitle: 'This practice failed.',
    retry: 'Retry',
    newPracticeBtn: 'New practice',

    // result page
    stripTaskResponse: 'Task Response',
    stripCoherence: 'Coherence & Cohesion',
    stripLexical: 'Lexical Resource',
    stripGrammar: 'Grammatical Range',
    again: 'Practice again',
    cardQuestion: 'Question',
    cardStrategy: 'Strategy',
    strategyTitle: 'Strategy',
    keyPointsTitle: 'Key points',
    techniquesTitle: 'Techniques',
    structureTitle: 'Structure',
    cardCorrection: 'Correction',
    noCorrection: '(no correction)',
    grammarTitle: (n) => `Grammar (${n})`,
    vocabTitle: (n) => `Vocabulary (${n})`,
    vocabAlt: (alts) => `(alt: ${alts.join(' / ')})`,
    cardOverall: 'Overall comment',
    noComment: '(no comment)',
    cardSample: 'Sample essay',
    untitled: '(untitled)',

    // session detail
    summaryHint: 'Scroll down to see the full correction',
    summaryMeta: (title, ago, wc) => `${title} · ${ago} · ${wc} words`,
    summaryTruncate: (s) => s + '…',

    // errors
    initError: (e) => 'Initialization failed: ' + e,
    loadSessionError: (e) => 'Failed to load session: ' + e,
    cloneError: (e) => 'Failed to clone: ' + e,
    deleteError: (e) => 'Failed to delete: ' + e,
    scoreError: (e) => 'Failed to submit: ' + e,
  },
};

export function t(lang) {
  return STRINGS[lang] || STRINGS.zh;
}

export const SUPPORTED_LANGS = Object.keys(STRINGS);
