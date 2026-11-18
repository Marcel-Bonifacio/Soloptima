# Soloptima 2.2.0

This release brings a new 3D view of the site, moves the electrical design into the engine, and adds the features found missing in the latest literature review. Every new option is off by default, so an existing project gives the same results as in 2.1.0 until you switch something on.

## Site and 3D

- The 3D view is now drawn natively (Metal on macOS, DirectX on Windows, Vulkan on Linux). Buildings take roof shapes, trees take crown shapes, and ground and rooftop PV come with their mounting structures. Carports are new.
- Items can be moved, turned and resized in 3D with a handle, and the layout panels are less cluttered.
- Shadows in the view come from the same geometry the shading model uses, and near shading now follows pitched roofs, tree crowns and sloped tables.

## Electrical design

- The design, auto-size, load flow, short circuit and protection now run in the engine, with the same results as before.
- Inverters and battery inverters can carry a kVA rating. A power factor at the grid connection checks their reactive capability and adds reactive power to the load flow.
- New screens for weak grids (short-circuit ratio and transformer energising dip), for losing one feeder at a time, and for unbalanced grid faults.

## Sizing, dispatch and economics

- The optimiser can size the number of gensets and their unit rating, and shows the best design for each system type. It can repeat a search several times and report the spread, and MOPSO can trade cost against unmet load or CO2.
- The battery can charge from the grid before a planned outage or when time-of-use prices pay for it, and can hold a frequency reserve.
- Battery ageing can follow a cycles-against-depth curve. Gensets can have minimum up and down times, a cost per start in the plan, and overhauls and replacements by run hours.
- New: a critical share of the load, a deferrable load such as water pumping, PV and wind ramp limits at 15 and 30 minute steps, an MPP tracking loss, and PM2.5, CO and pollutant prices.
- The grid-extension break-even distance for off-grid projects, irradiance and wind scaling in the sensitivity cases, and two-way sensitivity maps.

## Results and reports

- An outage survival study: the chance the critical load is still served after a grid outage of 1 to 336 hours, from every hour of the year.
- Compare metered PV output with the model and fit soiling and availability to it.
- Every simulation checks its own results and lists anything out of a plausible range.
- An appliance list for building a load, a monthly genset table, battery charge by season, and the renewable fraction by energy, capacity and peak.

## Fixes

- A weather API key could appear in a bug report when a forecast download failed. Error messages no longer carry it, and reports hide keys and private paths.
- Scripts that come with an imported project are marked, and the Script console asks before running one for the first time.
- The load-flow bus table no longer stays empty after running the load flow again, and two colours now follow dark mode.
