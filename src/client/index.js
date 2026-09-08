// dsh-ielts-examiner client entry (factory body).
//
// This file is bundled by scripts/build.mjs. The bundle is wrapped in
// window.__ModuleLoader__.load({ id, factory }). Inside the factory, `require`
// gives access to React (provided by @deepseek-ai/dsh-client-runtime).
//
// Slots API (matches dsh-pictor / pomasa-studio):
//   slots.inject(slotName, () => slots.register(spec, () => ReactElement))
// Where spec = { name, id, order, label }. The element factory is called by the
// slot system whenever the element needs to be (re)rendered.

import { STYLE } from './styles.js';
import { createApi } from './api.js';
import { createComponents } from './components.js';
import { createPages } from './pages.js';
import { t } from './strings.js';

const RPC = '/ielts-examiner';
const ASSET_BASE = '/ielts-examiner/asset';
const inject = ['slots', 'connection', 'workspaces', 'sessions'];

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

// Footer label follows the host language. The host exposes a getLang() hook
// via ctx.get('lang') — dsh-web-profile injects it so the sidebar button
// reads in the same language as the rest of the chrome. Defaults to zh when
// the host doesn't speak (e.g. tests, cordis).
function getLang(ctx) {
  const getter = ctx.get && ctx.get('lang');
  if (typeof getter === 'function') {
    try { return getter() || 'zh'; } catch { /* fall through */ }
  }
  return 'zh';
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
  const connection = ctx.connection || (ctx.get && ctx.get('connection'));
  if (!slots) return;

  const api = createApi(connection);
  const c = createComponents(h);
  const p = createPages(React, h, c);
  const lang = getLang(ctx);
  const T = t(lang);

  function usePanelOpen() {
    const [open, setOpen] = useState(panel.open);
    useEffect(() => panel.subscribe(setOpen), []);
    return open;
  }

  function FooterAction() {
    const open = usePanelOpen();
    return h('button', {
      className: 'iw-footer-action' + (open ? ' on' : ''),
      type: 'button',
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

  // Register both slots. The closure form means the slot system can re-render
  // on language/theme changes without us re-mounting everything.
  slots.inject('sidebar.footer.action', () => slots.register(
    { name: 'sidebar.footer.action', id: 'dsh-ielts-examiner', order: 25, label: 'IELTS 写作' },
    () => h(FooterAction, null),
  ));
  slots.inject('shell.overlay', () => slots.register(
    { name: 'shell.overlay', id: 'dsh-ielts-examiner', order: 15, label: 'IELTS 写作' },
    () => h(WorkbenchPanel, null),
  ));
}

// Surface to the ModuleLoader wrapper. esbuild bundles this file as an IIFE,
// so we write to a globalThis slot the wrapper can read after eval.
const __iw_exports__ = { inject, apply, RPC, ASSET_BASE };
globalThis.__iw_exports__ = __iw_exports__;
