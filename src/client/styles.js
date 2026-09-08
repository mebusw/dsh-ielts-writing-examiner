// CSS template literal for the whole plugin. Injected once on apply().
//
// Token names mirror dsw-alias tokens used across DSH (pictor style):
//   --dsw-alias-label-primary, --dsw-alias-label-caption,
//   --dsw-alias-bg-base, --dsw-alias-bg-layer-1, --dsw-alias-bg-layer-2,
//   --dsw-alias-border-l2, --dsw-alias-state-business-primary,
//   --dsw-alias-button-floating-fill, --dsw-alias-button-floating-hover,
//   --dsw-alias-brand-primary-invert,
//   --dsw-alias-state-error, --dsw-alias-state-warning, --dsw-alias-state-success,
//   --dsw-alias-text-invert.
//
// All rules scoped under .iw-root so we don't leak.

export const STYLE = `
.iw-root { font-size: 15px; line-height: 1.55;
  color: var(--dsw-alias-label-primary, #1a1a1a); height: 100%; }
.iw-root * { box-sizing: border-box; }
.iw-root button { font: inherit; cursor: pointer; }
.iw-root input, .iw-root textarea, .iw-root select { font: inherit; color: inherit; }

/* ── footer 启动按钮 ───────────────────────────────────────── */
.iw-footer-action { cursor: pointer; padding: 7px 12px; font-size: 14px; font-weight: 600;
  color: var(--dsw-alias-label-primary); display: inline-flex; align-items: center;
  justify-content: center; gap: 7px; transition: background 150ms, color 150ms, border-color 150ms;
  border-radius: 8px; margin: 2px 8px; white-space: nowrap;
  background: var(--dsw-alias-button-floating-fill); border: 1px solid var(--dsw-alias-border-l2); }
.iw-footer-action:hover { background: var(--dsw-alias-button-floating-hover); }
.iw-footer-action .glyph { color: var(--dsw-alias-state-business-primary); font-size: 12px;
  line-height: 1; opacity: .85; }
.iw-footer-action.on { background: var(--dsw-alias-state-business-primary);
  border-color: transparent; color: var(--dsw-alias-brand-primary-invert, #fff); }
.iw-footer-action.on .glyph { color: inherit; opacity: 1; }

/* ── overlay shell ─────────────────────────────────────────── */
.iw-shell-root { position: absolute; inset: 0; z-index: 20; display: flex;
  align-items: stretch; pointer-events: none; }
.iw-shell-nav { flex: none; }
.iw-shell-panel { flex: 1; min-width: 0; height: 100%; pointer-events: auto;
  display: flex; flex-direction: column; background: var(--dsw-alias-bg-base, #f7f7f5);
  border-left: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.18)); }

/* ── 工作台分栏 ─────────────────────────────────────────────── */
.iw-workbench { display: flex; flex: 1; min-height: 0; }
.iw-nav { width: 264px; flex: none; border-right: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1, #fbfbfa); display: flex;
  flex-direction: column; overflow: hidden; }
.iw-nav-head { padding: 18px 16px 12px; display: flex; align-items: center;
  justify-content: space-between; gap: 8px; }
.iw-nav-titles { flex: 1; min-width: 0; }
.iw-nav-title { font-size: 18px; font-weight: 700; letter-spacing: -.01em; margin: 0; }
.iw-nav-sub { font-size: 13px; color: var(--dsw-alias-label-caption, #8a8a8a);
  margin: 2px 0 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.iw-nav-scroll { flex: 1; overflow-y: auto; padding: 4px 8px 16px; }
.iw-nav-row { display: flex; flex-direction: row; align-items: flex-start; gap: 8px;
  padding: 9px 10px; border-radius: 8px; cursor: pointer; position: relative; }
.iw-nav-row:hover { background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.04)); }
.iw-nav-row.on { background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.07)); }
.iw-nav-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.iw-nav-top { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1; }
.iw-nav-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; min-width: 0; flex: 1; }
.iw-nav-sub { font-size: 12px; color: var(--dsw-alias-label-caption, #8a8a8a);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  padding-left: 0; line-height: 1.4; }
.iw-nav-meta { font-size: 12px; color: var(--dsw-alias-label-caption, #8a8a8a);
  padding-left: 18px; display: flex; align-items: center; gap: 8px; }
.iw-nav-actions { display: none; gap: 4px; }
.iw-nav-row:hover .iw-nav-actions { display: flex; }
.iw-nav-foot { padding: 12px 16px; border-top: 1px solid var(--dsw-alias-border-l2);
  font-size: 12px; color: var(--dsw-alias-label-caption); display: flex; gap: 8px;
  justify-content: space-between; align-items: center; }
.iw-nav-foot button { border: 0; background: transparent; padding: 4px 8px;
  border-radius: 6px; color: inherit; }
.iw-nav-foot button:hover { background: var(--dsw-alias-bg-layer-2); }
.iw-nav-foot button.on { background: var(--dsw-alias-state-business-primary);
  color: var(--dsw-alias-brand-primary-invert, #fff); }

/* ── 主区 ────────────────────────────────────────────────────── */
.iw-main { flex: 1; min-width: 0; overflow-y: auto;
  background: var(--dsw-alias-bg-base, #f7f7f5); }
.iw-main-inner { max-width: 880px; margin: 0 auto; padding: 28px 28px 80px; }
.iw-main-inner.no-max { max-width: none; padding: 0; }
.iw-empty { text-align: center; padding: 80px 20px; color: var(--dsw-alias-label-caption); }
.iw-empty h2 { font-size: 20px; margin: 0 0 8px; color: var(--dsw-alias-label-primary); }
.iw-empty p { margin: 0 0 20px; }

/* ── card 通用 ───────────────────────────────────────────────── */
.iw-card { background: var(--dsw-alias-bg-layer-1, #fff); border-radius: 14px;
  padding: 20px 22px; margin-bottom: 18px; border: 1px solid var(--dsw-alias-border-l2);
  box-shadow: 0 1px 2px rgba(0,0,0,.02); }
.iw-card h3 { font-size: 16px; font-weight: 700; margin: 0 0 12px; letter-spacing: -.01em; }
.iw-card .iw-collapse-toggle { display: inline-block; margin-top: 10px;
  font-size: 13px; color: var(--dsw-alias-state-business-primary); cursor: pointer;
  border: 0; background: transparent; padding: 0; }

/* ── form 控件 ───────────────────────────────────────────────── */
.iw-field { display: block; margin-bottom: 12px; }
.iw-field label { display: block; font-size: 13px; font-weight: 600;
  margin-bottom: 8px; color: var(--dsw-alias-label-primary); }
.iw-field label .iw-counter { font-weight: 400; color: var(--dsw-alias-label-caption);
  margin-left: 10px; }
.iw-select, .iw-textarea { width: 100%; padding: 10px 12px; border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base, #fff); color: inherit;
  transition: border-color 120ms; }
.iw-select:focus, .iw-textarea:focus { outline: none; border-color: var(--dsw-alias-state-business-primary); }
.iw-textarea { font-family: inherit; resize: vertical; min-height: 200px; line-height: 1.6; }

/* ── 按钮 ────────────────────────────────────────────────────── */
.iw-btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px;
  border-radius: 10px; font-size: 14px; font-weight: 600; border: 1px solid transparent;
  transition: filter 120ms, background 120ms; }
.iw-btn-primary { background: var(--dsw-alias-state-business-primary, #4f7cff);
  color: var(--dsw-alias-brand-primary-invert, #fff); }
.iw-btn-primary:hover { filter: brightness(.95); }
.iw-btn-primary:disabled { opacity: .5; cursor: not-allowed; }
.iw-btn-ghost { background: transparent;
  border-color: var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-primary); }
.iw-btn-ghost:hover { background: var(--dsw-alias-bg-layer-2); }
.iw-btn-tiny { padding: 3px 7px; font-size: 12px; border-radius: 6px; }
.iw-btn.on { background: var(--dsw-alias-state-business-primary, #4f7cff);
  color: var(--dsw-alias-brand-primary-invert, #fff);
  border-color: transparent; }
.iw-btn.on:hover { filter: brightness(.95); }

/* ── 评分条 / 状态点 ──────────────────────────────────────────── */
.iw-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex: none; }
.iw-dot.idle { background: #b0b0b0; }
.iw-dot.running { background: #f59e0b; animation: iw-pulse 1.2s ease-in-out infinite; }
.iw-dot.done { background: #22c55e; }
.iw-dot.failed { background: #ef4444; }
@keyframes iw-pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }

.iw-infobar { display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
  margin-bottom: 22px; padding: 4px 4px 0; }
.iw-infobar h2 { font-size: 22px; font-weight: 700; margin: 0; flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.iw-badge { display: inline-flex; align-items: center; justify-content: center;
  min-width: 48px; height: 36px; padding: 0 14px; border-radius: 10px;
  font-size: 22px; font-weight: 700; color: #fff; }
.iw-badge.b-high { background: #16a34a; }
.iw-badge.b-mid { background: #f59e0b; }
.iw-badge.b-low { background: #ef4444; }
.iw-strip { display: grid; grid-template-columns: repeat(4, 1fr);
  gap: 10px; margin-bottom: 22px; }
.iw-strip-cell { padding: 14px 12px; border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1, #fff);
  border: 1px solid var(--dsw-alias-border-l2); }
.iw-strip-cell .iw-strip-label { font-size: 12px; color: var(--dsw-alias-label-caption);
  margin-bottom: 6px; }
.iw-strip-cell .iw-strip-score { font-size: 24px; font-weight: 700; }
@media (max-width: 700px) { .iw-strip { grid-template-columns: repeat(2, 1fr); } }

/* ── 加载视图 ─────────────────────────────────────────────────── */
.iw-loading { display: flex; flex-direction: column; align-items: center;
  justify-content: center; padding: 100px 20px; color: var(--dsw-alias-label-caption); }
.iw-spinner { font-size: 42px; color: var(--dsw-alias-state-business-primary);
  animation: iw-spin 1.4s linear infinite; line-height: 1; margin-bottom: 14px; }
@keyframes iw-spin { to { transform: rotate(360deg); } }

/* ── markdown 渲染区 ─────────────────────────────────────────── */
.iw-md { word-wrap: break-word; overflow-wrap: anywhere; }
.iw-md h1, .iw-md h2, .iw-md h3 { font-weight: 700; margin: 1.4em 0 .6em; line-height: 1.3; }
.iw-md h1 { font-size: 1.5em; }
.iw-md h2 { font-size: 1.25em; }
.iw-md h3 { font-size: 1.1em; }
.iw-md p { margin: 0 0 .9em; }
.iw-md ul, .iw-md ol { padding-left: 1.4em; margin: 0 0 .9em; }
.iw-md li { margin: .25em 0; }
.iw-md code { background: var(--dsw-alias-bg-layer-2); padding: 1px 6px; border-radius: 4px;
  font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: .9em; }
.iw-md pre { background: var(--dsw-alias-bg-layer-2); padding: 14px 16px; border-radius: 10px;
  overflow-x: auto; font-size: 13px; line-height: 1.5; }
.iw-md pre code { background: transparent; padding: 0; }
.iw-md blockquote { border-left: 3px solid var(--dsw-alias-border-l2);
  padding-left: 14px; margin: 0 0 .9em; color: var(--dsw-alias-label-caption); }
.iw-md del { color: #b91c1c; text-decoration: line-through; }
.iw-md ins { color: #15803d; background: #dcfce7; text-decoration: none; padding: 0 2px; border-radius: 3px; }
.iw-md mark { background: #dbeafe; color: #1e3a8a; padding: 0 2px; border-radius: 3px; }
.iw-md table { border-collapse: collapse; width: 100%; margin: 0 0 .9em; font-size: 14px; }
.iw-md th, .iw-md td { border: 1px solid var(--dsw-alias-border-l2); padding: 6px 10px; text-align: left; }
.iw-md .iw-mermaid { background: var(--dsw-alias-bg-layer-1); border-radius: 10px;
  padding: 16px; text-align: center; margin: 0 0 .9em; overflow-x: auto; }
.iw-md .iw-mermaid-error { color: #b91c1c; font-size: 13px; font-family: ui-monospace, monospace;
  white-space: pre-wrap; }

/* ── 错误条 ──────────────────────────────────────────────────── */
.iw-error { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca;
  border-radius: 10px; padding: 10px 14px; margin: 12px 0; font-size: 14px; }

/* ── SessionDetail (侧栏点开的 inline 摘要) ──────────────────── */
.iw-summary { background: linear-gradient(180deg, var(--dsw-alias-bg-layer-2, rgba(0,0,0,.03)) 0%, transparent 100%);
  border-radius: 14px; padding: 16px 20px; margin-bottom: 18px;
  border: 1px dashed var(--dsw-alias-border-l2); }
.iw-summary-meta { font-size: 13px; color: var(--dsw-alias-label-caption); margin-bottom: 6px; }
.iw-summary-title { font-size: 15px; font-weight: 600; margin-bottom: 6px; }
.iw-summary-hint { font-size: 12px; color: var(--dsw-alias-label-caption); margin-top: 8px; }
.iw-summary-review { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
.iw-summary-review details { border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px; padding: 6px 10px; background: var(--dsw-alias-bg-layer-1, #fff); }
.iw-summary-review details + details { margin-top: 0; }
.iw-summary-review summary { cursor: pointer; font-weight: 600; font-size: 13px;
  color: var(--dsw-alias-label-primary); padding: 2px 0; }
.iw-essay-text { white-space: pre-wrap; word-wrap: break-word;
  font-family: inherit; font-size: 13px; line-height: 1.7;
  background: var(--dsw-alias-bg-layer-2, #f5f5f4);
  padding: 10px 12px; border-radius: 6px; margin: 6px 0 0; max-height: 360px;
  overflow: auto; }
.iw-pdf-meta { font-size: 13px; color: var(--dsw-alias-label-caption, #8a8a8a);
  margin: 0 0 8px; }
.iw-question-images { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
.iw-question-images img { max-width: 100%; height: auto; border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l2); }

/* ── 移动端 ──────────────────────────────────────────────────── */
@media (max-width: 700px) {
  .iw-nav { width: 220px; }
  .iw-main-inner { padding: 18px 14px 60px; }
  .iw-strip { grid-template-columns: repeat(2, 1fr); }
}

/* PDF 导出专用样式：注入到打印 DOM 时使用 */
.iw-pdf-render { font-size: 14px; line-height: 1.6;
  color: #1a1a1a; background: #fff; padding: 24px;
  page-break-after: always; }
.iw-pdf-render * { color: #1a1a1a !important; background: transparent; }
.iw-pdf-render h1 { font-size: 22px; margin: 0 0 12px; }
.iw-pdf-render h2 { font-size: 17px; margin: 16px 0 8px;
  page-break-after: avoid; }
.iw-pdf-render h3 { font-size: 15px; margin: 12px 0 6px; }
.iw-pdf-render p, .iw-pdf-render li { color: #1a1a1a; }
.iw-pdf-render .iw-md code, .iw-pdf-render .iw-md pre { background: #f5f5f4; color: #1a1a1a; }
.iw-pdf-render .iw-md del { color: #b91c1c; }
.iw-pdf-render .iw-md ins { color: #15803d; background: #dcfce7; }
.iw-pdf-render .iw-md mark { color: #1e3a8a; background: #dbeafe; }
.iw-pdf-render .iw-pdf-section { margin-bottom: 18px;
  padding-bottom: 12px; border-bottom: 1px solid #eee; }
/* Per-card page-break-inside: avoid was making huge cards (批改 + 思路解析)
   overflow a single page, then jsPDF painted all subsequent cards on top of
   each other on the next page. Let the renderer break naturally instead. */
.iw-pdf-render .iw-pdf-pagebreak { page-break-before: always; break-before: page;
  height: 1px; }
/* 作文原文：&lt;pre&gt; 默认 white-space:pre 不换行，会被页面右边裁掉 */
.iw-pdf-render .iw-pdf-essay-text { white-space: pre-wrap; word-wrap: break-word;
  font-family: inherit; font-size: 13px; line-height: 1.7;
  background: var(--dsw-alias-bg-layer-2, #f5f5f4);
  padding: 12px 14px; border-radius: 8px; margin: 0; }
/* mermaid 在 detached wrapper 里常常 width 坍缩成 0;强制 block+max-width */
.iw-pdf-render .iw-mermaid { display: block; }
.iw-pdf-render .iw-mermaid svg { display: block; max-width: 100%; height: auto;
  margin: 0 auto; }
`;
