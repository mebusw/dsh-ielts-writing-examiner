// pages.js — factory(React, h, c) returns { Root, Nav, NewPractice, Loading, Result, SessionDetail }.
//
// c = { iwCard, iwBtn, iwBadge, iwDot, iwField, iwSelect, iwTextarea, iwSpinner }
// All pages are function components (no JSX, no class). State is held in Root.
// React is threaded through so Root can call useState/useEffect/useRef (those
// names must resolve to the React instance from the ModuleLoader's require('react')).

import { renderMarkdown, renderMermaidIn } from './md.js';
import { t } from './strings.js';
// import { exportNodeToPdf } from './export-pdf.js';  // 暂时隐藏，恢复时打开

export function createPages(React, h, c) {
  const { useState, useEffect, useRef, useCallback } = React;
  const { iwCard, iwBtn, iwBadge, iwDot, iwField, iwSelect, iwTextarea, iwSpinner } = c;

  function wordCount(text) {
    return String(text || '').trim() ? String(text).trim().split(/\s+/).length : 0;
  }

  // timeAgo strings live inline in a tiny helper so the rest of the file
  // doesn't have to thread lang through. Both languages are tiny.
  function timeAgo(ts, lang) {
    if (!ts) return '';
    const d = Math.floor((Date.now() - ts) / 1000);
    if (lang === 'en') {
      if (d < 60) return d === 1 ? '1 second ago' : `${d} seconds ago`;
      if (d < 3600) {
        const m = Math.floor(d / 60);
        return m === 1 ? '1 minute ago' : `${m} minutes ago`;
      }
      if (d < 86400) {
        const h = Math.floor(d / 3600);
        return h === 1 ? '1 hour ago' : `${h} hours ago`;
      }
      const days = Math.floor(d / 86400);
      if (days < 30) return days === 1 ? '1 day ago' : `${days} days ago`;
      const date = new Date(ts);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }
    if (d < 60) return `${d}秒前`;
    if (d < 3600) return `${Math.floor(d / 60)}分钟前`;
    if (d < 86400) return `${Math.floor(d / 3600)}小时前`;
    const days = Math.floor(d / 86400);
    if (days < 30) return `${days}天前`;
    const date = new Date(ts);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  // Sidebar subtitle for a session row: task · (score) · time.
  // - task type always shows for any session (small / big essay)
  // - score only when status === 'done' and overallBand is set
  // - time is completedAt when available, else createdAt
  function navSubtitle(s, lang) {
    if (!s) return '';
    const T = t(lang);
    const parts = [];
    if (s.task === '1') parts.push(T.taskSmall);
    else if (s.task === '2') parts.push(T.taskBig);
    else if (s.questionId) parts.push(T.taskGeneric);
    if (s.status === 'done' && typeof s.overallBand === 'number') {
      parts.push(s.overallBand.toFixed(1));
    }
    const ts = s.completedAt || s.createdAt;
    if (ts) parts.push(timeAgo(ts, lang));
    return parts.join(' · ');
  }

  // ────────────────────────────────────────────────────────────────
  // Nav — 264px left column. Auto-refresh every 3s.
  // ────────────────────────────────────────────────────────────────
  function Nav({ sessions, activeId, onSelect, onNew, onClone, onDelete, onLang, lang }) {
    const T = t(lang);
    const list = Array.isArray(sessions) ? sessions : [];
    const sorted = list.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return h('aside', { className: 'iw-nav' },
      h('div', { className: 'iw-nav-head' },
        h('div', { className: 'iw-nav-titles' },
          h('p', { className: 'iw-nav-title' }, T.navTitle),
          h('p', { className: 'iw-nav-sub' }, T.navSubtitle),
        ),
        iwBtn({ primary: true, onClick: onNew }, T.newPractice),
      ),
      h('div', { className: 'iw-nav-scroll' },
        sorted.length === 0
          ? h('div', { className: 'iw-nav-meta', style: { padding: '20px 10px', textAlign: 'center' } }, T.emptyList)
          : sorted.map((s) => {
              const on = s.id === activeId;
              const sub = navSubtitle(s, lang);
              return h('div', {
                key: s.id, className: 'iw-nav-row' + (on ? ' on' : ''), onClick: () => onSelect(s.id),
              },
                iwDot({ status: s.status }),
                h('div', { className: 'iw-nav-body' },
                  h('div', { className: 'iw-nav-top' },
                    h('div', { className: 'iw-nav-name', title: s.questionTitle }, s.questionTitle),
                    h('div', { className: 'iw-nav-actions' },
                      (s.status === 'done' || s.status === 'failed') &&
                        iwBtn({ ghost: true, tiny: true, onClick: (e) => { e.stopPropagation(); onClone(s.id); }, title: T.cloneTooltip }, '↻'),
                      iwBtn({ ghost: true, tiny: true, onClick: (e) => { e.stopPropagation(); onDelete(s.id); }, title: T.deleteTooltip }, '✕'),
                    ),
                  ),
                  sub ? h('div', { className: 'iw-nav-sub' }, sub) : null,
                ),
              );
            }),
      ),
      h('div', { className: 'iw-nav-foot' },
        h('div', null, T.sessionCount(sorted.length)),
        h('div', null,
          iwBtn({ ghost: true, tiny: true, className: lang === 'zh' ? 'on' : '', onClick: () => onLang('zh') }, '中'),
          iwBtn({ ghost: true, tiny: true, className: lang === 'en' ? 'on' : '', onClick: () => onLang('en') }, 'EN'),
        ),
      ),
    );
  }

  // ────────────────────────────────────────────────────────────────
  // NewPractice — pick question + write essay.
  // ────────────────────────────────────────────────────────────────
  function NewPractice({ questions, selectedId, onSelect, essay, onEssayChange, onScore, error, saving, lang }) {
    const T = t(lang);
    const qArr = Array.isArray(questions) ? questions : [];
    const q = qArr.find((x) => x && x.id === selectedId);
    const wc = wordCount(essay);

    // Truncate body to first ~50 chars for the dropdown label, so users can
    // see which question they're picking without needing to expand each one.
    function optionLabel(x) {
      const head = (x.body || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      return head ? `${x.title} — ${head}${x.body.length > 60 ? '…' : ''}` : x.title;
    }

    return h('div', { className: 'iw-main' },
      h('div', { className: 'iw-main-inner' },
        error ? h('div', { className: 'iw-error' }, error) : null,
        // 1. 选择题目
        iwCard({ title: T.chooseQuestion },
          iwField({ label: T.questionBank },
            iwSelect({
              value: selectedId,
              onChange: onSelect,
              placeholder: T.selectPlaceholder,
              options: [
                { value: 'g1', label: T.taskGroup1, disabled: true },
                ...qArr.filter((x) => x.task === '1').map((x) => ({
                  value: x.id, label: `【${x.type}】${optionLabel(x)}`,
                })),
                { value: 'g2', label: T.taskGroup2, disabled: true },
                ...qArr.filter((x) => x.task === '2').map((x) => ({
                  value: x.id, label: optionLabel(x),
                })),
              ],
            }),
          ),
          q ? h(QuestionPreview, { q, lang }) : h('div', {
            className: 'iw-md',
            style: { color: 'var(--dsw-alias-label-caption)', fontSize: 13, padding: '8px 0' },
          }, T.questionHint),
        ),
        // 2. 写作
        iwCard({ title: T.writeCard },
          iwField({
            label: T.essayLabel,
            counter: T.wordCount(wc),
          },
            iwTextarea({
              value: essay,
              onChange: onEssayChange,
              placeholder: T.essayPlaceholder,
              rows: 14,
            }),
          ),
          iwBtn({
            primary: true,
            disabled: !selectedId || saving,
            onClick: onScore,
          }, saving ? T.saving : T.submitScore),
        ),
      ),
    );
  }

  function QuestionPreview({ q, lang }) {
    const T = t(lang);
    const [collapsed, setCollapsed] = useState(false);
    const [overThreshold, setOverThreshold] = useState(false);
    const bodyRef = useRef(null);

    useEffect(() => {
      if (bodyRef.current) {
        const h = bodyRef.current.scrollHeight;
        setOverThreshold(h > 350);
      }
    }, [q.id]);

    const imgList = Array.isArray(q.images) ? q.images : [];

    return h('div', null,
      h('div', {
        ref: bodyRef,
        className: 'iw-md',
        style: collapsed
          ? { maxHeight: '200px', overflow: 'hidden', position: 'relative' }
          : {},
      },
        h('h3', null, q.title),
        q.date || q.type ? h('p', { style: { color: 'var(--dsw-alias-label-caption)', fontSize: 13 } },
          [q.date, q.type, q.tags?.length ? `#${q.tags.join(' #')}` : ''].filter(Boolean).join(' · ')) : null,
        h('div', { dangerouslySetInnerHTML: { __html: renderMarkdown(q.body || '') } }),
        imgList.length > 0
          ? h('div', { style: { marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 } },
              imgList.map((src, i) => h('img', {
                key: i,
                src: src.startsWith('http') || src.startsWith('/') ? src : `/ielts-examiner/asset/${src}`,
                alt: q.title,
                style: { maxWidth: '100%', height: 'auto', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2)' },
              })))
          : null,
      ),
      overThreshold
        ? iwBtn({ ghost: true, tiny: true, onClick: () => setCollapsed(!collapsed) },
            collapsed ? T.expand : T.collapse)
        : null,
    );
  }

  // ────────────────────────────────────────────────────────────────
  // Loading — View B.
  // ────────────────────────────────────────────────────────────────
  function Loading({ message, lang }) {
    const T = t(lang);
    return h('div', { className: 'iw-main' },
      h('div', { className: 'iw-loading' },
        iwSpinner({}),
        h('div', null, message || T.loading),
      ),
    );
  }

  // ────────────────────────────────────────────────────────────────
  // Result — View C (default when active session.status === 'done').
  // ────────────────────────────────────────────────────────────────
  function Result({ session, question, onAgain, api, sessionId, rootRef, lang }) {
    const T = t(lang);
    const r = session.result || {};
    const c = r.correction || {};
    const a = r.analysis || {};
    const strip = [
      { key: 'taskResponse', label: T.stripTaskResponse },
      { key: 'coherenceCohesion', label: T.stripCoherence },
      { key: 'lexicalResource', label: T.stripLexical },
      { key: 'grammaticalRange', label: T.stripGrammar },
    ];
    // PDF 导出暂时隐藏（用户反馈）。代码保留在 export-pdf.js，要恢复时
    // 把下面这段打开即可：
    //   const handleExport = async () => {
    //     if (!rootRef?.current) return;
    //     try {
    //       const q = question ? { ...question, _bodyHtml: renderMarkdown(question.body || '') } : null;
    //       const date = new Date().toISOString().slice(0, 10);
    //       await exportNodeToPdf(rootRef.current, { session, question: q }, `ielts-${session.questionId || session.id}-${date}`);
    //     } catch (e) { alert('导出 PDF 失败：' + (e?.message || e)); }
    //   };

    // After mount, render mermaid diagrams embedded in analysis.
    useEffect(() => {
      if (rootRef?.current) renderMermaidIn(rootRef.current);
    }, [session.id, session.status]);

    return h('div', { className: 'iw-main' },
      h('div', { className: 'iw-main-inner' },
        h('div', { className: 'iw-infobar' },
          h('h2', null, session.questionTitle || T.untitled),
          iwBadge({ band: c.overallBand }),
          iwBtn({ primary: true, onClick: onAgain }, T.again),
        ),
        // 4 strip cards
        h('div', { className: 'iw-strip' },
          strip.map((s) => {
            const cs = c.criteriaScores?.[s.key];
            return h('div', { key: s.key, className: 'iw-strip-cell' },
              h('div', { className: 'iw-strip-label' }, s.label),
              h('div', { className: 'iw-strip-score' }, cs?.score ?? '—'),
            );
          }),
        ),
        // 题目卡：在思路解析上方，回看时不用滚回顶部也能看到原题。
        question ? iwCard({ title: T.cardQuestion },
          (question.task || question.type || question.date)
            ? h('p', { className: 'iw-pdf-meta' },
                [question.task ? `Task ${question.task}` : '', question.type, question.date]
                  .filter(Boolean).join(' · '))
            : null,
          h('div', { className: 'iw-md', dangerouslySetInnerHTML: {
            __html: renderMarkdown(question.body || ''),
          } }),
          Array.isArray(question.images) && question.images.length > 0
            ? h('div', { className: 'iw-question-images' },
                question.images.map((src, i) => h('img', {
                  key: i,
                  src: src.startsWith('http') || src.startsWith('/') ? src : `/ielts-examiner/asset/${src}`,
                  alt: question.title || '',
                })))
            : null,
        ) : null,
        // 思路解析
        iwCard({ title: T.cardStrategy },
          h('div', { className: 'iw-md', dangerouslySetInnerHTML: {
            __html: renderMarkdown([
              a.strategy ? `**${T.strategyTitle}**\n\n${a.strategy}` : '',
              a.keyPoints?.length ? `**${T.keyPointsTitle}**\n\n${a.keyPoints.map((p) => `- ${p}`).join('\n')}` : '',
              a.techniques?.length ? `**${T.techniquesTitle}**\n\n${a.techniques.map((p) => `- ${p}`).join('\n')}` : '',
              a.mermaidDiagram ? `**${T.structureTitle}**\n\n\`\`\`mermaid\n${a.mermaidDiagram}\n\`\`\`` : '',
            ].filter(Boolean).join('\n\n')),
          } }),
        ),
        // 批改
        iwCard({ title: T.cardCorrection },
          c.annotatedEssayHtml
            ? h('div', { className: 'iw-md', dangerouslySetInnerHTML: { __html: c.annotatedEssayHtml } })
            : h('div', null, T.noCorrection),
          c.grammarFixes?.length ? h('details', null,
            h('summary', { style: { cursor: 'pointer', fontWeight: 600, marginTop: 8 } },
              T.grammarTitle(c.grammarFixes.length)),
            h('ul', { style: { marginTop: 8 } },
              // 用 React 元素 <strong> 渲染高亮；之前用字符串模板
              // "<u>${g.phrase}</u>" 被 React 当文本节点，<u> 被转义掉。
              c.grammarFixes.map((g, i) => h('li', { key: i },
                h('strong', null, g.phrase),
                ' → ',
                g.suggestion,
                ' — ',
                g.reason,
              )),
            ),
          ) : null,
          c.vocabularyDiversity?.length ? h('details', null,
            h('summary', { style: { cursor: 'pointer', fontWeight: 600, marginTop: 8 } },
              T.vocabTitle(c.vocabularyDiversity.length)),
            h('ul', { style: { marginTop: 8 } },
              c.vocabularyDiversity.map((v, i) => h('li', { key: i },
                h('strong', null, v.phrase),
                ' — ',
                v.comment,
                v.alternatives?.length ? T.vocabAlt(v.alternatives) : null,
              )),
            ),
          ) : null,
        ),
        // 总体评语
        iwCard({ title: T.cardOverall },
          h('div', { className: 'iw-md' },
            h('p', null, c.overallComment || T.noComment)),
        ),
        r.sampleEssay ? iwCard({ title: T.cardSample },
          h('div', { className: 'iw-md', dangerouslySetInnerHTML: { __html: renderMarkdown(r.sampleEssay) } }),
        ) : null,
      ),
    );
  }

  // ────────────────────────────────────────────────────────────────
  // SessionDetail — View D (inline summary at top of right pane).
  // ────────────────────────────────────────────────────────────────
  function SessionDetail({ session, lang }) {
    const T = t(lang);
    const c = session.result?.correction || {};
    return h('div', { className: 'iw-summary' },
      h('div', { className: 'iw-summary-meta' },
        T.summaryMeta(session.questionTitle, timeAgo(session.createdAt, lang), session.wordCount)),
      h('div', { className: 'iw-summary-title' },
        iwBadge({ band: c.overallBand }),
        h('span', { style: { marginLeft: 8 } },
          `TR ${c.criteriaScores?.taskResponse?.score ?? '—'} · ` +
          `CC ${c.criteriaScores?.coherenceCohesion?.score ?? '—'} · ` +
          `LR ${c.criteriaScores?.lexicalResource?.score ?? '—'} · ` +
          `GRA ${c.criteriaScores?.grammaticalRange?.score ?? '—'}`)),
      c.analysis?.strategy ? h('p', null,
        (c.analysis.strategy || '').slice(0, 200) + ((c.analysis.strategy || '').length > 200 ? '…' : '')) : null,
      session.status === 'done'
        ? h('div', { className: 'iw-summary-hint' }, T.summaryHint)
        : null,
    );
  }

  // ────────────────────────────────────────────────────────────────
  // Root — top-level state. Mounts Nav + main view.
  // ────────────────────────────────────────────────────────────────
  function Root({ api, onClose }) {
    const [view, setView] = useState('boot');   // boot | new | loading | result | detail
    const [questions, setQuestions] = useState([]);
    const [sessions, setSessions] = useState([]);
    const [activeId, setActiveId] = useState(null);
    const [selectedQ, setSelectedQ] = useState('');
    const [essay, setEssay] = useState('');
    const [active, setActive] = useState(null);
    const [error, setError] = useState(null);
    const [saving, setSaving] = useState(false);
    const [lang, setLang] = useState('zh');
    const resultRef = useRef(null);

    const T = t(lang);

    // Debug — remove after diagnostics
    console.info('[iw] Root render view=', view, 'questions=', questions.length, 'selectedQ=', selectedQ);

    const refreshSessions = useCallback(async () => {
      try {
        const list = await api.listSessions();
        setSessions(list);
        return list;
      } catch (e) { console.warn('listSessions failed', e); return []; }
    }, [api]);

    // Boot: load questions + sessions; pick default view.
    useEffect(() => {
      (async () => {
        try {
          const [qs, list] = await Promise.all([api.listQuestions(), refreshSessions()]);
          setQuestions(qs);
          const latest = list[0];
          if (latest) {
            setActiveId(latest.id);
            await loadActive(latest.id);
          } else {
            setView('empty');
          }
        } catch (e) {
          setError(T.initError(e?.message || e));
          setView('empty');
        }
      })();
    }, []);  // eslint-disable-line react-hooks/exhaustive-deps

    // Auto-refresh Nav every 3s.
    useEffect(() => {
      const t = setInterval(refreshSessions, 3000);
      return () => clearInterval(t);
    }, [refreshSessions]);

    // Pulse active session while it's running; flip view to Result when done.
    useEffect(() => {
      if (!activeId) return;
      if (!active || active.status !== 'running') return;
      if (view === 'result' || view === 'loading') {
        const t = setInterval(async () => {
          try {
            const p = await api.pulse(activeId);
            if (p.status !== 'running') {
              await loadActive(activeId, true);
            }
          } catch {}
        }, 1500);
        return () => clearInterval(t);
      }
    }, [activeId, active?.status, view]);  // eslint-disable-line react-hooks/exhaustive-deps

    async function loadActive(id, forceResult = false) {
      try {
        const s = await api.getSession(id);
        setActive(s);
        if (s.status === 'done') setView(forceResult ? 'result' : (forceResult ? 'result' : 'result'));
        else if (s.status === 'running') setView('loading');
        else if (s.status === 'failed') setView('failed');
        else setView('detail');
        setEssay(s.essay || '');
        setSelectedQ(s.questionId || '');
        return s;
      } catch (e) {
        setError(T.loadSessionError(e?.message || e));
      }
    }

    async function handleNew() {
      setActive(null);
      setActiveId(null);
      setEssay('');
      setSelectedQ('');
      setError(null);
      setView('new');
    }

    async function handleSelectSession(id) {
      setActiveId(id);
      setView('loading');
      await loadActive(id);
    }

    async function handleClone(id) {
      try {
        const { id: newId } = await api.clone(id);
        await refreshSessions();
        await handleSelectSession(newId);
      } catch (e) {
        setError(T.cloneError(e?.message || e));
      }
    }

    async function handleDelete(id) {
      if (!confirm(T.deleteConfirm)) return;
      try {
        await api.delete(id);
        const list = await refreshSessions();
        if (id === activeId) {
          if (list.length) await handleSelectSession(list[0].id);
          else handleNew();
        }
      } catch (e) {
        setError(T.deleteError(e?.message || e));
      }
    }

    // Auto-save essay every 1.5s of inactivity.
    const saveTimer = useRef(null);
    function handleEssayChange(v) {
      setEssay(v);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        if (!activeId || view !== 'new') return;
        try {
          setSaving(true);
          await api.updateEssay(activeId, v);
          await refreshSessions();
        } catch (e) { console.warn('auto-save failed', e); }
        finally { setSaving(false); }
      }, 1500);
    }

    async function handleScore() {
      if (!selectedQ) { setError(T.pleaseSelectQuestion); return; }
      setError(null);
      try {
        let id = activeId;
        if (!id) {
          const { id: newId } = await api.createSession(selectedQ);
          id = newId;
          setActiveId(id);
          await api.updateEssay(id, essay);
        } else {
          await api.updateEssay(id, essay);
        }
        await api.score(id);
        await refreshSessions();
        await loadActive(id, true);
      } catch (e) {
        setError(T.scoreError(e?.message || e));
      }
    }

    function renderMain() {
      if (view === 'boot' || (view === 'empty' && !sessions.length && !active)) {
        return h('div', { className: 'iw-main' },
          h('div', { className: 'iw-main-inner' },
            h('div', { className: 'iw-empty' },
              h('h2', null, T.welcomeTitle),
              h('p', null, T.welcomeBody),
              iwBtn({ primary: true, onClick: handleNew }, T.newPracticeBtn),
            )));
      }
      if (view === 'new') {
        return h(NewPractice, {
          questions, selectedId: selectedQ, onSelect: setSelectedQ,
          essay, onEssayChange: handleEssayChange, onScore: handleScore,
          error, saving, lang,
        });
      }
      if (view === 'loading') {
        return h(Loading, { message: T.loading, lang });
      }
      if (view === 'failed' && active) {
        return h('div', { className: 'iw-main' },
          h('div', { className: 'iw-main-inner' },
            h('div', { className: 'iw-error' }, active.error || T.failedTitle),
            iwBtn({ primary: true, onClick: () => loadActive(activeId, true) }, T.retry),
            iwBtn({ ghost: true, onClick: handleNew }, T.newPracticeBtn),
          ));
      }
      // detail or result: render Result with optional SessionDetail on top
      if (active && active.status === 'done') {
        const question = questions.find((q) => q.id === active.questionId) || null;
        return h('div', { ref: resultRef, className: 'iw-main' },
          h('div', { className: 'iw-main-inner' },
            h(SessionDetail, { session: active, lang }),
            h(Result, { session: active, question, onAgain: handleNew, api, sessionId: activeId, rootRef: resultRef, lang }),
          ));
      }
      if (active) {
        return h(NewPractice, {
          questions, selectedId: selectedQ, onSelect: setSelectedQ,
          essay, onEssayChange: handleEssayChange, onScore: handleScore,
          error, saving, lang,
        });
      }
      return null;
    }

    return h('div', { className: 'iw-root', style: { height: '100%', display: 'flex', flexDirection: 'column' } },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', borderBottom: '1px solid var(--dsw-alias-border-l2)' } },
        h('div', { style: { fontWeight: 600 } }, T.headerTitle),
        iwBtn({ ghost: true, tiny: true, onClick: onClose }, T.closeBtn),
      ),
      h('div', { className: 'iw-workbench' },
        h(Nav, {
          sessions, activeId, onSelect: handleSelectSession,
          onNew: handleNew, onClone: handleClone, onDelete: handleDelete,
          onLang: setLang, lang,
        }),
        renderMain(),
      ),
    );
  }

  return { Root, Nav, NewPractice, Loading, Result, SessionDetail };
}
