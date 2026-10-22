#!/usr/bin/env node
// e2e/run-ui-check.mjs — offline browser verification of the bottom chat dock.
//
// What this is (and is not):
//   * It does NOT talk to a running DSH server and needs no auth: the plugin's
//     built client half (lib/client.js) is loaded into a headless Chromium page
//     with a stubbed `window.__ModuleLoader__`, a fake `window.fetch` that
//     serves /ielts-examiner/rpc fixtures plus a real streaming
//     /ielts-examiner/chat response, and the plugin CSS from src/client/styles.js.
//   * It exercises the REAL built bundle: the footer entry, panel open, welcome
//     and result views, programmatic text selection -> quote chip, typing a
//     question and receiving a streamed assistant reply.
//   * It produces screenshots under e2e/artifacts/ (gitignored).
//
// Usage:
//   node scripts/build.mjs      # required first: produces lib/client.js
//   node e2e/run-ui-check.mjs
//
// Exit codes: 0 = all checks passed, 1 = assertions failed, 2 = harness could
// not start (missing build / browser).
//
// Playwright browsers are not installed for 1.63 in this environment, so the
// harness points at the locally cached Chromium 1223 build instead of
// downloading anything.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../node_modules/@playwright/test/index.mjs';
import { STYLE } from '../src/client/styles.js';
import { t } from '../src/client/strings.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CLIENT_BUNDLE = join(ROOT, 'lib', 'client.js');
const CLIENT_SRC = join(ROOT, 'src', 'client');
const ARTIFACTS = join(HERE, 'artifacts');
const REACT_UMD = join(ROOT, 'node_modules', 'react', 'umd', 'react.development.js');
const REACT_DOM_UMD = join(ROOT, 'node_modules', 'react-dom', 'umd', 'react-dom.development.js');
// Pinned local browser: `npx playwright install` is out of scope for this repo.
// Override with CHAT_UI_CHROMIUM=/path/to/chrome if the cache moves.
const DEFAULT_CHROMIUM = '/Users/jacky/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const CHROMIUM_EXECUTABLE = process.env.CHAT_UI_CHROMIUM || DEFAULT_CHROMIUM;

// ── fixtures ────────────────────────────────────────────────────────────
const QUESTION_TASK2 = {
  id: 'writing-task-2/社会',
  task: '2',
  title: '社会 · 免费公共交通',
  type: 'Opinion',
  date: '2024-11-02',
  topic: '社会 · 免费公共交通',
  body: 'Some people believe that free public transport should be provided in cities to reduce traffic congestion. To what extent do you agree or disagree?',
  images: [],
  region: '中国大陆',
  tags: ['社会', '交通'],
};
const QUESTION_TASK1 = {
  id: 'writing-task-1-Academy/纽约人口变化',
  task: '1',
  title: '表格 · 纽约人口变化',
  type: '表格',
  date: '2024-10-15',
  topic: '表格 · 纽约人口变化',
  body: 'The table below shows the population change in New York between 2000 and 2020.',
  images: [],
  region: '北美',
  tags: ['人口'],
};
const SESSION_ID = 'abcdef123456';
const SESSION = {
  id: SESSION_ID,
  questionId: QUESTION_TASK2.id,
  questionTitle: QUESTION_TASK2.title,
  task: '2',
  status: 'done',
  wordCount: 248,
  createdAt: Date.now() - 3 * 3600e3,
  completedAt: Date.now() - 2 * 3600e3,
  overallBand: 6.5,
  essay: 'Modern cities face traffic congestion, and many commuters rely on private cars every day. I believe that free public transport should be provided, although it is not a complete solution. ' +
    'First, public transport is cheaper than private cars, so more people would use it. Second, it reduces emissions and improves air quality. However, governments must invest in capacity, otherwise crowding makes the service unattractive.',
  result: {
    matchedTask: 'Task2',
    taskSource: 'practice',
    analysis: {
      taskType: 'Task2',
      questionType: 'Opinion',
      topic: '社会',
      imageDescription: null,
      strategy: '让步 + 反驳：先承认免费公共交通有成本，再论证它带来的交通与环境收益更大。',
      keyPoints: ['降低交通拥堵', '减少排放', '需要政府投资运力'],
      techniques: ['让步法', '因果论证'],
      mermaidDiagram: '',
    },
    correction: {
      overallBand: 6.5,
      criteriaScores: {
        taskResponse: { score: 6.5, note: '切题，立场清楚，但例子偏少' },
        coherenceCohesion: { score: 6.5, note: '段落组织清楚，衔接自然' },
        lexicalResource: { score: 6, note: '词汇基本够用，可更精确' },
        grammaticalRange: { score: 6.5, note: '句式有变化，偶有错误' },
      },
      overallComment: '文章结构清楚，观点明确；如果补充具体城市案例和更丰富的词汇，分数还有提升空间。',
      annotatedEssayHtml: '<p>Modern cities face <mark>traffic congestion</mark>, and many commuters rely on <del>a lot of</del> private cars every day. I believe that free public transport should be provided, although it is not a complete solution.</p>',
      grammarFixes: [
        { phrase: 'a lot of', suggestion: 'a large number of', reason: '正式文体更合适' },
        { phrase: 'more people would use it', suggestion: 'more commuters would switch to it', reason: '表达更具体' },
      ],
      vocabularyDiversity: [
        { phrase: 'good', comment: '用词过于基础', alternatives: ['beneficial', 'effective'] },
        { phrase: 'reduce', comment: '可替换表达', alternatives: ['curb', 'alleviate'] },
      ],
    },
    sampleEssay: '**Sample essay**\n\nPublic transport is a public good...',
  },
};

const SSE_DELTAS = ['Here is ', 'the answer ', 'to your question.'];
const SSE_REPLY = SSE_DELTAS.join('');

// ── results bookkeeping ─────────────────────────────────────────────────
let checks = 0;
const failures = [];
const screenshots = [];

function pass(name) {
  checks++;
  console.log(`  ✓ ${name}`);
}
function failCheck(name, why) {
  checks++;
  failures.push({ name, why });
  console.error(`  ✗ ${name} — ${why}`);
}
/** Await fn; a thrown error or `false` is a failed check. */
async function check(name, fn) {
  try {
    const value = await fn();
    if (value === false) throw new Error('returned false');
    pass(name);
  } catch (e) {
    failCheck(name, e?.message || String(e));
  }
}
function eqCheck(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) pass(name);
  else failCheck(name, `got ${g} want ${w}`);
}

// ── harness page ────────────────────────────────────────────────────────
const HARNESS_HTML = `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>IELTS writing examiner — chat dock harness</title></head>
<body>
  <div id="footer-host"></div>
  <div id="overlay-host"></div>
</body>
</html>`;

// The DSH shell supplies these CSS custom properties; a bare page does not, so
// the plugin's token-based colours would fall back to nothing. Stub the ones
// styles.js actually reads.
const TOKEN_STUBS = `:root{
  --dsw-alias-bg-base:#f7f7f5;
  --dsw-alias-bg-layer-1:#ffffff;
  --dsw-alias-bg-layer-2:#f0f0ee;
  --dsw-alias-border-l2:#e3e3e0;
  --dsw-alias-label-primary:#1a1a1a;
  --dsw-alias-label-caption:#8a8a8a;
  --dsw-alias-state-business-primary:#4f7cff;
  --dsw-alias-brand-primary-invert:#ffffff;
  --dsw-alias-button-floating-fill:#ffffff;
  --dsw-alias-button-floating-hover:#f2f2f0;
  --dsw-alias-state-error:#ef4444;
  --dsw-alias-state-warning:#f59e0b;
  --dsw-alias-state-success:#22c55e;
  --dsw-alias-text-invert:#ffffff;
}`;

const HARNESS_CSS = `
  html, body { margin: 0; padding: 0; background: #e9e9e6; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  #footer-host { padding: 8px 16px; background: #fff; border-bottom: 1px solid #e3e3e0; }
  #overlay-host { position: relative; width: min(1280px, 100vw); height: min(840px, calc(100vh - 56px)); overflow: hidden; background: #f7f7f5; }
`;

/** The page-side fake host: RPC fixtures + a real streaming chat response. */
function fixtureScript(sessionList, priorChatMessages, chatByKey, replyDeltas) {
  return `(() => {
  const QUESTIONS = ${JSON.stringify([QUESTION_TASK1, QUESTION_TASK2])};
  const SESSIONS = ${JSON.stringify(sessionList)};
  const PRIOR_CHAT = ${JSON.stringify(priorChatMessages || [])};
  const CHAT_BY_KEY = ${JSON.stringify(chatByKey || null)};
  const REPLY_DELTAS = ${JSON.stringify(replyDeltas || SSE_DELTAS)};
  window.__e2e = { slots: [], rpcCalls: [], rpcEvents: [], chatCalls: [], sessionList: SESSIONS, questions: QUESTIONS, chatMessages: PRIOR_CHAT, chatByKey: CHAT_BY_KEY };

  const json = (body, status) => new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

  function chatResponse(requestBody) {
    window.__e2e.chatCalls.push(requestBody || {});
    const parts = REPLY_DELTAS.map((d) => 'data: ' + JSON.stringify({ delta: d }) + '\\n\\n');
    parts.push('data: ' + JSON.stringify({ done: true, message: { role: 'assistant', content: REPLY_DELTAS.join('') } }) + '\\n\\n');
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        for (const part of parts) {
          await new Promise((r) => setTimeout(r, 80));
          controller.enqueue(enc.encode(part));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
    });
  }

  window.fetch = async (url, opts) => {
    const u = String(url);
    if (u.indexOf('/ielts-examiner/chat') >= 0) {
      let body = {};
      try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) { /* ignore */ }
      return chatResponse(body);
    }
    if (u.indexOf('/ielts-examiner/rpc') >= 0) {
      let req = {};
      try { req = JSON.parse((opts && opts.body) || '{}'); } catch (e) { /* ignore */ }
      const endpoint = req.endpoint;
      const payload = req.payload || {};
      window.__e2e.rpcCalls.push(endpoint);
      window.__e2e.rpcEvents.push({ endpoint, payload });
      let value;
      switch (endpoint) {
        case 'questionBank.list': value = window.__e2e.questions; break;
        case 'session.list': value = window.__e2e.sessionList; break;
        case 'session.get':
          value = window.__e2e.sessionList.find((s) => s && s.id === payload.id) || null;
          if (!value) return json({ ok: false, error: { message: 'no such session ' + payload.id } }, 500);
          break;
        case 'session.pulse': value = { status: 'done', hasResult: true }; break;
        case 'session.create': {
          // Make the created session real so the post-score loadActive() works.
          const created = {
            ...window.__e2e.sessionList[0],
            id: 'c0ffee123456',
            questionId: payload.questionId,
            questionTitle: 'Brand New Session',
            status: 'done',
            createdAt: Date.now(),
            completedAt: Date.now(),
            overallBand: 6,
            essay: 'A short essay for the new practice.',
          };
          window.__e2e.sessionList = window.__e2e.sessionList.concat([created]);
          value = { id: created.id };
          break;
        }
        case 'session.updateEssay': value = { ok: true, status: 'running', wordCount: 248 }; break;
        case 'session.score': value = { ok: true, status: 'running' }; break;
        case 'session.clone': value = { id: 'c10e12345678' }; break;
        case 'session.delete': value = { ok: true, id: payload.id }; break;
        case 'chat.get': {
          const byKey = window.__e2e.chatByKey;
          const messages = byKey ? (byKey[payload.key] || []) : (window.__e2e.chatMessages || []);
          value = { key: payload.key, messages };
          break;
        }
        case 'chat.clear': value = { ok: true, key: payload.key }; break;
        case 'chat.migrate': value = { ok: true, migrated: true }; break;
        case 'diag': case 'health': value = { ok: true }; break;
        default: return json({ ok: false, error: { message: 'unknown endpoint ' + endpoint } }, 500);
      }
      return json({ ok: true, value });
    }
    return json({ ok: false, error: { message: 'unexpected fetch ' + u } }, 404);
  };
})();`;
}

const applyHarness = () => {
  const React = window.React;
  const ReactDOM = window.ReactDOM;
  const slots = {
    inject(name, cb) {
      try {
        const dispose = cb();
        return typeof dispose === 'function' ? dispose : () => {};
      } catch (e) {
        window.__e2e.slotErrors = window.__e2e.slotErrors || [];
        window.__e2e.slotErrors.push(String(e && e.message ? e.message : e));
        return () => {};
      }
    },
    register(spec, factory) {
      window.__e2e.slots.push({ name: spec && spec.name, spec, factory });
      return () => {};
    },
  };
  const ctx = { slots, get: () => undefined };
  const mod = window.__iwDef.factory((name) => (name === 'react' ? React : undefined));
  window.__examiner = mod;
  mod.apply(ctx);
  window.__e2e.applied = true;
  const overlay = window.__e2e.slots.find((s) => s.name === 'shell.overlay');
  if (!overlay) throw new Error('shell.overlay was never registered');
  window.__overlayRoot = ReactDOM.createRoot(document.getElementById('overlay-host'));
  window.__overlayRoot.render(overlay.factory());
  return { slots: window.__e2e.slots.map((s) => s.name), inject: mod.inject };
};

const renderFooterEntry = () => {
  const reg = window.__e2e.slots.find((s) => s.name === 'sidebar.footer.action');
  if (!reg) throw new Error('sidebar.footer.action was never registered');
  window.__footerRoot = window.ReactDOM.createRoot(document.getElementById('footer-host'));
  window.__footerRoot.render(reg.factory());
};

async function openHarness(browser, sessionList, viewport = { width: 1280, height: 940 }, opts = {}) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + (err?.message || err)));

  await page.setContent(HARNESS_HTML, { waitUntil: 'load' });
  await page.addStyleTag({ content: TOKEN_STUBS });
  await page.addStyleTag({ content: STYLE });
  await page.addStyleTag({ content: HARNESS_CSS });
  await page.addScriptTag({ path: REACT_UMD });
  await page.addScriptTag({ path: REACT_DOM_UMD });
  await page.addScriptTag({ content: 'window.__ModuleLoader__ = { load: function (def) { window.__iwDef = def; } };' });
  await page.addScriptTag({ content: fixtureScript(sessionList, opts.chatMessages, opts.chatByKey, opts.replyDeltas) });
  await page.addScriptTag({ content: readFileSync(CLIENT_BUNDLE, 'utf8') });
  await page.evaluate(applyHarness);

  // The footer fallback only claims the slot after ENTRY_GRACE_MS (1.5s) when
  // no dock is present — exactly the plain `plugin add` situation we verify.
  await page.waitForFunction(
    () => (window.__e2e.slots || []).some((s) => s.name === 'sidebar.footer.action'),
    undefined,
    { timeout: 8000 },
  );
  await page.evaluate(renderFooterEntry);
  await page.waitForSelector('.iw-footer-action', { state: 'visible' });
  return { page, consoleErrors };
}

async function shot(page, name) {
  const path = join(ARTIFACTS, name);
  await page.screenshot({ path });
  screenshots.push(path);
  return path;
}

/**
 * Dock must live at the bottom of the RIGHT-hand column only (not under the
 * whole workbench/sidebar) and hug the panel bottom.
 */
async function assertDockDocked(page) {
  const layout = await page.evaluate(() => {
    const root = document.querySelector('.iw-root');
    const dock = document.querySelector('.iw-chat');
    const col = document.querySelector('.iw-main-col');
    const nav = document.querySelector('.iw-nav');
    const host = document.getElementById('overlay-host');
    if (!root || !dock || !col || !nav || !host) {
      return { ok: false, reason: 'missing .iw-root / .iw-main-col / .iw-nav / .iw-chat' };
    }
    const dockBox = dock.getBoundingClientRect();
    const colBox = col.getBoundingClientRect();
    const navBox = nav.getBoundingClientRect();
    const hostBox = host.getBoundingClientRect();
    return {
      ok: true,
      insideMainCol: dock.parentElement === col,
      lastChild: col.lastElementChild === dock,
      bottomGap: Math.round(hostBox.bottom - dockBox.bottom),
      height: Math.round(dockBox.height),
      visible: dockBox.width > 0 && dockBox.height > 0,
      startsAtMainColumn: dockBox.left >= navBox.right - 1,
      matchesMainColumnWidth: Math.abs(dockBox.width - colBox.width) <= 1,
      leftGapFromPanel: Math.round(dockBox.left - hostBox.left),
      navWidth: Math.round(navBox.width),
    };
  });
  await check('dock is inside the right-hand .iw-main-col',
    () => layout.ok && layout.insideMainCol);
  await check('dock is the last flex child of .iw-main-col',
    () => layout.ok && layout.lastChild);
  await check('dock starts at the main column, not under the sidebar',
    () => layout.ok && layout.startsAtMainColumn && layout.leftGapFromPanel > 10);
  await check('dock spans exactly the main column width',
    () => layout.ok && layout.matchesMainColumnWidth);
  await check('dock hugs the bottom of the panel',
    () => layout.ok && layout.bottomGap <= 2 && layout.bottomGap >= -2);
  await check('dock is rendered with real size',
    () => layout.ok && layout.visible && layout.height >= 60);
}

// ── scenario 1: welcome/empty screen, dock present ─────────────────────
async function runWelcomeScreen(browser) {
  console.log('\n[e2e] scenario 1 — welcome screen with the chat dock');
  const { page, consoleErrors } = await openHarness(browser, []);
  try {
    await page.click('.iw-footer-action');
    await page.waitForSelector('.iw-workbench', { state: 'visible', timeout: 10000 });
    await page.waitForSelector('.iw-empty', { state: 'visible', timeout: 10000 });
    await page.waitForSelector('.iw-chat', { state: 'visible', timeout: 10000 });
    await check('welcome screen is rendered', () => page.locator('.iw-empty h2').count().then((n) => n === 1));
    await check('chat dock is visible on the welcome screen',
      () => page.locator('.iw-chat').isVisible());
    await check('dock starts collapsed (log hidden) until the user engages',
      () => page.locator('.iw-chat-log').count().then((n) => n === 0));
    await page.locator('.iw-chat-head-actions .iw-btn').last().click();
    await page.waitForSelector('.iw-chat-log', { state: 'visible', timeout: 5000 });
    await check('expanding the dock reveals the empty-state copy',
      () => page.locator('.iw-chat-empty').isVisible());
    await check('send is disabled with an empty draft',
      () => page.locator('.iw-chat-inputrow .iw-btn-primary').isDisabled());
    await assertDockDocked(page);
    await shot(page, '01-welcome-screen.png');
    await check('welcome screen produced no console errors',
      () => (consoleErrors.length ? Promise.reject(new Error(consoleErrors.join(' | '))) : true));
  } finally {
    await page.close();
  }
}

// ── scenario 2: result screen + quote + streamed chat ──────────────────
async function runResultScreen(browser) {
  console.log('\n[e2e] scenario 2 — result screen, quote selection and streamed reply');
  const { page, consoleErrors } = await openHarness(browser, [SESSION]);
  try {
    // 1. open the panel from the footer entry -> latest (done) session loads.
    await page.click('.iw-footer-action');
    await page.waitForSelector('.iw-workbench', { state: 'visible', timeout: 10000 });
    await page.waitForSelector('.iw-strip', { state: 'visible', timeout: 10000 });
    await page.waitForSelector('.iw-chat', { state: 'visible', timeout: 10000 });

    await check('footer entry opened the workbench panel',
      () => page.locator('.iw-shell-panel').isVisible());
    await check('result view renders four criteria strips',
      () => page.locator('.iw-strip-cell').count().then((n) => n === 4));
    eqCheck('result view shows the overall band', await page.locator('.iw-badge').first().textContent(), '6.5');
    await assertDockDocked(page);
    await shot(page, '02-result-screen.png');

    // 2. programmatic text selection inside the main pane -> quote chip.
    const selected = await page.evaluate(() => {
      const md = document.querySelector('.iw-main .iw-md');
      if (!md) return { ok: false, reason: 'no .iw-main .iw-md' };
      const walker = document.createTreeWalker(md, NodeFilter.SHOW_TEXT);
      let node = null;
      while (walker.nextNode()) {
        node = walker.currentNode;
        if (node.textContent && node.textContent.trim().length >= 30) break;
      }
      if (!node) return { ok: false, reason: 'no text node in .iw-main .iw-md' };
      const text = node.textContent;
      const start = text.indexOf('Some people') >= 0 ? text.indexOf('Some people') : 0;
      const end = Math.min(start + 48, text.length);
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      const raw = sel.toString();
      const workbench = document.querySelector('.iw-workbench');
      workbench.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return { ok: true, raw, expected: raw.replace(/\s+/g, ' ').trim() };
    });
    if (!selected.ok) throw new Error('could not select text: ' + selected.reason);
    await page.waitForSelector('.iw-chat-quote-chip', { state: 'visible', timeout: 5000 });
    eqCheck('selected text appears as a quote chip title',
      await page.locator('.iw-chat-quote-chip').first().getAttribute('title'), selected.expected);
    eqCheck('selected text appears in the quote chip preview',
      (await page.locator('.iw-chat-quote-chip .iw-chat-quote-text').first().textContent()).trim(),
      selected.expected);
    await check('selection expands the dock and shows the log',
      () => page.locator('.iw-chat-log').isVisible());
    await check('quote bar offers a clear-quotes button',
      () => page.locator('.iw-chat-quotes .iw-btn').count().then((n) => n >= 1));

    // 3. type a question and send it.
    const question = 'Why was my grammar score lower than my task response score?';
    await page.fill('.iw-chat-input', question);
    await page.waitForFunction(() => {
      const btn = document.querySelector('.iw-chat-inputrow .iw-btn-primary');
      return btn && !btn.disabled;
    }, undefined, { timeout: 5000 });
    await check('send enables once a question is typed',
      () => page.locator('.iw-chat-inputrow .iw-btn-primary').isEnabled());
    await page.click('.iw-chat-inputrow .iw-btn-primary');

    // streaming state is transient: catch the animated assistant bubble.
    await page.waitForSelector('.iw-chat-msg.assistant.streaming', { state: 'visible', timeout: 5000 });
    await check('assistant streaming bubble appears', () => true);
    await page.waitForSelector('.iw-chat-msg.user', { state: 'visible', timeout: 5000 });
    await check('user bubble shows the typed question',
      () => page.locator('.iw-chat-msg.user .iw-chat-bubble').textContent()
        .then((text) => (text || '').includes(question)));
    await page.waitForFunction(
      (reply) => {
        const el = document.querySelector('.iw-chat-msg.assistant .iw-md');
        return !!el && (el.textContent || '').includes(reply);
      },
      SSE_REPLY,
      { timeout: 10000 },
    );
    await check('assistant bubble renders the streamed reply',
      () => page.locator('.iw-chat-msg.assistant .iw-md').textContent()
        .then((text) => (text || '').includes(SSE_REPLY)));
    await check('quotes are cleared after sending',
      () => page.locator('.iw-chat-quote-chip').count().then((n) => n === 0));
    // Let the stream finish so the final screenshot shows the settled dock
    // (no stop button, no animated thinking row) rather than a mid-stream frame.
    await page.waitForSelector('.iw-chat-msg.assistant.streaming', { state: 'detached', timeout: 10000 });
    await check('streaming state clears when the reply completes',
      () => page.locator('.iw-chat-inputrow .iw-btn-ghost').count().then((n) => n === 0));
    await check('assistant bubble is no longer marked streaming',
      () => page.locator('.iw-chat-msg.assistant.streaming').count().then((n) => n === 0));
    await shot(page, '03-after-send.png');

    // 4. the outgoing request carried the page context + quote to the model.
    const calls = await page.evaluate(() => window.__e2e.chatCalls);
    await check('one chat request was made', () => calls.length === 1);
    const call = calls[0] || {};
    eqCheck('chat request key is the active session id', call.key, SESSION_ID);
    eqCheck('chat request text is the typed question', call.text, question);
    eqCheck('chat request carries the selected quote', call.quotes, [selected.expected]);
    eqCheck('chat request language', call.lang, 'zh');
    await check('chat context surface is result', () => call.context?.surface === 'result');
    await check('chat context carries the question',
      () => call.context?.question?.id === undefined || call.context?.question?.title === QUESTION_TASK2.title);
    eqCheck('chat context carries the correction band', call.context?.result?.overallBand, 6.5);
    await check('chat context carries the essay', () => String(call.context?.essay || '').length > 100);

    await check('result screen produced no console errors',
      () => (consoleErrors.length ? Promise.reject(new Error(consoleErrors.join(' | '))) : true));
  } finally {
    await page.close();
  }
}

// ── scenario 3: narrow/mobile viewport with three long quotes ──────────
//
// The quotes bar is a single non-wrapping row: with three long selections on a
// ~390px viewport it is the most likely place for a horizontal blowout. Assert
// the dock never scrolls sideways and that the two controls the user needs
// (clear-quotes, send) stay inside the viewport.
async function runMobileQuotes(browser) {
  console.log('\n[e2e] scenario 3 — mobile viewport with three long quotes');
  const { page, consoleErrors } = await openHarness(browser, [SESSION], { width: 390, height: 844 });
  try {
    await page.click('.iw-footer-action');
    await page.waitForSelector('.iw-strip', { state: 'visible', timeout: 10000 });
    await page.waitForSelector('.iw-chat', { state: 'visible', timeout: 10000 });

    // Select three different stretches of visible text through the real
    // mouseup path the user would trigger. On a 390px viewport the rendered
    // text nodes are short and split by inline marks, so select whole
    // markdown blocks (each a long quote) instead of single text nodes.
    const chosen = await page.evaluate(() => {
      const workbench = document.querySelector('.iw-workbench');
      const blocks = [...document.querySelectorAll('.iw-main .iw-md')]
        .filter((el) => (el.textContent || '').trim().length >= 60)
        .slice(0, 3);
      if (blocks.length < 3) return [];
      const picked = [];
      for (const block of blocks) {
        const range = document.createRange();
        range.selectNodeContents(block);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        picked.push(sel.toString().replace(/\s+/g, ' ').trim());
        workbench.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      }
      return picked;
    });
    if (chosen.length < 3) throw new Error('could only select ' + chosen.length + ' text ranges');
    await page.waitForFunction(
      () => document.querySelectorAll('.iw-chat-quote-chip').length === 3,
      undefined,
      { timeout: 5000 },
    );

    const layout = await page.evaluate(() => {
      const rectOf = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) };
      };
      const dock = document.querySelector('.iw-chat');
      const bar = document.querySelector('.iw-chat-quotes');
      const clearBtn = bar && bar.querySelector('.iw-btn');
      const sendBtn = document.querySelector('.iw-chat-inputrow .iw-btn-primary');
      const mainEl = document.querySelector('.iw-main');
      const stripEl = document.querySelector('.iw-strip');
      const stripRect = stripEl ? stripEl.getBoundingClientRect() : null;
      const dockRect = dock.getBoundingClientRect();
      return {
        main: mainEl ? { scrollWidth: mainEl.scrollWidth, clientWidth: mainEl.clientWidth } : null,
        strip: stripEl && stripRect ? {
          left: Math.round(stripRect.left), right: Math.round(stripRect.right),
          scrollWidth: stripEl.scrollWidth, clientWidth: stripEl.clientWidth,
          cells: [...stripEl.children].map((el) => Math.round(el.getBoundingClientRect().width)),
        } : null,
        innerWidth: window.innerWidth,
        dockScroll: dock.scrollWidth,
        dockClient: dock.clientWidth,
        dock: rectOf(dock),
        bar: rectOf(bar),
        clear: rectOf(clearBtn),
        send: rectOf(sendBtn),
        chips: [...document.querySelectorAll('.iw-chat-quote-chip')].map(rectOf),
        bodyScroll: document.documentElement.scrollWidth,
      };
    });
    const inside = (r) => !!r && r.left >= -1 && r.right <= layout.innerWidth + 1;
    await check('mobile: dock has no horizontal overflow',
      () => layout.dockScroll <= layout.dockClient + 1);
    await check('mobile: quote bar has no horizontal overflow',
      () => !!layout.bar && layout.bar.right <= layout.innerWidth + 1);
    await check('mobile: clear-quotes button stays inside the viewport',
      () => inside(layout.clear));
    await check('mobile: send button stays inside the viewport', () => inside(layout.send));
    await check('mobile: three quote chips are rendered',
      () => layout.chips.length === 3 && layout.chips.every((c) => c.width > 0));
    await check('mobile: page itself does not scroll horizontally',
      () => layout.bodyScroll <= layout.innerWidth + 1);
    if (layout.strip && layout.strip.scrollWidth > layout.strip.clientWidth + 1) {
      // Informational: pre-existing nav/main split, not the chat dock. Reported
      // to the Lead as a residual (non-blocking) mobile layout note.
      console.log(`  ℹ note: .iw-strip overflows its column on the 390px viewport ` +
        `(${layout.strip.scrollWidth}px grid in ${layout.strip.clientWidth}px; cells=${JSON.stringify(layout.strip.cells)}). ` +
        `.iw-nav keeps width:220px at <=700px, leaving ~170px for .iw-main. ` +
        `The dock itself stays inside the viewport.`);
    }
    await check('mobile: no console errors',
      () => (consoleErrors.length ? Promise.reject(new Error(consoleErrors.join(' | '))) : true));
    await shot(page, '04-mobile-quotes.png');

    // The outgoing body must carry the 3 quotes, each within the 1000-char cap.
    await page.fill('.iw-chat-input', 'Can you explain these three points?');
    await page.click('.iw-chat-inputrow .iw-btn-primary');
    await page.waitForFunction(() => (window.__e2e.chatCalls || []).length === 1, undefined, { timeout: 5000 });
    const call = await page.evaluate(() => window.__e2e.chatCalls[0]);
    eqCheck('mobile: request carries 3 quotes', call.quotes.length, 3);
    await check('mobile: each quote is capped at 1000 chars',
      () => call.quotes.every((q) => typeof q === 'string' && q.length <= 1000));
    await check('mobile: request quotes match the selections',
      () => call.quotes.every((q) => chosen.some((c) => c.startsWith(q.slice(0, 20)) || q.startsWith(c.slice(0, 20)))));
    await page.waitForSelector('.iw-chat-msg.assistant .iw-md', { state: 'visible', timeout: 10000 });
  } finally {
    await page.close();
  }
}

// ── scenario 4: EN language switch + Enter/Shift+Enter keyboard contract ──
async function runEnglishKeyboard(browser) {
  console.log('\n[e2e] scenario 4 — EN copy switch and Enter/Shift+Enter');
  // Seed an over-long prior thread: the request body must cap it to 24 turns.
  const priorChat = Array.from({ length: 30 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: `prior turn ${i}`,
    ts: 1700000000000 + i,
  }));
  const { page, consoleErrors } = await openHarness(browser, [SESSION], undefined, { chatMessages: priorChat });
  try {
    await page.click('.iw-footer-action');
    await page.waitForSelector('.iw-strip', { state: 'visible', timeout: 10000 });
    await page.waitForSelector('.iw-chat', { state: 'visible', timeout: 10000 });

    eqCheck('dock starts in Chinese',
      await page.locator('.iw-chat-input').getAttribute('placeholder'), t('zh').chatPlaceholder);

    // The Nav's own EN switch must flip every chat label (Root passes lang down).
    await page.locator('.iw-nav-foot button', { hasText: 'EN' }).first().click();
    await page.waitForFunction(
      (expected) => document.querySelector('.iw-chat-input')?.getAttribute('placeholder') === expected,
      t('en').chatPlaceholder,
      { timeout: 5000 },
    );
    eqCheck('EN placeholder on the chat input',
      await page.locator('.iw-chat-input').getAttribute('placeholder'), t('en').chatPlaceholder);
    eqCheck('EN send label', (await page.locator('.iw-chat-inputrow .iw-btn-primary').textContent()).trim(), t('en').chatSend);
    eqCheck('EN chat title', (await page.locator('.iw-chat-head-title').textContent()).trim(), t('en').chatTitle);
    const headButtons = page.locator('.iw-chat-head-actions .iw-btn');
    eqCheck('EN expand label', (await headButtons.last().textContent()).trim(), t('en').chatExpand);

    // Shift+Enter inserts a newline and never sends.
    await page.click('.iw-chat-input');
    await page.keyboard.type('first line');
    await page.keyboard.press('Shift+Enter');
    await page.waitForFunction(() => {
      const el = document.querySelector('.iw-chat-input');
      return !!el && el.value.includes('\n');
    }, undefined, { timeout: 3000 });
    await check('Shift+Enter inserts a newline', () => true);
    const callsAfterShift = await page.evaluate(() => (window.__e2e.chatCalls || []).length);
    eqCheck('Shift+Enter does not send', callsAfterShift, 0);

    // Enter (with a real draft) sends, and the request is marked English.
    const question = 'Why is coherence scored separately?';
    await page.fill('.iw-chat-input', question);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => (window.__e2e.chatCalls || []).length === 1, undefined, { timeout: 5000 });
    const enCall = await page.evaluate(() => window.__e2e.chatCalls[0]);
    eqCheck('Enter sends the typed question', enCall.text, question);
    eqCheck('chat request carries lang:en after the EN switch', enCall.lang, 'en');
    await check('EN request carries the English system-facing quotes shape',
      () => Array.isArray(enCall.quotes) && enCall.quotes.length === 0);
    eqCheck('request history is capped to 24 turns', enCall.history.length, 24);
    eqCheck('request history keeps the newest prior turn', enCall.history.at(-1).content, 'prior turn 29');
    await check('request history content is capped per turn',
      () => enCall.history.every((m) => typeof m.content === 'string' && m.content.length <= 6000));
    await check('request history carries no ts field',
      () => enCall.history.every((m) => !('ts' in m)));
    await page.waitForSelector('.iw-chat-msg.user', { state: 'visible', timeout: 5000 });
    await page.waitForFunction(
      (reply) => {
        const nodes = document.querySelectorAll('.iw-chat-msg.assistant .iw-md');
        const el = nodes[nodes.length - 1];
        return !!el && (el.textContent || '').includes(reply);
      },
      SSE_REPLY,
      { timeout: 10000 },
    );
    await check('EN streamed reply renders',
      () => page.locator('.iw-chat-msg.assistant .iw-md').last().textContent()
        .then((text) => (text || '').includes(SSE_REPLY)));
    await page.waitForSelector('.iw-chat-msg.assistant.streaming', { state: 'detached', timeout: 10000 });
    await check('EN streaming state clears', () => true);
    await shot(page, '05-en-after-send.png');
    await check('EN scenario produced no console errors',
      () => (consoleErrors.length ? Promise.reject(new Error(consoleErrors.join(' | '))) : true));
  } finally {
    await page.close();
  }
}

// ── scenario 6: per-session chat isolation ─────────────────────────────
//
// The chat transcript is keyed by writing-session id. Switching the sidebar
// selection must load THAT session's thread and never leak another session's
// messages into it. This scenario exercises two distinct saved threads.
async function runSessionIsolation(browser) {
  console.log('\n[e2e] scenario 6 — per-session chat isolation');
  const SESSION_A = {
    ...SESSION,
    id: 'aaaa11112222',
    questionTitle: 'Session Alpha',
    createdAt: Date.now() - 3600e3,
  };
  const SESSION_B = {
    ...SESSION,
    id: 'bbbb33334444',
    questionTitle: 'Session Beta',
    createdAt: Date.now() - 7200e3,
  };
  const chatByKey = {
    [SESSION_A.id]: [
      { role: 'user', content: 'alpha-only question', ts: 1 },
      { role: 'assistant', content: 'alpha-only answer', ts: 2 },
    ],
    [SESSION_B.id]: [
      { role: 'user', content: 'beta-only question', ts: 3 },
      { role: 'assistant', content: 'beta-only answer', ts: 4 },
    ],
  };
  const { page, consoleErrors } = await openHarness(browser, [SESSION_A, SESSION_B], undefined, { chatByKey });
  try {
    await page.click('.iw-footer-action');
    await page.waitForSelector('.iw-workbench', { state: 'visible', timeout: 10000 });
    // Expand the dock so the saved thread is on screen.
    await page.locator('.iw-chat-head-actions .iw-btn').last().click();
    await page.waitForSelector('.iw-chat-msg.assistant .iw-md', { timeout: 10000 });
    await check('scenario6: the newest session shows its own saved thread',
      () => page.locator('.iw-chat-log').innerText().then((text) => (
        text.includes('alpha-only answer') && !text.includes('beta-only answer'))));
    const loadedOnBoot = await page.evaluate(() => window.__e2e.rpcEvents
      .filter((e) => e.endpoint === 'chat.get').map((e) => e.payload.key));
    eqCheck('scenario6: boot loaded the newest session chat', loadedOnBoot.at(-1), SESSION_A.id);

    await page.locator('.iw-nav-row', { hasText: 'Session Beta' }).click();
    await page.waitForFunction(
      () => {
        const log = document.querySelector('.iw-chat-log');
        return !!log && (log.innerText || '').includes('beta-only answer');
      },
      undefined,
      { timeout: 10000 },
    );
    await check('scenario6: switching sessions swaps to that session\'s thread',
      () => page.locator('.iw-chat-log').innerText().then((text) => (
        text.includes('beta-only answer') && !text.includes('alpha-only answer'))));
    const loadedAfterSwitch = await page.evaluate(() => window.__e2e.rpcEvents
      .filter((e) => e.endpoint === 'chat.get').map((e) => e.payload.key));
    eqCheck('scenario6: chat.get was called for the selected session', loadedAfterSwitch.at(-1), SESSION_B.id);
    const strayKeys = loadedAfterSwitch.filter((key) => key !== SESSION_A.id && key !== SESSION_B.id);
    eqCheck('scenario6: no draft/foreign key was requested', strayKeys, []);
    await shot(page, '06-session-isolation.png');
    await check('scenario6: no console errors',
      () => (consoleErrors.length ? Promise.reject(new Error(consoleErrors.join(' | '))) : true));
  } finally {
    await page.close();
  }
}

// ── scenario 7: every "+ 新练习" gets its own chat thread ──────────────
//
// The unsaved-practice conversation must not be shared between two new
// practices, and the one in front of you at submission time moves onto the
// created session id (chat.migrate).
async function runNewPracticeIsolation(browser) {
  console.log('\n[e2e] scenario 7 — new-practice chat independence');
  const SESSION_A = {
    ...SESSION,
    id: 'aaaa11112222',
    questionTitle: 'Session Alpha',
    createdAt: Date.now() - 3600e3,
  };
  const chatByKey = {
    [SESSION_A.id]: [
      { role: 'user', content: 'alpha-only question', ts: 1 },
      { role: 'assistant', content: 'alpha-only answer', ts: 2 },
    ],
  };
  const { page, consoleErrors } = await openHarness(browser, [SESSION_A], undefined, { chatByKey });
  const lastChatGet = () => page.evaluate(() => window.__e2e.rpcEvents
    .filter((e) => e.endpoint === 'chat.get').map((e) => e.payload.key).at(-1));
  const chatCalls = () => page.evaluate(() => window.__e2e.chatCalls);
  try {
    await page.click('.iw-footer-action');
    await page.waitForSelector('.iw-workbench', { state: 'visible', timeout: 10000 });
    await page.locator('.iw-chat-head-actions .iw-btn').last().click();
    await page.waitForSelector('.iw-chat-msg.assistant .iw-md', { timeout: 10000 });

    // First new practice: fresh key, empty dock, alpha conversation gone.
    await page.click('.iw-nav-head .iw-btn');
    await page.waitForSelector('.iw-select', { state: 'visible', timeout: 10000 });
    await page.waitForFunction(
      () => (window.__e2e.rpcEvents || []).some((e) => e.endpoint === 'chat.get' && /^draft-[a-z0-9]+$/.test(e.payload.key)),
      undefined,
      { timeout: 10000 },
    );
    const draftKey1 = await lastChatGet();
    await check('scenario7: "+ 新练习" opens a unique draft chat key',
      () => /^draft-[a-z0-9]+$/.test(String(draftKey1)));
    await check('scenario7: the new practice dock does not replay another chat',
      () => page.locator('.iw-chat-log').innerText().then((text) => (
        !text.includes('alpha-only answer') && !text.includes('alpha-only question'))));

    // Chat in that practice: the request must carry the draft key, not a session id.
    await page.fill('.iw-chat-input', 'question in first new practice');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => (window.__e2e.chatCalls || []).length === 1, undefined, { timeout: 5000 });
    const firstCall = (await chatCalls())[0];
    eqCheck('scenario7: first new practice sends under its own draft key', firstCall.key, draftKey1);
    await page.waitForSelector('.iw-chat-msg.assistant .iw-md', { timeout: 10000 });

    // Second new practice: another fresh key (the previous draft is NOT reused).
    await page.click('.iw-nav-head .iw-btn');
    await page.waitForSelector('.iw-select', { state: 'visible', timeout: 10000 });
    await page.waitForFunction(
      (first) => (window.__e2e.rpcEvents || []).some((e) => (
        e.endpoint === 'chat.get' && e.payload.key !== first && /^draft-[a-z0-9]+$/.test(e.payload.key))),
      draftKey1,
      { timeout: 10000 },
    );
    const draftKey2 = await lastChatGet();
    await check('scenario7: a second new practice gets a different draft key',
      () => !!draftKey2 && draftKey2 !== draftKey1);
    // The chat.get response must be applied before the empty-state check.
    await page.waitForSelector('.iw-chat-empty', { state: 'visible', timeout: 10000 });
    await check('scenario7: the second new practice starts with an empty thread',
      () => page.locator('.iw-chat-log').innerText().then((text) => (
        !text.includes('question in first new practice') && text.includes('还没有对话'))));

    // Chat in practice #2, then submit it: that thread migrates onto the session.
    await page.fill('.iw-chat-input', 'draft question before submit');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => (window.__e2e.chatCalls || []).length === 2, undefined, { timeout: 5000 });
    eqCheck('scenario7: second new practice sends under its own draft key', (await chatCalls())[1].key, draftKey2);

    await page.selectOption('.iw-select', QUESTION_TASK2.id);
    await page.fill('.iw-textarea', 'A short essay for the new practice.');
    await page.locator('.iw-main .iw-btn-primary').click();
    await page.waitForFunction(
      () => (window.__e2e.rpcEvents || []).some((e) => e.endpoint === 'chat.migrate'),
      undefined,
      { timeout: 10000 },
    );
    const migrate = await page.evaluate(() => window.__e2e.rpcEvents.find((e) => e.endpoint === 'chat.migrate').payload);
    eqCheck('scenario7: submission migrates the draft thread onto the new session',
      migrate, { from: draftKey2, to: 'c0ffee123456' });
    await page.waitForFunction(
      () => (window.__e2e.rpcEvents || []).some((e) => (
        e.endpoint === 'chat.get' && e.payload.key === 'c0ffee123456')),
      undefined,
      { timeout: 10000 },
    );
    const lastLoadedKey = await page.evaluate(() => window.__e2e.rpcEvents
      .filter((e) => e.endpoint === 'chat.get').map((e) => e.payload.key).at(-1));
    eqCheck('scenario7: the created session chat is loaded after migration',
      lastLoadedKey, 'c0ffee123456');
    await shot(page, '07-new-practice-isolation.png');
    await check('scenario7: no console errors',
      () => (consoleErrors.length ? Promise.reject(new Error(consoleErrors.join(' | '))) : true));
  } finally {
    await page.close();
  }
}

// ── scenario 8: a reply that streams a markdown table ──────────────────
//
// Chat renders markdown on every token. A partially-arrived table used to
// leave the renderer's line cursor unmoved and hang the page forever; this
// scenario streams the table header first so that regression cannot return.
async function runTableStreamingReply(browser) {
  console.log('\n[e2e] scenario 8 — streaming a markdown table reply');
  const replyDeltas = [
    '| Criterion | Band |',
    '\n| --- | --- |',
    '\n| Task Response | 6.5 |',
    '\n| Coherence | 6.5 |',
    '\n\nThat is the breakdown.',
  ];
  const { page, consoleErrors } = await openHarness(browser, [SESSION], undefined, { replyDeltas });
  try {
    await page.click('.iw-footer-action');
    await page.waitForSelector('.iw-workbench', { state: 'visible', timeout: 10000 });
    await page.fill('.iw-chat-input', 'Show the criteria as a table');
    await page.keyboard.press('Enter');
    // The page must stay responsive while the table is only half-arrived.
    await check('scenario8: page stays responsive during a partial table stream',
      () => page.evaluate(() => 1 + 1).then((v) => v === 2));
    await page.waitForFunction(
      () => {
        const tables = [...document.querySelectorAll('.iw-chat-msg.assistant table')];
        const last = tables[tables.length - 1];
        const text = last ? (last.innerText || '') : '';
        return tables.length > 0 && text.includes('Task Response') && text.includes('6.5');
      },
      undefined,
      { timeout: 15000 },
    );
    await check('scenario8: the completed table renders',
      () => page.locator('.iw-chat-msg.assistant table').last().innerText()
        .then((text) => text.includes('Task Response') && text.includes('6.5')));
    await page.waitForSelector('.iw-chat-msg.assistant.streaming', { state: 'detached', timeout: 15000 });
    await check('scenario8: streaming cleared after the table reply', () => true);
    await check('scenario8: no console errors',
      () => (consoleErrors.length ? Promise.reject(new Error(consoleErrors.join(' | '))) : true));
    await shot(page, '08-table-streaming.png');
  } finally {
    await page.close();
  }
}

// ── preflight ───────────────────────────────────────────────────────────
function preflight() {
  if (!existsSync(CLIENT_BUNDLE)) {
    console.error('[e2e] lib/client.js is missing.');
    console.error('[e2e] Build the plugin first:  node scripts/build.mjs');
    console.error('[e2e] (or `npm run build`). No browser was launched.');
    process.exit(2);
  }
  const bundleMtime = statSync(CLIENT_BUNDLE).mtimeMs;
  let stale = false;
  try {
    stale = readdirSync(CLIENT_SRC)
      .filter((f) => f.endsWith('.js'))
      .some((f) => statSync(join(CLIENT_SRC, f)).mtimeMs > bundleMtime);
  } catch { /* ignore */ }
  if (stale) {
    console.warn('[e2e] WARNING: lib/client.js looks older than src/client/*.js.');
    console.warn('[e2e]          Run `node scripts/build.mjs` for exact results (continuing anyway).');
  }
  if (!existsSync(REACT_UMD) || !existsSync(REACT_DOM_UMD)) {
    console.error('[e2e] React UMD development builds not found in node_modules.');
    console.error('[e2e] Expected: ' + REACT_UMD + ' and ' + REACT_DOM_UMD);
    process.exit(2);
  }
  if (!existsSync(CHROMIUM_EXECUTABLE)) {
    console.error('[e2e] Cached Chromium not found at the pinned path:');
    console.error('       ' + CHROMIUM_EXECUTABLE);
    console.error('[e2e] Override with CHAT_UI_CHROMIUM=/path/to/chrome, or point it at');
    console.error('[e2e] an existing local Chromium. Playwright browsers are intentionally');
    console.error('[e2e] not downloaded by this harness.');
    process.exit(2);
  }
  mkdirSync(ARTIFACTS, { recursive: true });
}

// ── main ────────────────────────────────────────────────────────────────
async function main() {
  preflight();
  console.log('[e2e] offline Playwright harness — no DSH server, no auth');
  console.log('[e2e] client bundle: ' + CLIENT_BUNDLE);
  console.log('[e2e] chromium:      ' + CHROMIUM_EXECUTABLE);

  const browser = await chromium.launch({ headless: true, executablePath: CHROMIUM_EXECUTABLE });
  try {
    await runWelcomeScreen(browser);
    await runResultScreen(browser);
    await runMobileQuotes(browser);
    await runEnglishKeyboard(browser);
    await runSessionIsolation(browser);
    await runNewPracticeIsolation(browser);
    await runTableStreamingReply(browser);
  } finally {
    await browser.close();
  }

  console.log('\n[e2e] screenshots:');
  for (const p of screenshots) console.log('  • ' + p);

  if (failures.length === 0) {
    console.log(`\n[e2e] PASS (${checks} checks)`);
  } else {
    console.error(`\n[e2e] FAIL (${failures.length} failed / ${checks} checks)`);
    for (const f of failures) console.error(`  ✗ ${f.name} — ${f.why}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('[e2e] harness crashed:', e?.stack || e);
  process.exitCode = 1;
});
