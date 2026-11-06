// The example scripts of the script console
export const EXAMPLES = {
  'Load duration curve & statistics': `// Load duration curve and basic statistics of the 8760-h load
const L = P.load.kw;
disp('mean', mean(L), 'kW   P90', prctile(L, 90), 'kW   peak', max(L), 'kW');
figure('Load duration curve');
plot(linspace(0, 100, L.length), duration(L), {name: 'Load', xlabel: '% of hours', ylabel: 'kW'});`,
  'Parametric sweep: PV × BESS → LCOE': `// Full-factorial sweep run in parallel by the engine (year-1 fast mode)
const res = await sweep({
  'pv.capacity_kwp': linspace(0, 2 * P.pv.capacity_kwp, 6),
  'bess.energy_kwh': [0, P.bess.energy_kwh, 2 * P.bess.energy_kwh, 4 * P.bess.energy_kwh],
}, r => ({ lcoe: r.result.econ.lcoe, re: r.result.re_fraction, fuel_kL: r.result.fuel_l_y1 / 1000 }), {fast: true});
table(res);
figure('LCOE vs PV size for each battery size');
for (const e of [...new Set(res.map(r => r['bess.energy_kwh']))]) {
  const s = res.filter(r => r['bess.energy_kwh'] === e);
  plot(s.map(r => r['pv.capacity_kwp']), s.map(r => r.lcoe), {name: 'BESS ' + e + ' kWh', xlabel: 'PV kWp', ylabel: 'LCOE', markers: true});
}`,
  'Monte Carlo: diesel price & irradiance uncertainty': `// 200 runs: diesel price ~ normal(μ, 15 %), PV yield scaled by a lognormal factor (P50 = 1)
const n = 200, base = P.econ.fuel_price;
const res = await montecarlo(n, i => ({
  'econ.fuel_price': Math.max(0.1, base * (1 + 0.15 * randn(1)[0])),
  'pv.availability': Math.min(1, P.pv.availability * lognormal(1, 0, 0.05)[0]),
}), r => ({ npv: r.comparison.npv_savings, lcoe: r.result.econ.lcoe }), {fast: true});
const npv = res.map(r => r.npv);
disp('NPV of savings  P10', prctile(npv, 10), '  P50', prctile(npv, 50), '  P90', prctile(npv, 90));
disp('Probability NPV < 0:', find(npv, x => x < 0).length / n);
figure('NPV of savings distribution'); hist(npv, {name: 'NPV', xlabel: P.econ.currency, bins: 25});`,
  'Curve fit: fuel vs PV size (polyfit)': `// Fit a quadratic to year-1 fuel use vs PV capacity
const pv = linspace(0, 2 * P.pv.capacity_kwp, 9);
const res = await batch(pv.map(v => ({'pv.capacity_kwp': v})), {fast: true});
const fuel = res.map(r => r.result.fuel_l_y1 / 1000);
const p = polyfit(pv, fuel, 2);
disp('fuel [kL] ≈', p[0], '·PV² +', p[1], '·PV +', p[2]);
figure('Fuel vs PV capacity');
scatter(pv, fuel, {name: 'simulated', xlabel: 'PV kWp', ylabel: 'fuel kL/yr'});
plot(pv, polyval(p, pv), {name: 'quadratic fit', dash: 'dash'});`,
  'Monthly energy balance table': `// Monthly balance from the last simulation (run one first)
if (!hourly) throw new Error('Run a simulation first');
const rows = MONTHS.map((m, i) => ({ month: m,
  load_MWh: monthly(hourly.load)[i] / 1000, pv_MWh: monthly(hourly.pv_to_load)[i] / 1000,
  bess_MWh: monthly(hourly.bess_dis)[i] / 1000, diesel_MWh: monthly(hourly.gen_to_load)[i] / 1000,
  fuel_kL: monthly(hourly.fuel_l)[i] / 1000 }));
table(rows);
exportCSV('monthly_balance', rows);`,
  'Weibull wind resource & turbine power curve': `// Wind speed sampling (Weibull, inverse CDF) and a cubic power curve
const v = weibull(20000, 8, 2);             // scale c = 8 m/s, shape k = 2
const Pr = 1500, vin = 3, vr = 12, vout = 25;
const P_ = v.map(x => x < vin || x >= vout ? 0 : x >= vr ? Pr : Pr * (x**3 - vin**3) / (vr**3 - vin**3));
disp('mean wind', mean(v), 'm/s   capacity factor', mean(P_) / Pr);
figure('Wind speed distribution'); hist(v, {name: 'v', xlabel: 'm/s', bins: 40});`,
};
