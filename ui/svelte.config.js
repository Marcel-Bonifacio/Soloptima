// Svelte compiler options for the interface (vite.config.js). The report components (src/screens/report) are mounted once per
// report with fixed props and read them at set-up, so the "referenced locally" warning does not apply to them.
export default {
  compilerOptions: { runes: true },
  onwarn: (w, handler) => { if (w.code === 'state_referenced_locally' && /screens\/report\//.test(w.filename || '')) return; handler(w); },
};
