// export-pdf.js — render current Result DOM to PDF, fully client-side.
//
// Injects html2pdf.js@0.10.x from unpkg on first use. Caches the global
// promise so subsequent exports skip the network roundtrip.

let loaderPromise = null;

function loadHtml2Pdf() {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.html2pdf) return Promise.resolve(window.html2pdf);
  if (loaderPromise) return loaderPromise;
  loaderPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/html2pdf.js@0.10.2/dist/html2pdf.bundle.min.js';
    s.async = true;
    s.onload = () => {
      if (window.html2pdf) resolve(window.html2pdf);
      else reject(new Error('html2pdf loaded but window.html2pdf missing'));
    };
    s.onerror = () => reject(new Error('html2pdf CDN load failed'));
    document.head.appendChild(s);
  });
  return loaderPromise;
}

// HTML-escape for user-provided strings (essay text, question titles).
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Build the PDF prelude (question + user's submitted essay). Returns a
 * detached div containing the rendered sections, ready to be appended to
 * the wrapper before the cloned Result DOM.
 */
function buildPrelude({ session, question }) {
  const root = document.createElement('div');
  root.className = 'iw-pdf-prelude';
  const parts = [];

  if (question) {
    const imgs = Array.isArray(question.images) ? question.images : [];
    parts.push('<div class="iw-pdf-section iw-pdf-question">');
    parts.push('<h2>题目</h2>');
    parts.push(`<h3>${esc(question.title || session.questionTitle || '')}</h3>`);
    const meta = [question.task ? `Task ${question.task}` : '', question.type, question.date].filter(Boolean).join(' · ');
    if (meta) parts.push(`<p class="iw-pdf-meta">${esc(meta)}</p>`);
    // Question body may contain markdown; renderMarkdown already escapes.
    // Importing here would create a circular dep — caller passes rendered html.
    if (question._bodyHtml) parts.push(`<div class="iw-md">${question._bodyHtml}</div>`);
    if (imgs.length) {
      parts.push('<div class="iw-pdf-imgs">');
      parts.push(imgs.map((src) => {
        const url = /^https?:|^\//.test(src) ? src : `/ielts-examiner/asset/${src}`;
        return `<img src="${esc(url)}" alt="${esc(question.title || '')}" crossorigin="anonymous" />`;
      }).join(''));
      parts.push('</div>');
    }
    parts.push('</div>');
  }

  if (session && session.essay) {
    const wc = String(session.essay).trim()
      ? String(session.essay).trim().split(/\s+/).length : 0;
    parts.push('<div class="iw-pdf-section iw-pdf-essay">');
    parts.push(`<h2>我的作文 <span class="iw-pdf-meta-inline">${wc} 词</span></h2>`);
    parts.push(`<pre class="iw-pdf-essay-text">${esc(session.essay)}</pre>`);
    parts.push('</div>');
  }

  root.innerHTML = parts.join('');
  return root;
}

/**
 * Render a DOM node to PDF and trigger a download.
 *
 * @param {HTMLElement} node — source DOM (cloned, not mutated)
 * @param {{session: object, question?: object}} ctx — provides the question
 *   prompt and the user's submitted essay for the prelude.
 * @param {string} filename — without extension
 */
export async function exportNodeToPdf(node, ctx, filename) {
  if (!node) throw new Error('exportNodeToPdf: node is null');
  if (!ctx) ctx = {};
  const html2pdf = await loadHtml2Pdf();

  // Wait for any mermaid SVGs to finish rendering. Poll the live node for
  // unresolved placeholders with a hard cap — mermaid can take >300ms on
  // a fresh load.
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const pending = node.querySelectorAll('.iw-mermaid[data-mermaid]');
    if (pending.length === 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 150));

  // Build the wrapper as a detached fragment. The earlier attempt to attach
  // it off-screen with position:fixed;left:-99999px made html2canvas
  // resolve to an empty render — the element ends up outside the canvas
  // rect. Detached is fine: html2pdf clones the source into its own DOM
  // before snapshotting, so CSS rules (including var() tokens) are read
  // from the document's stylesheet.
  const wrapper = document.createElement('div');
  wrapper.className = 'iw-pdf-render';

  // 1) Question + essay prelude (so a reviewer can see the task and what
  //    the student wrote, not just the AI's verdict).
  const prelude = buildPrelude(ctx);
  if (prelude.firstChild) wrapper.appendChild(prelude);

  // 2) Cloned Result DOM, with each top-level child of iw-main-inner tagged
  //    as .iw-pdf-section so the page-break logic keeps cards together.
  const cloned = node.cloneNode(true);
  const mainInner = cloned.querySelector('.iw-main-inner');
  if (mainInner) {
    Array.from(mainInner.children).forEach((child) => {
      child.classList.add('iw-pdf-section');
    });
  }
  wrapper.appendChild(cloned);

  // Avoid html2canvas CORS taint from data: URIs in <img>.
  wrapper.querySelectorAll('img').forEach((img) => {
    img.setAttribute('crossorigin', 'anonymous');
  });

  const opts = {
    margin: [12, 10, 12, 10],
    filename: `${filename}.pdf`,
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: {
      scale: 2,
      useCORS: true,
      backgroundColor: '#ffffff',
    },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
  };

  await html2pdf().set(opts).from(wrapper).save();
}