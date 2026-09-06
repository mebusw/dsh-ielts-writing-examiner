// dsh-ielts-examiner client entry (factory body).
//
// This file is bundled by scripts/build.mjs. The bundle is then wrapped in
// window.__ModuleLoader__.load({ id, factory }). Inside the factory, `require`
// gives access to React (provided by @deepseek-ai/dsh-client-runtime).

import { STYLE } from './styles.js';
import { createApi } from './api.js';
import { createComponents } from './components.js';
import { createPages } from './pages.js';

const RPC = '/ielts-examiner';
const ASSET_BASE = '/ielts-examiner/asset';

function apply(slots, connection) {
  const React = require('react');
  const h = React.createElement;

  // Inject stylesheet once per page load.
  if (typeof document !== 'undefined' && !document.getElementById('iw-styles')) {
    const tag = document.createElement('style');
    tag.id = 'iw-styles';
    tag.textContent = STYLE;
    document.head.appendChild(tag);
  }

  const api = createApi(connection);
  const c = createComponents(h);
  const p = createPages(h, c);

  let overlayOpen = false;

  const FooterAction = () => h('button', {
    className: 'iw-footer-action' + (overlayOpen ? ' on' : ''),
    onClick: () => {
      overlayOpen = !overlayOpen;
      slots.shell.overlay.update(renderOverlay());
    },
    title: '打开 IELTS 写作工作台',
  },
    h('span', { className: 'glyph' }, '◈'),
    'IELTS 写作',
  );

  function renderOverlay() {
    if (!overlayOpen) return null;
    return h('div', { className: 'iw-shell-root' },
      h('div', { className: 'iw-shell-nav' }),
      h('div', { className: 'iw-shell-panel' },
        h(p.Root, { api, onClose: () => {
          overlayOpen = false;
          slots.shell.overlay.update(null);
        }}),
      ),
    );
  }

  if (slots.sidebar?.footer?.action?.add) {
    slots.sidebar.footer.action.add(FooterAction);
  }
  if (slots.shell?.overlay?.update) {
    slots.shell.overlay.update(null);
  }
}

exports.inject = ['slots', 'connection'];
exports.apply = apply;
exports.RPC = RPC;
exports.ASSET_BASE = ASSET_BASE;
