// An SVG given as text (the logo, the single-line diagram) put into the page as elements, never as markup: parsed as SVG, with
// scripts, foreign objects, event attributes and script links removed. Svelte action: <div use:svgNode={text}>.
export function cleanSvg(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) return null;
  for (const el of [...root.querySelectorAll('script,foreignObject,iframe,object,embed')]) el.remove();
  for (const el of [root, ...root.querySelectorAll('*')]) {
    for (const a of [...el.attributes]) {
      const v = a.value.trim().toLowerCase();
      if (/^on/i.test(a.name) || ((a.name === 'href' || a.name === 'xlink:href') && !/^(#|data:image\/(png|jpeg|webp);base64,)/.test(v))) el.removeAttribute(a.name);
    }
  }
  return root;
}
export function svgNode(node, text) {
  const root = cleanSvg(text);
  if (root) node.replaceChildren(document.importNode(root, true));
  return { update(t) { const r = cleanSvg(t); node.replaceChildren(...(r ? [document.importNode(r, true)] : [])); } };
}
