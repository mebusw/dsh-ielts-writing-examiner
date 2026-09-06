// dsh-ielts-examiner client half (browser).
//
// Wrapped by scripts/build.mjs into window.__ModuleLoader__.load({ id, factory }).
// Factory's `require` provides react; factory returns { inject, apply }.
//
// Mounts the overlay via slots.sidebar.footer.action + slots.shell.overlay.
// All RPC (/ielts-examiner) goes through `connection.rpc.handle` style calls.

const inject = ['slots', 'connection'];

const RPC = '/ielts-examiner';

// Component, page, style, md, api, export-pdf modules — populated in subsequent steps.
// Each is assigned at runtime via the ModuleLoader require graph; for now the
// skeleton just mounts the footer action and renders an empty overlay.
const components = globalThis.__iw_components__ || {};
const pages = globalThis.__iw_pages__ || {};
const styles = globalThis.__iw_styles__ || '';

function apply(slots, connection) {
  const React = require('react');
  const h = React.createElement;

  // Inject stylesheet once per page load.
  if (styles && !document.getElementById('iw-styles')) {
    const tag = document.createElement('style');
    tag.id = 'iw-styles';
    tag.textContent = styles;
    document.head.appendChild(tag);
  }

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
    return h(pages.Root, { connection, onClose: () => {
      overlayOpen = false;
      slots.shell.overlay.update(null);
    }});
  }

  slots.sidebar.footer.action.add(FooterAction);
  // Initial empty mount — overlay opens on click.
  slots.shell.overlay.update(null);
}

exports.inject = inject;
exports.apply = apply;
