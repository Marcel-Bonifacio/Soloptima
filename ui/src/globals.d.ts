// Globals of the vendored scripts that web/index.html loads before the interface (web/vendor), for the type check (npm run check).
declare const L: any;
declare function tzlookup(lat: number, lon: number): string;
interface Window { L: any; Plotly: any; __TAURI__: any }
interface Error { internal?: boolean }
