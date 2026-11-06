// The pages of the workspace in the order of the side navigation: [group, [[id, number or icon path, label]]].
export const GROUPS = [
  ['Inputs', [['site', '1', 'Site & layout'], ['resource', '2', 'Solar resource'], ['load', '3', 'Load'], ['pv', '4', 'PV & wind'], ['bess', '5', 'Battery'],
    ['diesel', '6', 'Diesel & control'], ['econ', '7', 'Costs']]],
  ['Engineering', [['equip', '8', 'Equipment datasheets'], ['elec', '9', 'Electrical & SLD']]],
  ['Analysis', [['sim', 'M4 19V5M4 19h16M8 15l3-4 3 2 5-6', 'Simulation results'], ['opt', 'C', 'Optimise sizing'], ['ems', 'M3 12h4l2-5 4 10 2-5h6', 'Forecast & EMS'],
    ['fin', 'M4 20V10M10 20V4M16 20v-7M22 20H2', 'Project finance']]],
  ['Tools', [['script', 'M8 6l-5 6 5 6M16 6l5 6-5 6', 'Script console'], ['report', 'R', 'Report & export']]],
];
export const label = (id) => { for (const [, items] of GROUPS) for (const [t, , l] of items) if (t === id) return l; return id; };
