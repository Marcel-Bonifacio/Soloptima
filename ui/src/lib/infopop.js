// The ⓘ buttons (<button class="info" data-k="key" data-title="...">): a click opens the help text of the key in a popup, built
// from text nodes only. Inside an open modal dialog the popup goes into the dialog. Escape, a scroll or a click elsewhere closes it.
import { HELP } from './help/index.js';

export function startInfoPop() {
  let pop = null, owner = null;
  const close = () => { if (pop) pop.remove(); if (owner) owner.setAttribute('aria-expanded', 'false'); pop = null; owner = null; };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  function open(b, h) {
    pop = el('div', 'info-pop');
    pop.setAttribute('role', 'tooltip');
    pop.append(el('b', null, b.dataset.title || ''), h[0]);
    if (h[1]) { const t = el('div', 'typ'); t.append(el('strong', null, 'Typical:'), ' ' + h[1]); pop.append(t); }
    const host = b.closest('dialog[open]');
    (host || document.body).appendChild(pop);
    const r = b.getBoundingClientRect(), w = pop.offsetWidth, hr = host ? host.getBoundingClientRect() : null;
    const x0 = hr ? host.scrollLeft - hr.left : window.scrollX, y0 = hr ? host.scrollTop - hr.top : window.scrollY;
    const left = Math.max(12, Math.min(x0 + r.left - 14, hr ? hr.width - w - 12 : x0 + document.documentElement.clientWidth - w - 12));
    const lim = hr ? Math.min(hr.bottom, window.innerHeight) : window.innerHeight, roof = hr ? Math.max(hr.top, 0) : 0, ph = pop.offsetHeight;
    let top = y0 + r.bottom + 8;
    if (r.bottom + ph + 16 > lim && r.top - roof > lim - r.bottom) top = y0 + r.top - ph - 8;
    pop.style.left = left + 'px'; pop.style.top = top + 'px';
    owner = b; b.setAttribute('aria-expanded', 'true');
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('button.info');
    if (b) {
      e.preventDefault(); e.stopPropagation();
      if (owner === b) { close(); return; }
      close();
      if (HELP[b.dataset.k]) open(b, HELP[b.dataset.k]);
      return;
    }
    if (pop && !e.target.closest('.info-pop')) close();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  document.addEventListener('scroll', close, { capture: true, passive: true });
  window.addEventListener('hashchange', close);
}
