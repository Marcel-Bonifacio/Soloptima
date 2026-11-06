// A short notice at the foot of the page (the #toast element of web/index.html, a pop-over so it also shows above an open dialog).
let timer;
export function toast(msg, err) {
  const t = document.getElementById('toast');
  if (!t) { console[err ? 'error' : 'log'](msg); return; }
  t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
  if (t.showPopover) { if (t.matches(':popover-open')) t.hidePopover(); t.showPopover(); }
  clearTimeout(timer);
  timer = setTimeout(() => { t.hidden = true; if (t.hidePopover && t.matches(':popover-open')) t.hidePopover(); }, err ? 7000 : 3500);
}
