# Literature review

Four journal papers supplied with the project were reviewed in full for their models and forecasting methods. The two financial models are reviewed in `FINANCE.md`.

## Summary of the papers

| | Paper | Problem | Optimiser | Forecasting |
|---|---|---|---|---|
| 1 | Abdoulaye, Waita, Wekesa, Mwabora (2024), *Multi-criteria optimal sizing and analysis of PV/wind/fuel cell/battery/diesel generator for rural electrification: a case study in Chad*. Int. J. Renewable Energy Development 13(3), 491–507. doi:10.61435/ijred.2024.60169 | Off-grid PV/WT/H₂/battery/DG sizing, hourly rule-based dispatch, 20 years | MOPSO: minimise annual cost, maximise self-sufficiency (SSSI) | **None** |
| 2 | Suresh Babu, Mangaiyarkarasi, Gandhi Raj, Senthilkumar (2025), *Solving Optimal Power Flow Problem in Hybrid Renewable Energy Systems Through Hybrid Optimization Algorithm*. Iranian J. Sci. Tech., Trans. Electrical Eng. 49, 2063–2080. doi:10.1007/s40998-025-00830-5 | Single-snapshot AC OPF on IEEE-30 with PV/wind (Weibull, lognormal, Monte Carlo) | Hybrid SHO + QAO + GOA ("HSHOA") | **None**: PV/WT are treated as "forecasted values" with no method given |
| 3 | El Boujdaini, Mezrhab, Moussaoui, Jurado, Vera (2022), *Sizing of a stand-alone PV–wind–battery–diesel hybrid energy system and optimal combination using a particle swarm optimization algorithm*. Electrical Engineering 104, 3339–3359. doi:10.1007/s00202-022-01529-0 | Off-grid PV/WT/battery/DG sizing, hourly, 20 years | PSO, minimise COE with LPSP limit | **None** |
| 4 | Punyam Rajendran & Gebremedhin (2024), *Deep learning-based solar power forecasting model to analyze a multi-energy microgrid energy system*. Frontiers in Energy Research 12:1363895. doi:10.3389/fenrg.2024.1363895 | Grid-connected heat/electricity microgrid in Norway, scenario sweep in EnergyPLAN (no battery, no diesel, no economics) | Parametric sweep | MLP (3 hidden layers, ReLU, sigmoid output, Adam, MSE) mapping same-hour observed weather to PV power; R² = 0.873 |

**Papers 1–3 contain no forecasting method**: no ANN, LSTM, ARIMA or similar model, no error metrics and no forecast-driven dispatch. Paper 3 cites the authors' own ANN irradiance forecasting work (El Boujdaini et al. 2021, *Energy Sources A*, doi:10.1080/15567036.2021.1940386). It also cites Zhang et al. 2019 (*Energy Convers. Manag.* 180:609–621), which sizes a system using weather forecasting. Those two papers would be the next reads for forecasting.

Soloptima's forecasting therefore comes from standard practice instead (see [MANUAL.md](MANUAL.md), *Forecast-based EMS*):
- smart persistence;
- climatology;
- exponential smoothing;
- recursive-least-squares regression;
- analog ensemble;
- an adaptive ensemble.

These are benchmarked against each other in the Forecast Lab, which also shows each method's effect on fuel use.

## Implemented from the papers

| Item | Source | Where in Soloptima |
|---|---|---|
| Wind turbine power curve (cubic between cut-in and rated, flat to cut-out), linear variant | P1 Eqs. 3–4, P3 Eq. 3, P2 Eq. 27 | `src/pv.cpp: wind_per_turbine`, PV & wind → Wind turbines |
| Hub-height power law v = v_ref (H/H_ref)^α, α = 1/7 | P1 Eq. 5 | same |
| NOCT cell temperature Tc = Ta + (NOCT − 20)/800 · G | P1 Eq. 2, P3 Eq. 2 | PV & wind → Cell temperature model |
| Battery self-discharge σ: SOC(t) = SOC(t−1)(1 − σ) ± … | P1 Eqs. 10–11 | Battery → Self-discharge |
| Linear fuel curve F = A·P_out + B·P_rated (0.246 / 0.08145 L/kWh) | P1 Eq. 25, P3 Eq. 11 | Diesel & control → Fuel model "Linear" |
| LPSP = Σ deficit / Σ load (per-hour deficit ≥ 0) | P3 Eq. 19 | Simulation results → indicators |
| SSCI = Σ min(load, RE) / Σ RE; SSSI = Σ min(load, RE) / Σ load | P1 Eqs. 39–40 | Simulation results → indicators; MOPSO 2nd objective |
| REP = 100 (1 − LPSP), excess energy | P1 Eq. 47 | indicators |
| Emissions: CO₂ plus NOx and SOx factors | P1 Eqs. 28, 46 | Costs → emission factors (per litre of diesel) |
| Job creation (PV 2.70/MW, wind 1.10/MW, battery 0.01/MWh) | P1 Eq. 48, Table 4 | Costs → job factors |
| HDI from per-capita electricity: 0.0978 ln(E/person) − 0.0319, E = year-1 served energy + excess energy (excess capped at 75 % of served) | P1 Eq. 49 | Costs → Population served (for HDI) |
| CRF, total annualised cost TAC = NPC · CRF, COE = TAC / year-1 served energy | P1 Eqs. 29, 38, 43–44; P3 Eqs. 12–15 | indicators (alongside discounted-energy LCOE) |
| PSO: global best, inertia weight, Eqs. V ← wV + c1r1(pbest − X) + c2r2(gbest − X) | P3 Eqs. 21–22 | Optimise sizing → Algorithm "PSO" |
| MOPSO: cost vs self-sufficiency Pareto front | P1 Eq. 50, Figs. 7–8 | Optimise sizing → "Multi-objective PSO" |
| Hybrid SHO + QAO + GOA | P2 Sect. 4 | Optimise sizing → "Hybrid SHO–QAO–GOA" |
| AC network equations, real-power loss and voltage deviation VD = Σ|V − V_ref| | P2 Eqs. 7, 18–19 | Electrical & SLD → AC load flow (backward/forward sweep for the radial collector) |
| Weibull inverse-CDF and lognormal sampling for Monte Carlo | P2 Eqs. 1–2, 21–26 | Script console: `weibull()`, `lognormal()`, `montecarlo()` |

### From paper 4 (Frontiers)
Only the neural-network idea is relevant to a PV + BESS + diesel tool. It is implemented as a **causal** forecaster, which differs from the paper in five ways:
- **Architecture:** two hidden layers of 16 ReLU units and a linear output (10-16-16-1), instead of three hidden layers with a sigmoid output.
- **Inputs:** only information available at the forecast issue time, i.e. lagged clear-sky indices, smoothed level, climatology, lead time and calendar. The paper uses same-hour observed irradiance, which makes it a nowcast.
- **Calendar encoding:** sine/cosine instead of raw integers.
- **Training:** chronological retraining every month on the preceding 330 days, instead of a shuffled split.
- **Evaluation:** skill is reported against persistence, with night hours excluded for PV.

On the example site the network has the best day-ahead PV skill of the real forecasting methods (+0.174 vs persistence at 24 h; perfect and noisy benchmarks excluded). Its effect on fuel is negligible there: with any PV method driving the EMS, year-1 fuel stays within 0.01 % of the other methods.

The rest of the paper was not used:
- **Snow-loss argument:** relevant to cold climates only.
- **EnergyPLAN priority dispatch:** cruder than the existing EMS.
- **CHP, heat pumps and district heating:** outside the PV + BESS + diesel scope.

Inconsistencies noted in the paper:
- **Optimiser:** it states gradient descent (Eq. 3) but says Adam was used.
- **Hyperparameters:** the chosen values are not reported.
- **Data split:** the validation and test sets are the same data.
- **Results:** Table 4 does not match Figs. 9–13.

## Corrections applied, where the printed equations are wrong or incomplete

- **P2 Eq. 8 (reactive power flow).** The sin and cos terms are swapped as printed. The correct form is V_i Σ V_j (G_ij sin θ_ij − B_ij cos θ_ij). The load flow uses a backward/forward sweep with complex power, so this equation is not needed directly.
- **P2 Eq. 19.** "θ_i − θ_i" is read as θ_i − θ_j.
- **P2 Weibull sampling.** The paper prints v = C (ln r)^(1/k), which is invalid. Soloptima uses v = C (−ln(1 − r))^(1/k).
- **P2 Eq. 23 (PV).** The first branch is printed with H²; the standard form is P_sr · H / H_std. Soloptima uses its own transposition, thermal and loss-chain model instead.
- **P2 Eq. 39 (QAO).** The numerator uses squared differences. Soloptima uses the correct three-point quadratic minimiser:
  x* = ½ [(q2² − q3²) f1 + (q3² − q1²) f2 + (q1² − q2²) f3] / [(q2 − q3) f1 + (q3 − q1) f2 + (q1 − q2) f3].
  It guards against a near-zero denominator and clips to the variable bounds.
- **P2 SHO update.** The paper omits the cluster average. Soloptima implements the canonical form (Dhiman & Kumar 2017): the new position is the mean over the best-N cluster of P_k − E·|B·P_k − X|, with h decreasing linearly from 5 to 0.
- **P2 GOA Eq. 46.** This is the raw swarm model, which is not usable for optimisation. Soloptima uses the optimisation form (Saremi et al. 2017), x_i = c·Σ c·(ub − lb)/2 · s(d_ij)·(x_j − x_i)/d_ij + T̂, with:
  - c decreasing from 1 to 10⁻⁵;
  - s(r) = 0.5 e^(−r/1.5) − e^(−r).
- **P1 Eq. 11.** Discharge should divide by η_d. P1 Fig. 4 also prints "E_bmax + E_b"; it should be "−". Soloptima's battery uses √RTE each way.
- **P1 Eq. 1.** P_r and η_PV are both applied, which double-counts the efficiency. P1 Eq. 41 (LOLP) divides energy by hours. These two forms were not used.
- **P3 Eq. 12.** The CRF formula mixes rates. Soloptima uses CRF = i(1 + i)^N / ((1 + i)^N − 1) with one consistent discount rate.
- **P3 Eq. 19.** The per-hour deficit is clamped at ≥ 0.
- **Constraint handling, missing in papers 1–3.** Soloptima adds a static penalty: an infeasible point scores the diesel-only cost × (1 + 10 × normalised violation), so it ranks behind every feasible system cheaper than diesel only, and the reported optimum is always feasible. Constraints covered are unmet load, minimum RE share, curtailment, land limit and capex.
- **Settings the papers leave unspecified.** Soloptima uses documented defaults:
  - PSO: w 0.9 → 0.4, c1 = c2 = 2, 20 % velocity clamp.
  - MOPSO: 60-solution archive, crowding-distance pruning, binary tournament leader, decaying mutation.
  - Population and iterations are user settings.

## Not taken over

- **P2's single-snapshot metaheuristic OPF.** It has no storage and no time coupling. Running a metaheuristic every hour is unnecessary on a small radial collector network, so the dispatch keeps its own unit-commitment logic and EMS.
- **P1's hydrogen chain (electrolyser, tank, fuel cell).** It is outside the PV + BESS + diesel scope. It could be added as another storage type.
- **Reported numerical results.** Papers 1–3 contain internal inconsistencies, so none of their results were used as defaults (the P1 job-creation factors are inputs, not results):
  - P2: the renewable cases miss the power balance by about 50 MW.
  - P1: costs do not reconcile, and the energy balance does not close.
  - P3: wind energy values are mistyped by a factor of 10, and RF values exceed 1.
