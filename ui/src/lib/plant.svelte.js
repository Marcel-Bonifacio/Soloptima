// What the PV page and the layout map hand over for the loss diagram and the sun path chart (calcPV in pv.svelte.js, lib/layout/edit.svelte.js).
// The values are raw objects; `plant.rev` tells the charts to read them again.
export const plant = $state({ rev: 0 });
export const shown = { losses: null, shade: null };
export const setPvLosses = (losses) => { shown.losses = losses || null; plant.rev++; };
export const setSunShade = (shade) => { shown.shade = shade || null; plant.rev++; };
