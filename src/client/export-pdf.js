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

/**
 * Render a DOM node to PDF and trigger a download.
 *
 * @param {HTMLElement} node — source DOM (cloned, not mutated)
 * @param {string} filename — without extension
 */
export async function exportNodeToPdf(node, filename) {
  if (!node) throw new Error('exportNodeToPdf: node is null');
  const html2pdf = await loadHtml2Pdf();
  // Wait for any mermaid SVGs to finish rendering before snapshotting.
  await new Promise((r) => setTimeout(r, 300));

  // Wrap in a print-friendly container so pdf output stays readable.
  // Each top-level child gets its own page-break so content doesn't overlap.
  const wrapper = document.createElement('div');
  wrapper.className = 'iw-pdf-render';
  const cloned = node.cloneNode(true);
  // Wrap each top-level section in .iw-pdf-section for clean page breaks.
  Array.from(cloned.children).forEach((child) => {
    child.classList.add('iw-pdf-section');
  });
  wrapper.appendChild(cloned);
  wrapper.querySelectorAll('img').forEach((img) => {
    img.setAttribute('crossorigin', 'anonymous');
  });

  const opts = {
    margin: [12, 10, 12, 10],
    filename: `${filename}.pdf`,
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff', windowWidth: 800 },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
    pagebreak: { mode: ['css', 'legacy'], avoid: '.iw-pdf-section' },
  };

  await html2pdf().set(opts).from(wrapper).save();
}
