# Validation against version 1

Version 1 of Soloptima had its engine in C++. Version 2 has the same engine in Rust. The two give the same results to
within rounding: every number agrees to about 12 significant digits, and most outputs agree to the byte.

## What differs, and why

The last digit or two (the 13th significant digit and beyond) can differ on some machines. The cause is fused
multiply-add: on Apple silicon and other arm64 CPUs the C++ compiler fuses `a * b + c` into one operation with one
rounding, where the Rust engine rounds each step. The C++ engine itself gives slightly different last digits on arm64 and
x86-64 for the same reason. Built with `-ffp-contract=off` (no fusing), the C++ engine and the Rust engine give the same
bytes on the example project, for both `simulate` and `optimize`. Rounding of this size does not change any decision of the
optimiser or the dispatch on the example project, and it is far below the uncertainty of the inputs.

Known deliberate differences, all outside the numbers: a lone surrogate escape in a JSON string is read as U+FFFD, and
hexadecimal floats are refused (details in `docs/ipc.md`).

## Deliberate changes since version 1

Some answers now differ from version 1 on purpose. Where a change moved a parity fixture, the fixture was written again by the
Rust engine (`SOLOPTIMA_BLESS=1`, `engine/tests/common/bless.rs`), so for these cases the parity tests guard against
unplanned change, not against version 1. Year 1 of a project without wind is as in version 1.

| Change | What moves in an existing project |
|---|---|
| Battery PCS replacement (its own year and cost per kW; blank takes the PV inverter values) | A project with a battery pays the PCS replacement in the inverter replacement year: NPC and LCOE rise slightly (example project: NPC +0.02 %) |
| Wind power follows air density (site elevation and hourly temperature, IEC 61400-12-1 [1] equivalent wind speed) | Wind energy of every project with turbines, down in thin or warm air |
| Inverter clipping is given back as the modules degrade (the AC rating does not degrade) | PV energy from year 2 on in projects that clip (high DC/AC ratio); year 1 unchanged |
| Cost per genset start (0 by default) | Nothing until a cost is entered; then O&M, NPC and LCOE. The dispatch does not change: the cost is not part of the EMS plan |
| Features added in 2.1 (grid, sub-hourly steps, mixed fleets, outages, reserve energy) | Nothing while they are off |

## How the engine is checked

`cargo test --release` runs the engine's tests. The parity tests compare the Rust engine with answers written by the C++
engine and kept in `engine/tests/fixtures/` (see the README there):

| Test | Compares |
|---|---|
| `pv_fixtures.rs`, `pv.rs` | 34 PV cases: irradiance, shading, temperature, inverter, bifacial, tracker |
| `sim_parity.rs`, `sim_battery.rs` | the hourly dispatch, battery ageing, fuel, NPC and the project finance on the results |
| `optimizer_parity.rs` | grid, PSO, MOPSO and SHO-QAO-GOA, including the example project's `optimize` |
| `forecast_parity.rs`, `ems_parity.rs` | the forecasters (including the MLP) and the EMS schedules |
| `series_import.rs`, `series_qc.rs`, `weather.rs` | series import, data checks, weather providers |
| `outages.rs`, `sim/fleet.rs` | random inverter and PCS outages: off by default changes nothing; over 25 years about 25 blocks lose the share of PV an alternating renewal process predicts (R / (8760 / r + R)) within 0.6 %; the share of time out and the failures a year of one unit over 400 draws; the seed, each kind drawn apart, the EMS and 15 minute steps |
| `finance.rs`, `resource.rs`, `storage.rs`, `model.rs` | finance, P50/P90, the data folder, JSON reading and writing |
| `pv_reconcile.rs` | the comparison with metered PV output: a perfect match gives no error, a model at 90 % of the meter an MBE of -10 %, a meter at 90 % of the model a fitted soiling of 10 %; zeros in good sun counted as outages and left out of the fit; partial years, monthly sums, and bad files and values refused with a message |

## How to check it yourself

1. Run the tests: `cargo test --release`. All must pass.
2. Run the example project and look at the results:

   ```bash
   cargo run --release --bin soloptima -- simulate web/examples/example_study.json sim.json
   cargo run --release --bin soloptima -- optimize web/examples/example_study.json opt.json
   ```

3. To compare with version 1 directly, check out a version 1 source tree (tag `v1.2.0`), build its engine, and run the same
   two commands on the same project file. Compare the two outputs value by value with a tolerance of 1e-12 relative. For
   a byte-identical result, build the C++ engine with `-ffp-contract=off` (clang or GCC: add it to `CXXFLAGS`).
4. Differences larger than that are a defect: report them with the project file.

## Calibrating a model against site data

Parity with version 1 and the PVGIS cross-check say that the engine computes what it should. Neither says that the model fits a
given plant. When a plant is already running, its meter can: before an expansion, load the metered AC output of the existing
array on the PV & wind page (*Measured output against the model*) and compare.

1. Use the weather of the same period as the meter if you can (a PVGIS or NASA POWER year, or a station on site). A typical
   year against one real year mixes the weather of that year into every number below.
2. Set the PV inputs to the plant as built: capacity, orientation, inverters, DC/AC ratio. Check that the meter measures the
   whole array and that its unit is right; the import and the card warn when the peak is far from the capacity.
3. Upload the meter file. A full year is best; a few months give a soiling for that season only.
4. Read the statistics, then the fit. Apply the fitted values only when the gap they close is believable as soiling and
   downtime. Undo puts the old values back.

What the numbers mean (all as model − meter, over the hours present in both):

- **MBE** (mean bias error) is the mean difference. As a share of the mean metered output it is the energy bias: +5 % means
  the model gives 5 % more than the plant over the hours compared. This is the number that matters for an energy yield.
- **RMSE** (root mean square error) adds the hour-to-hour scatter: timing, clouds the weather data place in another hour,
  shading the model does not see. Normalised to the mean metered output, a few tens of percent are common with satellite
  weather; irradiance measured on site brings it well down.
- **R²** = 1 − Σ(model − meter)² ÷ Σ(meter − mean)². It is 1 for a perfect match and falls with both bias and scatter; it can
  be negative for a model worse than the meter's own mean.
- **Monthly deviation** is model ÷ meter − 1 for each month. A deviation that changes with the season points to soiling that
  builds up in a dry season, to snow, or to the weather data, not to a constant loss.
- **Outage hours** are daylight hours with at least 200 W/m² of sun and the meter at 1 % of the model or less. They are left
  out of the soiling fit and give the measured availability: 1 − the share of the modelled energy that falls in them.
- **Fitted soiling** is the constant (or monthly) loss that brings the model closest to the meter in least squares over the
  running hours, kept within 0 and 30 %. It takes every steady shortfall, not only dirt: a wrong capacity, a weather source that
  is too bright, cable losses before the meter, degradation since commissioning, and curtailment by the plant's control. A fit at
  either limit, or far from what the site's dust and cleaning suggest, is a reason to check those first.

The fit changes nothing by itself. Applied, the model's energy over the hours compared matches the meter's, and the RMSE with
the fitted values shows how much of the hourly error a constant loss explains; what remains is scatter the model cannot remove.

## References

[1] *Wind energy generation systems, Part 12-1: Power performance measurements of electricity producing wind turbines*, IEC 61400-12-1:2022, ed. 3.0, Sep. 2022.  
