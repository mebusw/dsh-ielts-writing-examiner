// chat.js — bottom-docked chat/quote UI + its pure helpers.
//
// createChat(React, h, c) is called once inside createPages(). The returned
// ChatDock is deliberately STATELESS: every piece of chat state (thread, quotes,
// draft, streaming, expanded, error) lives in Root, so the dock can be rendered
// on its own in tests and survives view switches without remounting.
//
// Only React hooks used here: useEffect + useRef (autoscroll + textarea
// auto-grow). No useState, no JSX, no class components.
//
// The helpers are exposed on the returned object so verify.mjs can exercise
// them without mounting anything. `renderMarkdown` / `t` are top-level fns in
// the concatenated client bundle (build.mjs strips the import lines below).

import { renderMarkdown } from './md.js';
import { t } from './strings.js';

// Caps mirror .team/contract.md (host caps again; the client caps so a huge
// essay/question never inflates the request body).
const CHAT_QUOTE_MAX = 1000;
const CHAT_QUOTES_MAX = 3;
const CHAT_HISTORY_MAX = 24;
const CHAT_HISTORY_CONTENT_MAX = 6000;
const CHAT_QUESTION_BODY_MAX = 4000;
const CHAT_QUESTION_TITLE_MAX = 500;
const CHAT_ESSAY_MAX = 8000;
const CHAT_RESULT_MAX = 8000;

// ── pure helpers ───────────────────────────────────────────────

function capText(value, max) {
  const s = String(value == null ? '' : value);
  return s.length > max ? s.slice(0, max) : s;
}

/** Trim, collapse whitespace runs, cap 1000 chars, '' if nothing is left. */
function normalizeQuote(raw) {
  const s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, CHAT_QUOTE_MAX) : '';
}

/** Dedupe exact matches, append the new quote, keep the newest 3. */
function mergeQuotes(list, text) {
  const out = [];
  const push = (v) => {
    const q = normalizeQuote(v);
    if (q && out.indexOf(q) < 0) out.push(q);
  };
  if (Array.isArray(list)) list.forEach(push);
  push(text);
  return out.slice(-CHAT_QUOTES_MAX);
}

/**
 * Parse as many complete `\n\n`-delimited SSE events as `buffer` holds.
 * Returns the parsed JSON objects plus the trailing incomplete text, so the
 * caller can prepend it to the next network chunk (arbitrary chunk boundaries).
 * Comment lines (`: ping`) and non-`data:` fields are ignored; non-JSON data
 * events are skipped rather than crashing the stream.
 */
function parseSseEvents(buffer) {
  const events = [];
  let rest = String(buffer == null ? '' : buffer);
  const sep = /\r?\n\r?\n/;
  for (;;) {
    const m = sep.exec(rest);
    if (!m) break;
    const rawEvent = rest.slice(0, m.index);
    rest = rest.slice(m.index + m[0].length);
    const dataLines = [];
    for (const line of rawEvent.split(/\r?\n/)) {
      if (!line || line.charAt(0) === ':') continue; // comment / keep-alive
      if (line.indexOf('data:') !== 0) continue;    // event:/id:/retry: fields
      let data = line.slice('data:'.length);
      if (data.charAt(0) === ' ') data = data.slice(1);
      dataLines.push(data);
    }
    if (!dataLines.length) continue;
    const text = dataLines.join('\n');
    if (!text.trim()) continue;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') events.push(parsed);
    } catch { /* malformed event — ignore, the host only emits JSON */ }
  }
  return { events, rest };
}

// Root's view names → the contract's chat surfaces. Root has no separate
// 'writing' view: the new-practice page doubles as the writing page, so an
// essay already typed there means the user is writing, not merely picking a
// question.
function normalizeSurface(view, active, essay) {
  switch (view) {
    case 'result': return 'result';
    case 'loading': return 'loading';
    case 'failed': return 'failed';
    case 'new': return String(essay == null ? '' : essay).trim() ? 'writing' : 'new';
    case 'writing': return 'writing';
    // 'detail' is Root's editing view for an existing session (it renders the
    // NewPractice page), so the model is looking at the writing surface.
    case 'detail': return 'writing';
    // Welcome/empty (or the transient boot frame): an active session means we
    // are actually looking at that session's writing screen.
    case 'boot':
    case 'empty': return active ? 'writing' : 'empty';
    default: return active ? 'writing' : 'empty';
  }
}

function buildQuestionContext(question) {
  if (!question || typeof question !== 'object') return null;
  return {
    title: capText(question.title, CHAT_QUESTION_TITLE_MAX),
    body: capText(question.body, CHAT_QUESTION_BODY_MAX),
    task: capText(question.task, 64),
    type: capText(question.type, 64),
  };
}

function buildResultContext(active) {
  const raw = active && active.result && typeof active.result === 'object' ? active.result : null;
  if (!raw) return null;
  const corr = raw.correction && typeof raw.correction === 'object' ? raw.correction : {};
  const analysis = raw.analysis && typeof raw.analysis === 'object' ? raw.analysis : {};
  const band = Number(corr.overallBand);
  const result = {
    overallBand: Number.isFinite(band) ? band : (corr.overallBand ?? null),
    criteriaScores: corr.criteriaScores && typeof corr.criteriaScores === 'object' ? corr.criteriaScores : null,
    overallComment: capText(corr.overallComment, 2000),
    grammarFixes: Array.isArray(corr.grammarFixes)
      ? corr.grammarFixes.slice(0, 20).map((g) => ({
          phrase: capText(g?.phrase, 300),
          suggestion: capText(g?.suggestion, 300),
          reason: capText(g?.reason, 300),
        }))
      : [],
    vocabularyDiversity: Array.isArray(corr.vocabularyDiversity)
      ? corr.vocabularyDiversity.slice(0, 20).map((v) => ({
          phrase: capText(v?.phrase, 300),
          comment: capText(v?.comment, 400),
          alternatives: Array.isArray(v?.alternatives) ? v.alternatives.slice(0, 8).map((a) => capText(a, 120)) : [],
        }))
      : [],
    strategy: capText(analysis.strategy, 2000),
    keyPoints: Array.isArray(analysis.keyPoints)
      ? analysis.keyPoints.slice(0, 20).map((p) => capText(p, 500))
      : [],
  };
  // Keep the whole summary under the contract cap. Shed the least useful
  // extras first so the model still gets the band + overall comment.
  let json = JSON.stringify(result);
  for (const key of ['vocabularyDiversity', 'grammarFixes', 'keyPoints']) {
    while (json.length > CHAT_RESULT_MAX && Array.isArray(result[key]) && result[key].length) {
      result[key].pop();
      json = JSON.stringify(result);
    }
  }
  if (json.length > CHAT_RESULT_MAX) {
    result.strategy = capText(result.strategy, 800);
    result.overallComment = capText(result.overallComment, 800);
  }
  return result;
}

/** ChatContext — see .team/contract.md "Chat context". */
function buildChatContext({ view, active, question, essay } = {}) {
  return {
    surface: normalizeSurface(view, active, essay),
    question: buildQuestionContext(question),
    essay: capText(essay, CHAT_ESSAY_MAX),
    result: buildResultContext(active),
  };
}

/**
 * DisplayMessage[] (client state, carries ts/quotes) → the wire history:
 * [{ role, content, quotes? }], newest last, no ts, capped to 24 turns.
 */
function messagesForRequest(thread) {
  const list = Array.isArray(thread) ? thread : [];
  const tail = list.length > CHAT_HISTORY_MAX ? list.slice(-CHAT_HISTORY_MAX) : list;
  return tail.map((m) => {
    const role = m && m.role === 'assistant' ? 'assistant' : 'user';
    const out = { role, content: capText(m && m.content, CHAT_HISTORY_CONTENT_MAX) };
    const quotes = m && Array.isArray(m.quotes)
      ? m.quotes.map(normalizeQuote).filter(Boolean).slice(0, CHAT_QUOTES_MAX)
      : [];
    if (quotes.length) out.quotes = quotes;
    return out;
  });
}

// ── factory ────────────────────────────────────────────────────

export function createChat(React, h, c) {
  const { useEffect, useRef } = React;
  const { iwBtn } = c;

  // Short single-line preview for a quote chip; the full text stays in `title`.
  function chipText(q) {
    const s = String(q || '');
    return s.length > 120 ? s.slice(0, 120) + '…' : s;
  }

  /**
   * ChatDock — STATELESS. All state is in Root; props are the only input.
   * Refs/effects only handle autoscroll and textarea auto-grow.
   */
  function ChatDock(props) {
    const {
      lang, messages, quotes, draft, streaming, error, expanded,
      onDraftChange, onSend, onStop, onToggleExpanded,
      onRemoveQuote, onClearQuotes, onClearThread,
    } = props || {};
    const T = t(lang);
    const list = Array.isArray(messages) ? messages : [];
    const qs = Array.isArray(quotes) ? quotes : [];
    const logRef = useRef(null);
    const inputRef = useRef(null);

    // Autoscroll the log as messages/deltas arrive. `messages` is replaced
    // (new array identity) on every delta, so this runs while streaming too.
    useEffect(() => {
      const el = logRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
    }, [messages, streaming, error, expanded]);

    // Auto-grow the textarea from 1 to 5 rows. Row height is read from the
    // computed style so it keeps working with a user-chosen font size.
    useEffect(() => {
      const el = inputRef.current;
      if (!el || typeof window === 'undefined') return;
      // The whole panel (and this dock) can be display:none while closed; a
      // hidden element reports scrollHeight 0, so keep the CSS default height
      // until it is visible instead of collapsing the input to 0px.
      if (!el.scrollHeight) { el.style.height = ''; return; }
      el.style.height = 'auto';
      let line = 0;
      try { line = parseFloat(window.getComputedStyle(el).lineHeight) || 0; } catch { /* ignore */ }
      if (!line) line = 21;
      const max = line * 5 + 16; // 5 rows + vertical padding
      el.style.height = Math.min(el.scrollHeight || line, max) + 'px';
      el.style.overflowY = (el.scrollHeight || 0) > max ? 'auto' : 'hidden';
    }, [draft]);

    function growOrExpand() {
      if (!expanded && typeof onToggleExpanded === 'function') onToggleExpanded();
    }

    function onKeyDown(e) {
      if (!e || e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      e.preventDefault();
      if (streaming) return;
      if (String(draft == null ? '' : draft).trim()) onSend && onSend();
    }

    function renderMessage(m, i) {
      const isUser = !!m && m.role === 'user';
      const isLast = i === list.length - 1;
      const isStreaming = !isUser && !!streaming && isLast;
      const classes = 'iw-chat-msg ' + (isUser ? 'user' : 'assistant') + (isStreaming ? ' streaming' : '');
      const kids = [];
      if (isUser && m && Array.isArray(m.quotes)) {
        m.quotes.forEach((q, j) => {
          kids.push(h('blockquote', { key: 'q' + j, className: 'iw-chat-quote' }, String(q || '')));
        });
      }
      if (isUser) {
        kids.push(String((m && m.content) || ''));
      } else {
        const content = (m && m.content) || '';
        if (content) {
          // A markdown renderer failure must never take down the workbench;
          // fall back to plain text for that bubble.
          let html = '';
          try { html = renderMarkdown(String(content)); } catch { html = ''; }
          kids.push(html
            ? h('div', {
              key: 'md',
              className: 'iw-md',
              dangerouslySetInnerHTML: { __html: html },
            })
            : h('div', { key: 'md', className: 'iw-md' }, String(content)));
        }
        if (isStreaming) {
          kids.push(h('div', { key: 'thinking', className: 'iw-chat-thinking' },
            T.chatThinking,
            h('span', { key: 'caret', className: 'iw-chat-caret', 'aria-hidden': 'true' }),
          ));
        }
      }
      return h('div', { key: 'm' + i, className: classes },
        h('div', { key: 'bubble', className: 'iw-chat-bubble' }, ...kids));
    }

    const head = h('div', { key: 'head', className: 'iw-chat-head' },
      h('div', { key: 'title', className: 'iw-chat-head-title' }, T.chatTitle),
      h('div', { key: 'hint', className: 'iw-chat-head-hint' }, T.chatHint),
      h('div', { key: 'actions', className: 'iw-chat-head-actions' },
        list.length
          ? iwBtn({ key: 'clear', ghost: true, tiny: true, onClick: onClearThread, title: T.chatClear }, T.chatClear)
          : null,
        iwBtn({
          key: 'toggle', ghost: true, tiny: true, onClick: onToggleExpanded,
          title: expanded ? T.chatCollapse : T.chatExpand,
        }, expanded ? T.chatCollapse : T.chatExpand),
      ),
    );

    const log = expanded
      ? h('div', { key: 'log', className: 'iw-chat-log', ref: logRef },
          list.length === 0 ? h('div', { key: 'empty', className: 'iw-chat-empty' }, T.chatEmpty) : null,
          ...list.map(renderMessage),
          error ? h('div', { key: 'err', className: 'iw-error' }, T.chatError(error)) : null,
        )
      : null;

    const quotesBar = qs.length
      ? h('div', { key: 'quotes', className: 'iw-chat-quotes' },
          h('span', { key: 'label', className: 'iw-chat-quotes-label' }, T.chatQuotesLabel),
          ...qs.map((q, i) => h('span', {
            key: 'chip' + i, className: 'iw-chat-quote-chip', title: String(q || ''),
          },
            h('span', { key: 'text', className: 'iw-chat-quote-text' }, chipText(q)),
            h('button', {
              key: 'x', type: 'button', className: 'iw-chat-quote-x',
              title: T.chatQuoteRemove, 'aria-label': T.chatQuoteRemove,
              onClick: () => onRemoveQuote && onRemoveQuote(i),
            }, '×'),
          )),
          iwBtn({ key: 'clearquotes', ghost: true, tiny: true, onClick: onClearQuotes }, T.chatQuotesClear),
        )
      : null;

    const hasDraft = !!String(draft == null ? '' : draft).trim();
    const inputRow = h('div', { key: 'inputrow', className: 'iw-chat-inputrow' },
      h('textarea', {
        key: 'input',
        ref: inputRef,
        className: 'iw-chat-input',
        rows: 1,
        value: draft == null ? '' : String(draft),
        placeholder: T.chatPlaceholder,
        onFocus: growOrExpand,
        onChange: (e) => {
          onDraftChange && onDraftChange(e.target.value);
          growOrExpand();
        },
        onKeyDown,
      }),
      iwBtn({ key: 'send', primary: true, disabled: !hasDraft || !!streaming, onClick: onSend }, T.chatSend),
      streaming ? iwBtn({ key: 'stop', ghost: true, onClick: onStop }, T.chatStop) : null,
    );

    return h('div', {
      className: 'iw-chat' + (expanded ? ' open' : ''),
      'data-iw-chat': 'dock',
    }, head, log, quotesBar, inputRow);
  }

  return { ChatDock, normalizeQuote, mergeQuotes, buildChatContext, messagesForRequest, parseSseEvents };
}
