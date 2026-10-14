// dsh-ielts-writing-examiner client entry (factory body).
//
// This file is bundled by scripts/build.mjs. The bundle is wrapped in
// window.__ModuleLoader__.load({ id, factory }). Inside the factory, `require`
// gives access to React (provided by @deepseek-ai/dsh-client-runtime).
//
// Slots API (matches dsh-pictor / pomasa-studio):
//   slots.inject(slotName, () => slots.register(spec, () => ReactElement))
// Where spec = { name, id, order, label }. The element factory is called by the
// slot system whenever the element needs to be (re)rendered. slots.inject returns
// an idempotent disposer — we keep it so the fallback entry can be withdrawn
// again once the dock shows up.

import { STYLE } from './styles.js';
import { createApi } from './api.js';
import { createComponents } from './components.js';
import { createPages } from './pages.js';
import { t } from './strings.js';

const RPC = '/ielts-examiner';
const ASSET_BASE = '/ielts-examiner/asset';
// Only what this half actually reads: `slots` for the overlay/footer slots.
// Every request crosses the network over plain fetch (api.js POSTs to
// /ielts-examiner/rpc), so no channel service is needed. `connection` was
// declared here as a hard dependency this half never used — and on 0.2.x an
// unresolvable inject can keep the client half from loading at all.
const inject = ['slots'];

// Dock identity. Shared by three places that must agree: the window registry
// we hand to dsh-app-dock, the `data-dock-app` attribute the dock renders,
// and the verify harness selectors.
const DOCK_ID = 'dsh-ielts-writing-examiner';
// How long we wait for the dock before claiming the footer slot ourselves. The
// dock and this plugin are injected by independent bundle layers, so load order
// is not guaranteed; the dock also dispatches `dsh-app-dock:ready` in a
// setTimeout(0). 1.5s comfortably covers that without a visible dead period.
const ENTRY_GRACE_MS = 1500;

// ── shared panel open/close state ──────────────────────────────
// FooterAction and WorkbenchPanel both call usePanelOpen() so they always
// agree. The panel is ALWAYS mounted (display: none when closed) — this keeps
// React state alive across toggles.
const panel = (() => {
  const subs = new Set();
  return {
    open: false,
    toggle() { this.open = !this.open; subs.forEach((fn) => fn(this.open)); },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
})();

// ── host language ─────────────────────────────────────────────
// Harness 0.2.x ships the locale service as `ctx.get('locale')` — a
// LocaleRuntime with getSnapshot() ({ active, locales, revision }) and
// subscribe(). The old `ctx.get('lang')` getter hook is gone, so read the new
// service first and keep the legacy hook only as a fallback for older hosts.
// Without this the footer button would silently pin itself to zh on 0.2.x.
function createLangStore(ctx) {
  const subs = new Set();
  const norm = (v) => (v === 'en' ? 'en' : 'zh');
  const read = () => {
    try {
      const svc = ctx.get && ctx.get('locale');
      if (svc && typeof svc.getSnapshot === 'function') {
        const snap = svc.getSnapshot();
        if (snap && snap.active) return norm(snap.active);
      }
    } catch { /* ignore */ }
    try {
      const getter = ctx.get && ctx.get('lang');
      if (typeof getter === 'function') return norm(getter());
    } catch { /* ignore */ }
    return 'zh';
  };
  let val = read();
  const set = (next) => {
    const v = norm(next);
    if (val === v) return;
    val = v;
    subs.forEach((fn) => fn(v));
  };
  try {
    const svc = ctx.get && ctx.get('locale');
    if (svc && typeof svc.subscribe === 'function') svc.subscribe(() => set(read()));
  } catch { /* ignore */ }
  return {
    get: () => val,
    set,
    subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); },
  };
}

// ── diagnostics ───────────────────────────────────────────────
// "The entry button never appeared" is the single most common install
// failure, and it has two very different causes: we never registered
// anything, or we registered but the slot never rendered it. Ship both facts
// to the host so ~/.ielts-examiner/diag.jsonl answers it without DevTools.
// extra carries the per-phase fields (entry: dock|footer, dom: boolean, …).
function examinerDiag(phase, extra) {
  const body = {
    ts: new Date().toISOString(),
    phase,
    href: typeof location !== 'undefined' ? String(location.href || '').slice(0, 80) : '',
    ...(extra || {}),
  };
  try { window.__iw_diag = { ...(window.__iw_diag || {}), [phase]: body }; } catch { /* ignore */ }
  try {
    fetch(`${RPC}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'diag', payload: body }),
    }).catch(() => {});
  } catch { /* ignore */ }
  try { console.warn('[dsh-ielts-writing-examiner] diag', body); } catch { /* ignore */ }
}

function apply(ctx) {
  const React = require('react');
  const h = React.createElement;
  const { useState, useEffect } = React;

  // Inject stylesheet once per page load.
  if (typeof document !== 'undefined' && !document.getElementById('iw-styles')) {
    const tag = document.createElement('style');
    tag.id = 'iw-styles';
    tag.textContent = STYLE;
    document.head.appendChild(tag);
  }

  const slots = ctx.slots || (ctx.get && ctx.get('slots'));
  if (!slots) return;

  const api = createApi();
  const c = createComponents(h);
  const p = createPages(React, h, c);
  const lang = createLangStore(ctx);
  // Exposed for diagnosis (and read by verify.mjs): the footer copy is the only
  // host-language consumer here, so a value stuck at 'zh' on an English host
  // is the thing to look at.
  if (typeof window !== 'undefined') window.__iwLang = lang;

  function usePanelOpen() {
    const [open, setOpen] = useState(panel.open);
    useEffect(() => panel.subscribe(setOpen), []);
    return open;
  }

  // Footer copy follows the host language, so it has to re-read on every
  // switch — T is captured once at apply() and would otherwise go stale.
  function useLang() {
    const [value, setValue] = useState(lang.get());
    useEffect(() => lang.subscribe(setValue), []);
    return t(value);
  }

  function FooterAction() {
    const open = usePanelOpen();
    const T = useLang();
    return h('button', {
      className: 'iw-footer-action' + (open ? ' on' : ''),
      type: 'button',
      'data-ielts-entry': 'footer',
      onClick: () => panel.toggle(),
      title: open ? T.footerCloseTitle : T.footerOpenTitle,
      'aria-expanded': open ? 'true' : 'false',
    },
      h('span', { className: 'glyph' }, T.footerGlyph),
      T.footerLabel,
    );
  }

  function WorkbenchPanel() {
    const open = usePanelOpen();
    return h('div', {
      className: 'iw-shell-root',
      style: open ? undefined : { display: 'none' },
    },
      h('div', { className: 'iw-shell-nav' }),
      h('div', { className: 'iw-shell-panel' },
        h(p.Root, {
          api,
          onClose: () => panel.toggle(),
          key: 'iw-root',
        }),
      ),
    );
  }

  // ── entry: dock first, self-owned footer as the fallback ──────
  // dsh-app-dock owns the `sidebar.footer.action` slot and lays member apps
  // out as an icon grid; we just hand it a toggle. But a dock that is only an
  // npm transitive dependency is NOT auto-added to the profile's
  // dsh.profile.bundles, so on a plain `plugin add dsh-ielts-writing-examiner`
  // install the dock's client half never reaches __DSH_BOOT__ and the button
  // would simply not exist. So: try the dock, wait out the grace period, and
  // only then claim the footer slot ourselves. When the dock does turn up it
  // takes precedence and we withdraw our button — one entry, never two.
  let footerEntryDispose = null;
  let dockRegistered = false;

  const dropFooterAction = () => {
    if (!footerEntryDispose) return;
    const dispose = footerEntryDispose;
    footerEntryDispose = null;
    try { dispose(); } catch { /* ignore */ }
  };

  // Registering ≠ rendering. Read the DOM back once to tell "we never
  // registered" apart from "we registered but the slot swallowed it".
  const reportRendered = (entry, selector) => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    window.setTimeout(() => {
      try {
        examinerDiag('entry-rendered', { entry, dom: !!document.querySelector(selector) });
      } catch { /* ignore */ }
    }, 400);
  };

  const registerFooterAction = () => {
    if (footerEntryDispose || dockRegistered) return;
    // Re-check: the dock may have landed between the timer firing and here.
    if (typeof window !== 'undefined' && window.__dshAppDock__) return;
    let dispose;
    try {
      dispose = slots.inject('sidebar.footer.action', () => slots.register(
        { name: 'sidebar.footer.action', id: DOCK_ID, order: 25, label: 'IELTS 写作' },
        () => h(FooterAction, null),
      ));
    } catch { return; }
    footerEntryDispose = typeof dispose === 'function' ? dispose : () => {};
    try { examinerDiag('entry', { entry: 'footer', dock: false }); } catch { /* ignore */ }
    reportRendered('footer', '.iw-footer-action');
  };

  const registerWithDock = () => {
    if (typeof window === 'undefined' || !window.__dshAppDock__) return false;
    if (dockRegistered) return true;
    dockRegistered = true;
    window.__dshAppDock__.register({
      id: DOCK_ID,
      label: 'IELTS 写作',
      icon: '◈',
      order: 25,
      onToggle: () => panel.toggle(),
    });
    // The dock keeps a cluster-wide zh/en preference (localStorage
    // `bandung-lang`). Follow it so our button reads in the same language as
    // the grid around it — adopting the current value as well as later changes,
    // since the store may have been seeded from the host locale in the meantime.
    const dockLang = window.__dshAppDock__.lang;
    if (dockLang) {
      try {
        const syncDockLang = () => {
          const v = dockLang.get();
          if (lang.get() !== v) lang.set(v);
        };
        syncDockLang();
        dockLang.subscribe(syncDockLang);
      } catch { /* ignore */ }
    }
    dropFooterAction();
    try { examinerDiag('entry', { entry: 'dock', dock: true }); } catch { /* ignore */ }
    reportRendered('dock', `[data-dock-app="${DOCK_ID}"]`);
    return true;
  };

  if (typeof window !== 'undefined' && !registerWithDock()) {
    // HMR re-runs apply(). A generation token on window keeps the ready
    // listener and the fallback timer of the newest apply() alive, so a stale
    // closure can't register the dock against a dead panel or race us for the
    // footer slot.
    const gen = (window.__iwEntryGen || 0) + 1;
    window.__iwEntryGen = gen;
    const isCurrent = () => window.__iwEntryGen === gen;
    const onDockReady = () => {
      if (!isCurrent() || !registerWithDock()) return;
      window.removeEventListener('dsh-app-dock:ready', onDockReady);
    };
    if (window.__iwDockReady) window.removeEventListener('dsh-app-dock:ready', window.__iwDockReady);
    window.__iwDockReady = onDockReady;
    window.addEventListener('dsh-app-dock:ready', onDockReady);
    // Grace period: if the dock is still absent afterwards it is not coming
    // (not in profile bundles, or it failed to load) — take the footer.
    window.setTimeout(() => {
      if (!isCurrent()) return;
      if (!registerWithDock()) registerFooterAction();
    }, ENTRY_GRACE_MS);
  }

  // The workbench overlay itself is always ours — the dock only owns the entry.
  slots.inject('shell.overlay', () => slots.register(
    { name: 'shell.overlay', id: DOCK_ID, order: 15, label: 'IELTS 写作' },
    () => h(WorkbenchPanel, null),
  ));
}

// Surface to the ModuleLoader wrapper. esbuild bundles this file as an IIFE,
// so we write to a globalThis slot the wrapper can read after eval.
// _test is the verify.mjs hook — the browser-side __ModuleLoader__ only reads
// inject/apply, so the extra export is inert at runtime.
const _test = {
  createLangStore,
  examinerDiag,
  createComponents,
  createPages,
  DOCK_ID,
  ENTRY_GRACE_MS,
};
const __iw_exports__ = { inject, apply, RPC, ASSET_BASE, DOCK_ID, ENTRY_GRACE_MS, _test };
globalThis.__iw_exports__ = __iw_exports__;

