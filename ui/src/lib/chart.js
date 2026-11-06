// Plotly look shared by the results charts (colours from the CSS variables of web/style.css). Series colours have a fixed meaning:
// PV amber, battery green, wind dark green, diesel blue, curtailed pink, unmet red, SOC violet, load ink.
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

export const colours = () => ({
  pv: css('--c-pv'), bess: css('--c-bess'), gen: css('--c-gen'), curt: css('--c-curt'), unmet: css('--c-unmet'),
  soc: css('--c-soc'), wind: css('--c-wind'), load: css('--c-load'), text: css('--text'), text2: css('--text-2'), muted: css('--muted'),
  border: css('--border'), surface: css('--surface'), surface2: css('--surface-2'), accent: css('--accent'),
});

export const PLOT_CFG = { displaylogo: false, responsive: true, modeBarButtonsToRemove: ['lasso2d', 'select2d', 'autoScale2d'] };

export function baseLayout(c, extra = {}) {
  const ax = { gridcolor: c.surface2, linecolor: c.border, zerolinecolor: c.border, tickfont: { color: c.text2, size: 11 },
    title: { font: { color: c.text2, size: 12 } }, automargin: true };
  const lay = {
    paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
    font: { family: '-apple-system, BlinkMacSystemFont, Segoe UI, Inter, sans-serif', color: c.text, size: 12 },
    margin: { l: 56, r: 16, t: 10, b: 40 },
    legend: { orientation: 'h', y: -0.18, x: 0, font: { color: c.text2, size: 11 } },
    hoverlabel: { bgcolor: c.surface, bordercolor: c.border, font: { color: c.text } },
    xaxis: { ...ax }, yaxis: { ...ax }, bargap: 0.25,
  };
  for (const [k, v] of Object.entries(extra)) {
    if (/^[xy]axis/.test(k)) lay[k] = { ...ax, ...v, title: { ...ax.title, ...(v.title || {}) } };
    else lay[k] = v;
  }
  return lay;
}
