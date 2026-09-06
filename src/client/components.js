// Reusable UI primitives — factory(h) returns { iwCard, iwBtn, ... }.
//
// We use the factory pattern because require('react') is only valid inside
// the ModuleLoader factory, not at module top level.

export function createComponents(h) {
  function iwCard({ title, action, children, className = '', key }) {
    return h('div', { key, className: 'iw-card ' + className },
      title ? h('h3', { key: 't' }, title) : null,
      action ? h('div', { key: 'a', className: 'iw-card-action' }, action) : null,
      children,
    );
  }

  function iwBtn({ primary, ghost, tiny, disabled, onClick, children, className = '', title, type = 'button', key }) {
    const cls = ['iw-btn'];
    if (primary) cls.push('iw-btn-primary');
    if (ghost) cls.push('iw-btn-ghost');
    if (tiny) cls.push('iw-btn-tiny');
    if (className) cls.push(className);
    return h('button', { key, type, className: cls.join(' '), disabled, onClick, title }, children);
  }

  function iwBadge({ band, key }) {
    const n = Number(band);
    let cls = 'iw-badge ';
    if (!Number.isFinite(n)) cls += 'b-low';
    else if (n >= 7) cls += 'b-high';
    else if (n >= 6) cls += 'b-mid';
    else cls += 'b-low';
    return h('span', { key, className: cls }, Number.isFinite(n) ? n.toFixed(1) : '—');
  }

  function iwDot({ status, key }) {
    return h('span', { key, className: 'iw-dot ' + (status || 'idle'), title: status || 'idle' });
  }

  function iwField({ label, counter, children, key }) {
    return h('label', { key, className: 'iw-field' },
      h('span', { key: 'l' }, label,
        counter ? h('span', { key: 'c', className: 'iw-counter' }, counter) : null),
      children,
    );
  }

  function iwSelect({ value, onChange, options, placeholder, key }) {
    return h('select', {
      key, className: 'iw-select', value: value || '', onChange: (e) => onChange(e.target.value),
    },
      placeholder ? h('option', { key: 'ph', value: '' }, placeholder) : null,
      ...options.map((o) => h('option', { key: o.value, value: o.value }, o.label)),
    );
  }

  function iwTextarea({ value, onChange, placeholder, rows = 10, key }) {
    return h('textarea', {
      key, className: 'iw-textarea', value: value || '',
      placeholder, rows, onChange: (e) => onChange(e.target.value),
    });
  }

  function iwSpinner({ key }) {
    return h('div', { key, className: 'iw-spinner' }, '◈');
  }

  return { iwCard, iwBtn, iwBadge, iwDot, iwField, iwSelect, iwTextarea, iwSpinner };
}
