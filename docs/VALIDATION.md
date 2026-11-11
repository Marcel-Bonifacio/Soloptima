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
| Wind power follows air density (site elevation and hourly temperature, IEC 61400-12-1 equivalent wind speed) | Wind energy of every project with turbines, down in thin or warm air |
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
| `finance.rs`, `resource.rs`, `storage.rs`, `model.rs` | finance, P50/P90, the data folder, JSON reading and writing |

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
