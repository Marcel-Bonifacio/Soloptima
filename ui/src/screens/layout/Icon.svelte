<!-- The line icons of the layout tool rail: 20 px, drawn in the text colour -->
<script>
  let { name } = $props();
  const PATHS = {
    area: 'M3 15 6 5h11l-3 10zM6.5 9.5h9M5 12.5h9.5M9.5 5 8 15M13.5 5 12 15',
    roof: 'M2 10 10 3l8 7M4.5 8v9h11V8M7 12.5l3-2 3 2',
    carport: 'M2 6h16M4 6v11M16 6v11M5 15.5h10M6 15.5v-2.5h8v2.5M7.5 13l1-2h3l1 2',
    building: 'M4 17V5l6-2v14M10 7l6 2v8M2.5 17h15M6.5 7h1.5M6.5 10h1.5M6.5 13h1.5M12.5 11h1.5M12.5 14h1.5',
    tree: 'M10 17v-5M10 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9M7.5 17h5',
    exclusion: 'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM5 5l10 10',
    path: 'M3 17c3-8 11-6 14-14M3 17c0-2 1.5-3 3-3M17 3c-1.5 1-1.5 3 0 4',
    plant: 'M11 2 5 11h5l-1 7 6-9h-5z',
    remove: 'M4 13 11 6l4 4-7 7H5zM8 17h9M9 8l4 4',
    more: 'M5 10h.01M10 10h.01M15 10h.01',
    undo: 'M7 6 3 10l4 4M3 10h9a5 5 0 0 1 0 10h-2',
    redo: 'M13 6l4 4-4 4M17 10H8a5 5 0 0 0 0 10h2',
    full: 'M3 8V3h5M12 3h5v5M17 12v5h-5M8 17H3v-5',
    close: 'M5 5l10 10M15 5 5 15',
  };
</script>

<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width={name === 'more' ? 3 : 1.5} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d={PATHS[name] || ''} />
</svg>
