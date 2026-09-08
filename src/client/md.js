// md.js — hand-rolled markdown renderer with mermaid pass-through.
//
// No bundle deps. Handles the subset the IELTS prompt emits:
//   headings (#, ##, ###) / paragraphs / bullet lists / ordered lists /
//   blockquotes / inline code / fenced code blocks (incl. ```mermaid) /
//   tables / inline HTML (the prompt emits <del>/<ins>/<mark>/<u>).
//
// Mermaid blocks are rendered after mount via CDN (loaded once, reused).

let mermaidReady = null;

function loadMermaid() {
  if (mermaidReady) return mermaidReady;
  mermaidReady = new Promise((resolve, reject) => {
    if (typeof window === 'undefined') { resolve(null); return; }
    if (window.mermaid) { resolve(window.mermaid); return; }
    // UMD bundle via classic <script>: more robust than the inline ESM
    // dynamic-import dance we had before (some browsers silently swallow
    // module import failures inside inline blob scripts).
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js';
    s.async = true;
    s.onload = () => {
      if (!window.mermaid) {
        reject(new Error('mermaid loaded but window.mermaid missing'));
        return;
      }
      try {
        window.mermaid.initialize({
          startOnLoad: false,
          theme: 'default',
          securityLevel: 'loose',
          fontFamily: 'inherit',
        });
        resolve(window.mermaid);
      } catch (e) {
        reject(new Error('mermaid initialize failed: ' + (e?.message || e)));
      }
    };
    s.onerror = () => reject(new Error('mermaid CDN load failed'));
    document.head.appendChild(s);
  });
  return mermaidReady;
}

// HTML-escape but preserve the inline tags we trust from the LLM.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Resolve relative image path against ASSET_BASE. Asset paths from the
// question bank look like "images-for-task1/foo.png" — we prepend the
// host's asset route so the browser can fetch them.
const MD_ASSET_BASE = (typeof window !== 'undefined')
  ? (window.__iw_exports__?.ASSET_BASE || '/ielts-examiner/asset')
  : '/ielts-examiner/asset';

function resolveImgSrc(url) {
  if (!url) return '';
  if (/^(https?:|data:|\/)/.test(url)) return url;
  return `${MD_ASSET_BASE}/${url}`;
}

// Inline pass: escape first, then re-introduce a small whitelist of tags.
function renderInline(text) {
  let s = escapeHtml(text);
  // Images: ![alt](url) — alt may be empty
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) =>
    `<img src="${resolveImgSrc(url)}" alt="${alt}" style="max-width:100%;height:auto;border-radius:6px;margin:8px 0;display:block;" />`);
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return s;
}

function renderBlocks(md) {
  if (!md) return '';
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // fenced code block (```lang ... ```) — keep as <pre>; mermaid handled later
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1];
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      if (lang === 'mermaid') {
        out.push(`<div class="iw-mermaid" data-mermaid="${escapeHtml(buf.join('\n'))}">${escapeHtml(buf.join('\n'))}</div>`);
      } else {
        out.push(`<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
      }
      continue;
    }

    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lvl = h[1].length;
      out.push(`<h${lvl}>${renderInline(h[2])}</h${lvl}>`);
      i++;
      continue;
    }

    // blockquote
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${renderInline(buf.join(' '))}</blockquote>`);
      continue;
    }

    // unordered list
    if (/^[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, ''));
        i++;
      }
      out.push('<ul>' + items.map((it) => `<li>${renderInline(it)}</li>`).join('') + '</ul>');
      continue;
    }

    // ordered list
    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ''));
        i++;
      }
      out.push('<ol>' + items.map((it) => `<li>${renderInline(it)}</li>`).join('') + '</ol>');
      continue;
    }

    // table (very small subset: | a | b |  header + separator + rows)
    if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|[-:\s|]+\|\s*$/.test(lines[i + 1])) {
      const head = line.split('|').slice(1, -1).map((c) => c.trim());
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) {
        rows.push(lines[i].split('|').slice(1, -1).map((c) => c.trim()));
        i++;
      }
      out.push('<table><thead><tr>' + head.map((c) => `<th>${renderInline(c)}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + r.map((c) => `<td>${renderInline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }

    // blank line
    if (line.trim() === '') { i++; continue; }

    // paragraph (consume until blank)
    const para = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^#{1,6}\s/.test(lines[i]) && !/^```/.test(lines[i]) && !/^[-*]\s/.test(lines[i]) && !/^\d+\.\s/.test(lines[i]) && !/^>\s?/.test(lines[i]) && !/^\|.*\|\s*$/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    if (para.length) out.push(`<p>${renderInline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}

/** Render markdown to HTML, with mermaid placeholders for ```mermaid blocks. */
export function renderMarkdown(md) {
  return renderBlocks(md);
}

/**
 * After inserting rendered HTML into the DOM, walk it for .iw-mermaid
 * placeholders and swap them with rendered SVG. Safe to call multiple times.
 */
export async function renderMermaidIn(rootEl) {
  if (!rootEl || typeof window === 'undefined') return;
  const nodes = rootEl.querySelectorAll('.iw-mermaid[data-mermaid]');
  if (!nodes.length) return;
  let mermaid;
  try { mermaid = await loadMermaid(); }
  catch (e) {
    nodes.forEach((n) => { n.classList.add('iw-mermaid-error'); n.textContent = '(mermaid 加载失败)'; });
    return;
  }
  if (!mermaid) return;
  for (let idx = 0; idx < nodes.length; idx++) {
    const node = nodes[idx];
    const src = node.getAttribute('data-mermaid') || '';
    const id = `iw-mermaid-${Date.now()}-${idx}`;
    try {
      const { svg } = await mermaid.render(id, src);
      node.innerHTML = svg;
      node.removeAttribute('data-mermaid');
    } catch (e) {
      node.classList.add('iw-mermaid-error');
      node.textContent = `(mermaid 渲染失败)\n${e?.message || e}`;
    }
  }
}
