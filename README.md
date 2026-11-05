<p align="center">
  <img src="docs/readme/hero.svg" width="100%" alt="Soloptima: size hybrid power plants hour by hour. Beside the wordmark, a chart of one simulated day of the example project: diesel generators carry the load at night, solar PV covers most of it from mid-morning and charges the battery, and the battery discharges in the late afternoon.">
</p>

<p align="center">
  <a href="https://github.com/Marcel-Bonifacio/Soloptima/releases/latest/download/Soloptima-Setup-windows-x64.exe"><img src="https://img.shields.io/badge/Download_for_Windows-latest-0f7466?style=for-the-badge&logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0wIDBoMTEuNHYxMS40SDB6TTEyLjYgMEgyNHYxMS40SDEyLjZ6TTAgMTIuNmgxMS40VjI0SDB6TTEyLjYgMTIuNkgyNFYyNEgxMi42eiIvPjwvc3ZnPg==" alt="Download for Windows" height="36"></a>
  &nbsp;
  <a href="https://github.com/Marcel-Bonifacio/Soloptima/releases/latest/download/Soloptima-mac.dmg"><img src="https://img.shields.io/badge/Download_for_macOS-latest-15181d?style=for-the-badge&logo=apple&logoColor=white" alt="Download for macOS" height="36"></a>
  &nbsp;
  <a href="https://github.com/Marcel-Bonifacio/Soloptima/releases/latest/download/Soloptima-linux-x86_64.AppImage"><img src="https://img.shields.io/badge/Download_for_Linux-latest-3d4f6b?style=for-the-badge&logo=linux&logoColor=white" alt="Download for Linux" height="36"></a>
</p>

<p align="center">
  Windows 10 or 11 (64-bit) · macOS 11 or later (Apple silicon and Intel) · Linux x86_64 (glibc 2.31 or later, for example Ubuntu 20.04 and later)<br>
  <a href="https://github.com/Marcel-Bonifacio/Soloptima/releases">All releases</a> · <a href="#install">Install</a> · <a href="docs/MANUAL.md">Manual</a> · <a href="#build-from-source">Build from source</a>
</p>

Soloptima sizes and models hybrid power plants that combine solar PV, battery energy storage (BESS) and diesel generators, with optional wind turbines. You give it a site, a load profile and the generator fleet. It simulates every hour of the project life, searches for the lowest-cost PV and battery sizes, and works out the fuel savings and the project finance. The results go into an engineering report and an Excel workbook.

Soloptima is a desktop application for Windows, macOS and Linux. A C++ engine does the modelling on your computer, and the interface opens in the application's own window. There is no account and no cloud service. Projects are plain files on disk, and Soloptima tells you when a new version is out.

## How it works

<p align="center">
  <img src="docs/readme/how-it-works.svg" width="100%" alt="Inputs (site and land, weather, load, plant, costs) feed the C++17 engine (hourly dispatch, battery ageing, optimiser, predictive EMS, weather variability), which produces energy and fuel results, economics, project finance, electrical design and a report.">
</p>

The engine simulates every hour of every project year. It commits gensets for the load plus spinning reserve, keeps them above their minimum loading, charges the battery from surplus PV and computes fuel from each unit's part-load curve. Battery health falls by calendar and cycle fade, and the battery is replaced when it reaches its threshold. For control, choose load following, cycle charging, or a predictive EMS that plans on PV and load forecasts. The Forecast Lab compares 10 PV and 11 load forecasting methods and shows what each one is worth in fuel.

- On the layout map you draw the land and the tool fills it with module tables. Buildings and trees beside the array, with their heights, shade each table over the year on top of the terrain horizon. Roof faces can have their own tilt and azimuth, and areas come in from KML, KMZ, GeoJSON or OpenStreetMap. A drone or survey image with its world file can go under the map, and a click on a roof traces its outline from that image.
- The optimiser runs a full lifecycle simulation for every candidate design, in parallel. It offers an exhaustive grid with pattern search, PSO, MOPSO (a Pareto front of cost against renewable fraction) and a hybrid SHO-QAO-GOA, with limits on unmet load, renewable fraction, curtailment, land and capex. With rule-based dispatch the engine runs about 150 full 25-year simulations per CPU-second on the example project.
- Weather comes from PVGIS or NASA POWER, or from your own station file. Load is a synthetic profile or a logger file. Imported files are averaged to hours with a gap report, then checked: weather for timestamps that disagree with the sun, values outside physical limits and stuck readings, load for outages, spikes, level shifts and unit errors. Running year 1 with every historical weather year gives P50 to P99 yield and revenue.
- Each result is measured against the same fleet on diesel alone: fuel saved, NPC, LCOE, IRR, payback. The battery gets its own NPV against PV only, because a hybrid can beat diesel by a wide margin while its battery loses money. Records from an existing plant (fuel, generation, run hours) check the diesel-only case.
- Project finance is an annual after-tax cash flow for host-owned, single-owner PPA and third-party structures, with debt sized by gearing or DSCR sculpting, tax, staged tariffs and a solver for the tariff that meets a target IRR. The formulas are in [docs/FINANCE.md](docs/FINANCE.md).
- Electrical design covers string sizing, transformers, cables, an AC load flow over all 8,760 hours and the single-line diagram.
- Results go into an engineering report (print it or save it as PDF) and an Excel workbook with every input, result and hourly series. For studies the pages do not cover, a script console runs parameter sweeps and Monte Carlo runs through the engine.

[docs/MANUAL.md](docs/MANUAL.md) describes every page and model, and lists the known limitations.

## Install

The builds are not code-signed yet, so Windows and macOS show a security warning on first launch. The steps below cover the one-time workaround; [Signing](#signing) explains how signed builds are made.

### Windows

1. Run `Soloptima-Setup-windows-x64.exe`. It installs Soloptima for your user account only, without administrator rights, in `%LOCALAPPDATA%\Programs\Soloptima`, and adds Start menu and desktop shortcuts.
2. If SmartScreen blocks the setup program, select **More info**, then **Run anyway**.
3. Soloptima opens in its own window. It uses the Microsoft Edge WebView2 Runtime, which Windows 11 and current Windows 10 include; if it is missing, Soloptima offers to open the download page.

Uninstall from **Settings > Apps**; your profiles and projects stay in place. To run Soloptima without installing it, for example from a USB drive, extract `Soloptima-windows-x64.zip` from the release and start `Soloptima.exe`.

### macOS

1. Open `Soloptima-mac.dmg` and drag Soloptima into Applications.
2. On first launch, right-click the app, select **Open**, then confirm with **Open**. A plain double-click is blocked once because the app is not notarised by Apple yet. On macOS 15 and later, if no Open button appears, go to System Settings > Privacy & Security and select **Open Anyway**.
3. Soloptima opens in its own window. Close the window or press Cmd+Q to quit; your work is saved first.

Starting Soloptima while it is already running brings its window to the front.

### Linux

1. Download `Soloptima-linux-x86_64.AppImage`, make it executable (`chmod +x Soloptima-linux-x86_64.AppImage`, or Properties > Permissions in the file manager) and run it.
2. Soloptima opens in its own window when WebKitGTK is installed: `libwebkit2gtk-4.1` or `libwebkit2gtk-4.0`, which most desktop installations include (on Ubuntu 22.04 and later, `sudo apt install libwebkit2gtk-4.1-0`). Without it, Soloptima shows the same interface in the default browser.
3. If the AppImage does not start because FUSE is missing, run it with `--appimage-extract-and-run`, or install FUSE (`sudo apt install fuse3`).

The AppImage updates itself. `Soloptima-linux-x86_64.tar.gz` holds the same program as a folder: unpack it anywhere and run `./soloptima`. That copy does not update itself, and the `README.txt` inside shows how to add it to the applications menu.

### Updates

After you sign in, Soloptima checks GitHub for a newer release, at most once a day. When there is one, **Update to x.y.z** appears in the top bar with the release notes. Nothing is downloaded until you choose **Download and install**. Soloptima then checks that the release's `SHA256SUMS.txt` carries a valid release signature and that the download matches it. A missing or wrong signature stops the update, and a download that does not match is deleted. If both checks pass, Soloptima saves your work and closes:
- on Windows, the setup program installs the new version over the old one and offers to start it;
- on macOS, Soloptima replaces itself in its folder and starts again. If it cannot write to that folder, the new disk image opens instead, so you can drag the new version into Applications;
- on Linux, the AppImage replaces its own file and starts again.

**Settings > Updates** turns the automatic check off and has **Check now**; on macOS the application menu also has **Check for Updates…**. **Skip this version** in the update window hides a release until the next one comes out. A copy run from the Windows zip or the Linux .tar.gz is not updated in place (on Windows the setup program would install a second copy elsewhere); its update window opens the release page instead.

## Getting started

The first screen is the profile page. Create a profile and accept the terms of use. Profiles keep projects separate on a shared computer and have no password.

**Open the example study** loads the example project, a complete reference case: a generic off-grid industrial site with 30 MWp of PV, a 6.6 MWh battery and 20 × 1.8 MW diesel generators, with PVGIS weather data included. The chart at the top of this page is one day of its simulation. The pages in the left sidebar follow the workflow in order, from site and solar resource through to results, finance and the report.

The example coordinates are a placeholder. Set the actual site location before relying on any result.

## Data storage

Projects are saved automatically.

| System | Default folder |
|---|---|
| Windows | `%LOCALAPPDATA%\Soloptima` |
| macOS | `~/Library/Application Support/Soloptima` |
| Linux | `~/.local/share/Soloptima` |

You can change the folder under **Settings** in the user menu. For a portable installation, for example on a USB drive, create an empty `data\users` folder next to the executable; Soloptima then uses it instead of the default location.

**Export .json** produces a self-contained project file. It includes the weather and load data, so it also runs offline and from the command line. Google Maps and Open-Meteo API keys are left out of exported files.

## Network access

All modelling runs offline. Soloptima goes online only for weather data (PVGIS, NASA POWER), weather forecasts (Open-Meteo, MET Norway), map tiles, place search and OpenStreetMap building outlines, which include the site coordinates, and for update checks (GitHub), which include no project data. [TERMS.md](TERMS.md) lists exactly what is sent to each service.

The window talks to the engine over `127.0.0.1` only, so the engine is not reachable from other machines. The application uses port 47816 (or the next free one). Every request must carry a session key that only its window knows, so other programs on the computer cannot use the engine either. `soloptima serve` ([Browser mode and tests](#browser-mode-and-tests)) uses port 8080, or the next free port up to 8099, and is protected the same way: it opens the browser at a one-time address, which the page trades for the session key.

## Command-line use

The same program runs projects without the window (on Windows, run it from a terminal to see its output):

```bash
./soloptima simulate web/examples/example_study.json results.json
./soloptima optimize web/examples/example_study.json optimum.json
./soloptima serve --port 8090 --data /path/to/projects --no-browser
```

`optimize` reads the project's `optimizer` block. Projects saved from the GUI store C-rates and sensitivity values as text, so a headless run uses a C-rate of 0.5 and no sensitivity cases.

## Build from source

Requirements: a C++17 compiler and `make`. The JSON parser, HTTP server and numerics are in `src/`, and the interface libraries and fonts are bundled in `web/vendor/`, so nothing depends on a CDN. The window uses the system's own web engine: WebKit on macOS (`src/app_mac.mm`) and Microsoft Edge WebView2 on Windows (`src/app_win.cpp`, whose SDK the first Windows build fetches from NuGet at a pinned version and checks by SHA-256).

### macOS

```bash
xcode-select --install
make
./soloptima
```

`./soloptima` opens the application window. The first command installs the Xcode command line tools; skip it if they are already installed. You can also double-click `Soloptima.command` in Finder, which builds on first run and again whenever the sources change.

### Linux

```bash
sudo apt install build-essential libcurl4-openssl-dev
make
./soloptima
```

`./soloptima` opens the application window when WebKitGTK is installed (`sudo apt install libwebkit2gtk-4.1-0`; the program loads it at run time, so the build does not need it). Without it, `./soloptima` shows the interface in the default browser.

### Windows

Install [MSYS2](https://www.msys2.org), open the **MSYS2 UCRT64** shell and install the toolchain once:

```bash
pacman -S --needed mingw-w64-ucrt-x86_64-gcc mingw-w64-ucrt-x86_64-nsis make python zip unzip
```

Then build and run from the source folder:

```bash
make
./soloptima.exe
```

`soloptima.exe` opens the application window. It is statically linked; besides Windows itself it needs only `WebView2Loader.dll`, which `make` places next to it. CMake is also supported (`cmake -B build && cmake --build build`); MSVC builds are untested.

### Browser mode and tests

On every platform, `./soloptima serve` shows the interface in the default browser instead of the window, which is useful when working on the interface. It opens the browser at a one-time address on http://127.0.0.1:8080 and prints it. That tab keeps working, reloads included, until Soloptima stops. Each start opens a new address, and a tab left over from an earlier run shows "No session key". `make test` runs the engine self-tests.

## Packaging and releases

```bash
make dist-mac        # dist/mac/Soloptima.app and dist/Soloptima-mac.dmg, requires macOS
make dist-windows    # dist/Soloptima-Setup-windows-x64.exe and dist/Soloptima-windows-x64.zip
make dist-linux      # dist/Soloptima-linux-x86_64.AppImage and dist/Soloptima-linux-x86_64.tar.gz
make dist VERSION=1.2.0   # all three, then packaging/checksums.sh for dist/SHA256SUMS.txt
```

<details>
<summary><b>Build hosts and tools</b></summary>

The Windows package builds natively under MSYS2, or cross-compiles on macOS after `brew install mingw-w64 makensis`. The Linux packages build natively on Linux x86_64, or anywhere with Docker running; they are built in an Ubuntu 20.04 container, so they also run on older distributions. The AppImage tools are fetched at pinned versions and checked by SHA-256. The scripts are in `packaging/`; the setup program is `packaging/windows/installer.nsi` (NSIS).

</details>

### Publishing a release

1. Set the version in `src/version.hpp`. `packaging/checksums.sh` takes the version for the release signature from this file.
2. Build the packages.
3. Sign the checksum list (minisign asks for the key's password):

   ```bash
   SOLOPTIMA_MINISIGN_KEY=~/.minisign/soloptima-primary.key ./packaging/checksums.sh
   ```

   This writes `dist/SHA256SUMS.txt` and `dist/SHA256SUMS.txt.minisig`. If the signature does not verify with a key in `RELEASE_KEYS`, the script deletes it again.
4. Create a GitHub release tagged `v<version>` (for example `v1.2.0`) and attach these files under exactly these names: `Soloptima-Setup-windows-x64.exe`, `Soloptima-windows-x64.zip`, `Soloptima-mac.dmg`, `Soloptima-linux-x86_64.AppImage`, `Soloptima-linux-x86_64.tar.gz`, `SHA256SUMS.txt` and `SHA256SUMS.txt.minisig`.

The update check reads the latest release, and the download buttons at the top of this page point to these names. `make dist` also ends by running `packaging/checksums.sh`, so it signs the list when `SOLOPTIMA_MINISIGN_KEY` is set. For a local build, `./packaging/checksums.sh --unsigned` writes the list without a signature; installed copies will not take such a build as an update.

### Signing

The packaging scripts sign the builds when these variables are set, and leave them unsigned (macOS: ad-hoc signed) otherwise.

<details>
<summary><b>Signing variables</b></summary>

| Variable | Effect |
|---|---|
| `SOLOPTIMA_SIGN_ID` (macOS) | A "Developer ID Application" identity in the keychain (Apple Developer Program). The app and the disk image are signed with the hardened runtime and a secure timestamp. |
| `SOLOPTIMA_NOTARY_PROFILE` (macOS) | A `notarytool` keychain profile (`xcrun notarytool store-credentials`). The disk image is notarised by Apple and stapled, so it opens without a warning. |
| `SOLOPTIMA_SIGN_CMD` (Windows) | A command that signs the file given as its last argument, for example `signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /a` on Windows, or `jsign` with a cloud key elsewhere. `Soloptima.exe` and the setup program are signed. |

Apple signing needs a Mac. The Linux packages carry no platform signature. For Windows, a code-signing certificate from a certificate authority (held in a cloud key service or on a hardware token) and Microsoft's Artifact Signing service both work with `SOLOPTIMA_SIGN_CMD`.

</details>

Once builds are signed, an installed copy accepts only updates signed by the same publisher: the same Apple team on macOS, the same certificate subject and issuer on Windows.

#### Release signature

Every release is signed with a Soloptima release key, on every platform. An installed copy installs an update only when the release's `SHA256SUMS.txt` carries a minisign signature (`SHA256SUMS.txt.minisig`) by a key built into it (`RELEASE_KEYS` in `src/update.cpp`), the signature's trusted comment names that release, and the installer matches the list. A release without the signature can still be downloaded by hand from the release page.

There are two keys: the primary signs releases, and the backup is kept offline. If the primary is lost or exposed, sign the next release with the backup and remove the primary from `RELEASE_KEYS`.

## Documentation

- [docs/MANUAL.md](docs/MANUAL.md): each page of the application, the models behind the results, and known limitations
- [docs/FINANCE.md](docs/FINANCE.md): project finance formulas and presets
- [docs/LITERATURE.md](docs/LITERATURE.md): what was adopted from the published papers, the corrections made, and what was left out

Every input with an ⓘ button in the application has a short explanation and a typical value.

## Bug reports

**Report** in the top bar creates a bug report and saves it as a file in the data folder. Nothing is sent automatically. To share a report, open a [GitHub issue](https://github.com/Marcel-Bonifacio/Soloptima/issues) and paste the output of **Copy for an issue**, which leaves out the reporter name, project data and notes.

## Licence

Soloptima is open source under the [Apache License 2.0](LICENSE). You may use, change and distribute it, commercially or not, under the conditions of that licence; copies you pass on must include [NOTICE](NOTICE).

The [terms of use](TERMS.md) add the engineering and data-provider conditions. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) lists the bundled libraries with the licence of each.
