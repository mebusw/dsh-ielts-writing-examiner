// pages.js — factory(React, h, c) returns { Root, Nav, NewPractice, Loading, Result, SessionDetail }.
//
// c = { iwCard, iwBtn, iwBadge, iwDot, iwField, iwSelect, iwTextarea, iwSpinner }
// All pages are function components (no JSX, no class). State is held in Root.
// React is threaded through so Root can call useState/useEffect/useRef (those
// names must resolve to the React instance from the ModuleLoader's require('react')).

import { renderMarkdown, renderMermaidIn } from './md.js';
import { exportNodeToPdf } from './export-pdf.js';

export function createPages(React, h, c) {
  const { useState, useEffect, useRef, useCallback } = React;
  const { iwCard, iwBtn, iwBadge, iwDot, iwField, iwSelect, iwTextarea, iwSpinner } = c;

  function wordCount(text) {
    return String(text || '').trim() ? String(text).trim().split(/\s+/).length : 0;
  }

  function timeAgo(ts) {
    if (!ts) return '';
    const d = Math.floor((Date.now() - ts) / 1000);
    if (d < 60) return `${d}秒前`;
    if (d < 3600) return `${Math.floor(d / 60)}分钟前`;
    if (d < 86400) return `${Math.floor(d / 3600)}小时前`;
    const days = Math.floor(d / 86400);
    if (days < 30) return `${days}天前`;
    const date = new Date(ts);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  // ────────────────────────────────────────────────────────────────
  // Nav — 264px left column. Auto-refresh every 3s.
  // ────────────────────────────────────────────────────────────────
  function Nav({ sessions, activeId, onSelect, onNew, onClone, onDelete, onLang, lang }) {
    const list = Array.isArray(sessions) ? sessions : [];
    const sorted = list.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return h('aside', { className: 'iw-nav' },
      h('div', { className: 'iw-nav-head' },
        h('div', { className: 'iw-nav-titles' },
          h('p', { className: 'iw-nav-title' }, 'IELTS 写作'),
          h('p', { className: 'iw-nav-sub' }, '题目 → 作文 → AI 评分'),
        ),
        iwBtn({ primary: true, onClick: onNew }, '+ 新练习'),
      ),
      h('div', { className: 'iw-nav-scroll' },
        sorted.length === 0
          ? h('div', { className: 'iw-nav-meta', style: { padding: '20px 10px', textAlign: 'center' } }, '暂无练习')
          : sorted.map((s) => {
              const on = s.id === activeId;
              return h('div', {
                key: s.id, className: 'iw-nav-row' + (on ? ' on' : ''), onClick: () => onSelect(s.id),
              },
                iwDot({ status: s.status }),
                h('div', { className: 'iw-nav-top' },
                  h('div', { className: 'iw-nav-name', title: s.questionTitle }, s.questionTitle),
                  h('div', { className: 'iw-nav-actions' },
                    (s.status === 'done' || s.status === 'failed') &&
                      iwBtn({ ghost: true, tiny: true, onClick: (e) => { e.stopPropagation(); onClone(s.id); }, title: '用同一题再来一次' }, '↻'),
                    iwBtn({ ghost: true, tiny: true, onClick: (e) => { e.stopPropagation(); onDelete(s.id); }, title: '删除这次练习' }, '✕'),
                  ),
                ),
              );
            }),
      ),
      h('div', { className: 'iw-nav-foot' },
        h('div', null, `共 ${sorted.length} 次练习`),
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
  function NewPractice({ questions, selectedId, onSelect, essay, onEssayChange, onScore, error, saving }) {
    const q = questions.find((x) => x.id === selectedId);
    const wc = wordCount(essay);
    return h('div', { className: 'iw-main' },
      h('div', { className: 'iw-main-inner' },
        error ? h('div', { className: 'iw-error' }, error) : null,
        // 1. 选择题目
        iwCard({ title: '1. 选择题目' },
          iwField({ label: '题库' },
            iwSelect({
              value: selectedId,
              onChange: onSelect,
              placeholder: '—— 请选择一道题 ——',
              options: [
                { value: 'g1', label: '── Task 1 ──', disabled: true },
                ...questions.filter((x) => x.task === '1').map((x) => ({
                  value: x.id, label: `${x.title}（${x.type}）`,
                })),
                { value: 'g2', label: '── Task 2 ──', disabled: true },
                ...questions.filter((x) => x.task === '2').map((x) => ({
                  value: x.id, label: `${x.title}`,
                })),
              ],
            }),
          ),
          q ? h(QuestionPreview, { q }) : null,
        ),
        // 2. 写作
        iwCard({ title: '2. 写作' },
          iwField({
            label: '把你的作文写在这里',
            counter: `${wc} 词${wc < 50 ? '（至少 50 词）' : ''}`,
          },
            iwTextarea({
              value: essay,
              onChange: onEssayChange,
              placeholder: 'Write at least 150 words for Task 1, or 250 for Task 2.',
              rows: 14,
            }),
          ),
          iwBtn({
            primary: true,
            disabled: !selectedId || wc < 50 || saving,
            onClick: onScore,
          }, saving ? '保存中…' : '提交评分'),
        ),
      ),
    );
  }

  function QuestionPreview({ q }) {
    const [collapsed, setCollapsed] = useState(false);
    const [overThreshold, setOverThreshold] = useState(false);
    const bodyRef = useRef(null);

    useEffect(() => {
      // After mount, measure scrollHeight and decide whether to show toggle.
      // Default = expanded per migration-guide §5 视图 A.
      if (bodyRef.current) {
        const h = bodyRef.current.scrollHeight;
        setOverThreshold(h > 350);
      }
    }, [q.id]);

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
      ),
      overThreshold
        ? iwBtn({ ghost: true, tiny: true, onClick: () => setCollapsed(!collapsed) },
            collapsed ? '展开' : '收起')
        : null,
    );
  }

  // ────────────────────────────────────────────────────────────────
  // Loading — View B.
  // ────────────────────────────────────────────────────────────────
  function Loading({ message }) {
    return h('div', { className: 'iw-main' },
      h('div', { className: 'iw-loading' },
        iwSpinner({}),
        h('div', null, message || 'AI 考官正在批改，请稍候...'),
      ),
    );
  }

  // ────────────────────────────────────────────────────────────────
  // Result — View C (default when active session.status === 'done').
  // ────────────────────────────────────────────────────────────────
  function Result({ session, onAgain, api, sessionId, rootRef }) {
    const r = session.result || {};
    const c = r.correction || {};
    const a = r.analysis || {};
    const strip = [
      { key: 'taskResponse', label: 'Task Response' },
      { key: 'coherenceCohesion', label: 'Coherence & Cohesion' },
      { key: 'lexicalResource', label: 'Lexical Resource' },
      { key: 'grammaticalRange', label: 'Grammatical Range' },
    ];
    const handleExport = async () => {
      if (!rootRef?.current) return;
      try {
        const date = new Date().toISOString().slice(0, 10);
        await exportNodeToPdf(rootRef.current, `ielts-${session.questionId || session.id}-${date}`);
      } catch (e) {
        alert('导出 PDF 失败：' + (e?.message || e));
      }
    };

    // After mount, render mermaid diagrams embedded in analysis.
    useEffect(() => {
      if (rootRef?.current) renderMermaidIn(rootRef.current);
    }, [session.id, session.status]);

    return h('div', { className: 'iw-main' },
      h('div', { className: 'iw-main-inner' },
        h('div', { className: 'iw-infobar' },
          h('h2', null, session.questionTitle || '(untitled)'),
          iwBadge({ band: c.overallBand }),
          iwBtn({ ghost: true, onClick: handleExport }, '导出 PDF'),
          iwBtn({ primary: true, onClick: onAgain }, '再来一次'),
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
        // 思路解析
        iwCard({ title: '思路解析' },
          h('div', { className: 'iw-md', dangerouslySetInnerHTML: {
            __html: renderMarkdown([
              a.strategy ? `**答题策略**\n\n${a.strategy}` : '',
              a.keyPoints?.length ? `**写作重点**\n\n${a.keyPoints.map((p) => `- ${p}`).join('\n')}` : '',
              a.techniques?.length ? `**写作技巧**\n\n${a.techniques.map((p) => `- ${p}`).join('\n')}` : '',
              a.mermaidDiagram ? `**段落结构**\n\n\`\`\`mermaid\n${a.mermaidDiagram}\n\`\`\`` : '',
            ].filter(Boolean).join('\n\n')),
          } }),
        ),
        // 批改
        iwCard({ title: '批改' },
          c.annotatedEssayHtml
            ? h('div', { className: 'iw-md', dangerouslySetInnerHTML: { __html: c.annotatedEssayHtml } })
            : h('div', null, '(无批改)'),
          c.grammarFixes?.length ? h('details', null,
            h('summary', { style: { cursor: 'pointer', fontWeight: 600, marginTop: 8 } },
              `语法批改（${c.grammarFixes.length} 条）`),
            h('ul', { style: { marginTop: 8 } },
              c.grammarFixes.map((g, i) =>
                h('li', { key: i }, `<u>${g.phrase}</u> → ${g.suggestion} — ${g.reason}`)),
            ),
          ) : null,
          c.vocabularyDiversity?.length ? h('details', null,
            h('summary', { style: { cursor: 'pointer', fontWeight: 600, marginTop: 8 } },
              `用词多样性（${c.vocabularyDiversity.length} 条）`),
            h('ul', { style: { marginTop: 8 } },
              c.vocabularyDiversity.map((v, i) =>
                h('li', { key: i }, `${v.phrase} — ${v.comment}${v.alternatives?.length ? `（替代：${v.alternatives.join(' / ')}）` : ''}`)),
            ),
          ) : null,
        ),
        // 总体评语
        iwCard({ title: '总体评语' },
          h('div', { className: 'iw-md' },
            h('p', null, c.overallComment || '(无评语)')),
        ),
        r.sampleEssay ? iwCard({ title: '高分范文' },
          h('div', { className: 'iw-md', dangerouslySetInnerHTML: { __html: renderMarkdown(r.sampleEssay) } }),
        ) : null,
      ),
    );
  }

  // ────────────────────────────────────────────────────────────────
  // SessionDetail — View D (inline summary at top of right pane).
  // ────────────────────────────────────────────────────────────────
  function SessionDetail({ session, onJumpToFull }) {
    const c = session.result?.correction || {};
    return h('div', { className: 'iw-summary' },
      h('div', { className: 'iw-summary-meta' },
        `${session.questionTitle} · ${timeAgo(session.createdAt)} · ${session.wordCount} 词`),
      h('div', { className: 'iw-summary-title' },
        iwBadge({ band: c.overallBand }),
        h('span', { style: { marginLeft: 8 } },
          `TR ${c.criteriaScores?.taskResponse?.score ?? '—'} · ` +
          `CC ${c.criteriaScores?.coherenceCohesion?.score ?? '—'} · ` +
          `LR ${c.criteriaScores?.lexicalResource?.score ?? '—'} · ` +
          `GRA ${c.criteriaScores?.grammaticalRange?.score ?? '—'}`)),
      c.analysis?.strategy ? h('p', null,
        (c.analysis.strategy || '').slice(0, 200) + (c.analysis.strategy.length > 200 ? '…' : '')) : null,
      session.status === 'done'
        ? h('div', { className: 'iw-summary-hint' }, '向下滚动查看完整批改')
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
          setError('初始化失败：' + (e?.message || e));
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
        setError('读取 session 失败：' + (e?.message || e));
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
        setError('克隆失败：' + (e?.message || e));
      }
    }

    async function handleDelete(id) {
      if (!confirm('确认删除这次练习？')) return;
      try {
        await api.delete(id);
        const list = await refreshSessions();
        if (id === activeId) {
          if (list.length) await handleSelectSession(list[0].id);
          else handleNew();
        }
      } catch (e) {
        setError('删除失败：' + (e?.message || e));
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
      if (!selectedQ) { setError('请先选择一道题'); return; }
      if (wordCount(essay) < 50) { setError('作文至少 50 词'); return; }
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
        setError('提交评分失败：' + (e?.message || e));
      }
    }

    function renderMain() {
      if (view === 'boot' || (view === 'empty' && !sessions.length && !active)) {
        return h('div', { className: 'iw-main' },
          h('div', { className: 'iw-main-inner' },
            h('div', { className: 'iw-empty' },
              h('h2', null, '欢迎使用 IELTS 写作练习'),
              h('p', null, '点左上方 "+ 新练习" 开始你的第一次练习。'),
              iwBtn({ primary: true, onClick: handleNew }, '+ 新练习'),
            )));
      }
      if (view === 'new') {
        return h(NewPractice, {
          questions, selectedId: selectedQ, onSelect: setSelectedQ,
          essay, onEssayChange: handleEssayChange, onScore: handleScore,
          error, saving,
        });
      }
      if (view === 'loading') {
        return h(Loading, { message: 'AI 考官正在批改，请稍候...' });
      }
      if (view === 'failed' && active) {
        return h('div', { className: 'iw-main' },
          h('div', { className: 'iw-main-inner' },
            h('div', { className: 'iw-error' }, active.error || '本次评分失败。'),
            iwBtn({ primary: true, onClick: () => loadActive(activeId, true) }, '重试'),
            iwBtn({ ghost: true, onClick: handleNew }, '新练习'),
          ));
      }
      // detail or result: render Result with optional SessionDetail on top
      if (active && active.status === 'done') {
        return h('div', { ref: resultRef, className: 'iw-main' },
          h('div', { className: 'iw-main-inner' },
            h(SessionDetail, { session: active }),
            h(Result, { session: active, onAgain: handleNew, api, sessionId: activeId, rootRef: resultRef }),
          ));
      }
      if (active) {
        return h(NewPractice, {
          questions, selectedId: selectedQ, onSelect: setSelectedQ,
          essay, onEssayChange: handleEssayChange, onScore: handleScore,
          error, saving,
        });
      }
      return null;
    }

    return h('div', { className: 'iw-root', style: { height: '100%', display: 'flex', flexDirection: 'column' } },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', borderBottom: '1px solid var(--dsw-alias-border-l2)' } },
        h('div', { style: { fontWeight: 600 } }, 'IELTS 写作 · AI 评分工作台'),
        iwBtn({ ghost: true, tiny: true, onClick: onClose }, '✕ 关闭'),
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
