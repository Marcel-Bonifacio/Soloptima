// The value logic of a schema field (an entry of FORMS in lib/schema): {k, l, u, t, step, lim, ph, sl, show, o, n, pct}.
// t: num | int | pct | text | sel | chk | list. Kept apart from Field.svelte so it can be tested without a browser.

// What the input shows for the project's value
export function display(f, v) {
  if (f.t === 'chk') return !!v;
  if (f.t === 'pct') return v == null ? '' : String(+(v * 100).toFixed(6));
  if (f.t === 'list') return Array.isArray(v) ? v.map((x) => +(f.pct ? x * 100 : x).toFixed(6)).join(', ') : '';
  return v == null ? '' : String(v);
}

// The input's text (or checked state) as the value to store: {v}, {error} (the message to show), or {} to ignore it
export function parse(f, raw) {
  let v;
  if (f.t === 'chk') return { v: !!raw };
  if (f.t === 'text' || f.t === 'sel') v = raw;
  else if (f.t === 'list') {
    // numbers separated by commas or spaces (percentages when f.pct), as many as f.n allows; blank stores null
    const a = String(raw).split(/[,;\s]+/).filter((x) => x !== '').map(Number), [lo, hi] = f.lim || [-Infinity, Infinity];
    if (a.length && (a.length < f.n[0] || a.length > f.n[1] || !a.every((x) => isFinite(x) && x >= lo && x <= hi))) {
      const count = f.n[0] === f.n[1] ? f.n[0] : `${f.n[0]} to ${f.n[1]}`;
      return { error: `${f.l}: give ${count} values${f.u ? ' in ' + f.u : ''}, each from ${lo} to ${hi}, or leave it blank.` };
    }
    return { v: a.length ? a.map((x) => (f.pct ? x / 100 : x)) : null };
  } else if (f.ph != null && String(raw).trim() === '') v = null;
  else {
    v = Number(raw);
    if (String(raw).trim() === '' || !isFinite(v)) return {};
    if (f.t === 'pct') v = v / 100;
    if (f.t === 'int') v = Math.round(v);
  }
  if (f.lim && v != null && (v < f.lim[0] || v > f.lim[1])) return { error: `${f.l} must be between ${f.lim[0]} and ${f.lim[1]}.` };
  return { v };
}

// The range slider under a field (f.sl = [min, max, step]); a diesel price in IDR widens it around the value
export function sliderRange(f, v) {
  const [min0, max0, step0] = f.sl, x = v == null ? null : f.t === 'pct' ? v * 100 : v;
  if (x == null || !(f.k === 'econ.fuel_price' && x > max0)) return { min: min0, max: max0, step: step0, x };
  const step = Math.pow(10, Math.floor(Math.log10(3 * x)) - 2);
  return { min: Math.max(min0, step), max: 3 * x, step, x };
}

// The input's attributes
export function inputAttrs(f) {
  if (f.t === 'sel') return {};
  const type = f.t === 'chk' ? 'checkbox' : f.t === 'text' || f.t === 'list' ? 'text' : 'number';
  const a = { type };
  if (f.t === 'int') a.step = 1;
  else if (f.step) a.step = f.step;
  else if (type === 'number') a.step = 'any';
  if (f.ph != null) a.placeholder = f.ph;   // optional value: blank stores null, the engine then uses its default
  if (f.lim) { a.min = f.lim[0]; a.max = f.lim[1]; }
  return a;
}
