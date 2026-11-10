// Read-through check for the first-run licence and terms of use: their tick boxes unlock only once the reader has scrolled
// each text to its end (at once when it fits without scrolling).

// true when a box scrolled to `top` (px) shows its end; `slack` absorbs sub-pixel rounding of zoomed displays
export const atEnd = (top, client, scroll, slack = 8) => top + client >= scroll - slack;

// Svelte action: calls done() once, when the node has been scrolled to its end or turns out to fit
export function readToEnd(node, done) {
  let fired = false;
  const check = () => {
    if (!fired && atEnd(node.scrollTop, node.clientHeight, node.scrollHeight)) { fired = true; done(); }
  };
  node.addEventListener('scroll', check, { passive: true });
  const ro = new ResizeObserver(check);   // the text arrives or the window is resized
  ro.observe(node);
  check();
  return { destroy() { node.removeEventListener('scroll', check); ro.disconnect(); } };
}
