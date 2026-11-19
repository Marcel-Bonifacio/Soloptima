# Soloptima 2.2.0

This release brings a new 3D view of the site, moves the electrical design into the engine, and adds the features found missing in the latest literature review. Every new option is off by default, so an existing project gives the same results as in 2.1.0 until you switch something on.

## Site and 3D

- The 3D view is now drawn natively (Metal on macOS, DirectX on Windows, Vulkan on Linux). Buildings take roof shapes, trees take crown shapes, and ground and rooftop PV come with their mounting structures. Carports are new.
- Items can be moved, turned and resized in 3D with a handle, and the layout panels are less cluttered.
- Shadows in the view come from the same geometry the shading model uses, and near shading now follows pitched roofs, tree crowns and sloped tables.
- The satellite map lies under the 3D layout (switch it off under View), and the view opens framed on your project.
- Ten roof and building shapes besides flat, gable, hip and shed: flat with a parapet, mansard, gambrel, butterfly, sawtooth, pyramid, barrel vault, cone or spire, dome, and round buildings such as silos and tanks. Each shades the PV in the engine as the 3D view draws it.
- PV on roofs: a raised area keeps 1 m from its edge, a narrow roof takes shorter tables, and a traced roof runs its rows along its longest edge. Buildings in 3D are plain walls and roofs.
- Moving the site offers to move the layout with it, and items left far from the site can be moved next to it or deleted.
- Add to report puts the 3D view, as you set it, in the report.

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

- A new loss diagram in the usual report form, for the whole system by default: from the sunlight through the PV, the plant and the battery to the energy served, with each loss as a share of the step before. A switch shows the PV, the plant and the battery as separate parts.
- The page is now called Report. It leaves out the PV area corner coordinates and the data quality tables (both stay in the workbook), and always includes the PV yield and the loss diagram.
- The years simulated (1 to 60, 25 by default) also show next to Simulate every project year, and the report follows them.
- The version shows next to the logo.

- An outage survival study: the chance the critical load is still served after a grid outage of 1 to 336 hours, from every hour of the year.
- Compare metered PV output with the model and fit soiling and availability to it.
- Every simulation checks its own results and lists anything out of a plausible range.
- An appliance list for building a load, a monthly genset table, battery charge by season, and the renewable fraction by energy, capacity and peak.

## Fixes

- A weather API key could appear in a bug report when a forecast download failed. Error messages no longer carry it, and reports hide keys and private paths.
- Scripts that come with an imported project are marked, and the Script console asks before running one for the first time.
- The load-flow bus table no longer stays empty after running the load flow again, and two colours now follow dark mode.
- The 3D view no longer goes blank after an undo, the Electrical page works again, the map no longer gives NaN coordinates when it is hidden, and the bug report list keeps inside its column.
