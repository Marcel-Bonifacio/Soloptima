# ![Soloptima](docs/brand/soloptima-logo.svg)

Soloptima sizes and models hybrid power plants that combine solar PV, battery energy storage (BESS) and diesel generators, with optional wind turbines. The tool is built around one design question:

> *For a known load and an existing diesel fleet, how much PV and battery capacity should be built, and how should the plant be operated?*

Starting from a site, a load profile and the generator fleet, Soloptima simulates every hour of the project life, searches for the lowest-cost PV and battery sizes, and carries the result through to fuel savings, project finance and a full engineering report.

The application runs entirely on the local machine. A C++ engine serves the interface to the default web browser. No account or cloud service is required, and projects are stored as plain files on disk.

## Download

<p>
  <a href="https://github.com/Marcel-Bonifacio/Soloptima/releases/download/v1.0.0/Soloptima-1.0.0-windows-x64.zip"><img src="https://img.shields.io/badge/Download_for_Windows-v1.0.0-0f7466?style=for-the-badge&logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0wIDBoMTEuNHYxMS40SDB6TTEyLjYgMEgyNHYxMS40SDEyLjZ6TTAgMTIuNmgxMS40VjI0SDB6TTEyLjYgMTIuNkgyNFYyNEgxMi42eiIvPjwvc3ZnPg==" alt="Download for Windows" height="36"></a>
  &nbsp;
  <a href="https://github.com/Marcel-Bonifacio/Soloptima/releases/download/v1.0.0/Soloptima-1.0.0-mac.dmg"><img src="https://img.shields.io/badge/Download_for_macOS-v1.0.0-15181d?style=for-the-badge&logo=apple&logoColor=white" alt="Download for macOS" height="36"></a>
</p>

Windows 10 or 11 (64-bit) · macOS 11 or later (Apple silicon and Intel) · [All releases](https://github.com/Marcel-Bonifacio/Soloptima/releases)

Neither build is code-signed, so both operating systems show a security warning on first launch. The steps below cover the one-time workaround.

### Windows

1. Extract the zip archive to a permanent location, for example `Documents\Soloptima`.
2. Run `Soloptima.exe`. The `web` folder must stay next to the executable, because the interface is loaded from it.
3. If SmartScreen blocks the launch, select **More info**, then **Run anyway**.
4. The application opens in the default browser. A console window opens alongside it and must stay open during use. Closing the console stops the application.

### macOS

1. Open the `.dmg` and drag Soloptima into Applications.
2. On first launch, right-click the app, select **Open**, then confirm with **Open**. A plain double-click is blocked once because the app is not notarised by Apple. On macOS 15 and later, if no Open button appears, go to System Settings > Privacy & Security and select **Open Anyway**.
3. The application opens in the default browser and runs in the background without a Dock icon. To stop it, select **Quit Soloptima** in the user menu at the top right.

Launching the app while it is already running reopens the page.

## Getting started

The first screen is the profile page. Create a profile and accept the terms of use. Profiles keep projects separate on a shared computer and have no password.

**Open the example study** loads a complete reference project: a generic off-grid industrial site with 30 MWp of PV, a 6.6 MWh battery and 20 × 1.8 MW diesel generators, with PVGIS weather data included. The pages in the left sidebar follow the workflow in order, from site and solar resource through to results, finance and the report.

The example coordinates are a placeholder. Set the actual site location before relying on any result.

## Data storage

Projects are saved automatically.

| System | Default folder |
|---|---|
| Windows | `%LOCALAPPDATA%\Soloptima` |
| macOS | `~/Library/Application Support/Soloptima` |
| Linux | `~/.local/share/Soloptima` |

The folder can be changed under **Settings** in the user menu. For a portable installation, for example on a USB drive, create an empty `data\users` folder next to the executable. Soloptima then uses it instead of the default location.

**Export .json** produces a self-contained project file. It includes the weather and load data, so it also runs offline and from the command line. Google Maps and Open-Meteo API keys are excluded from exported files.

## Network access

All modelling runs offline. Network access is used only for weather data (PVGIS, NASA POWER), weather forecasts (Open-Meteo, MET Norway), map tiles and place search, and these requests include the site coordinates. [TERMS.md](TERMS.md) lists exactly what is sent to each service.

The built-in server binds to `127.0.0.1` only and is not reachable from other machines. It listens on port 8080, or on the next free port up to 8099.

## Building from source

Requirements: a C++17 compiler and `make`. There are no other dependencies. The JSON parser, HTTP server and numerics are in `src/`, and the browser libraries and fonts are bundled in `web/vendor/`, so the interface does not depend on a CDN.

### macOS

```bash
xcode-select --install
make
./soloptima
```

The first command installs the Xcode command line tools and can be skipped when the tools are already installed. Alternatively, double-click `Soloptima.command` in Finder, which builds on first run and again whenever the sources change.

### Linux

```bash
sudo apt install build-essential libcurl4-openssl-dev
make
./soloptima
```

### Windows

Install [MSYS2](https://www.msys2.org), open the **MSYS2 UCRT64** shell and install the toolchain once:

```bash
pacman -S --needed mingw-w64-ucrt-x86_64-gcc make python zip
```

Then build and run from the source folder:

```bash
make
./soloptima.exe
```

The Windows binary is fully static and needs no DLLs beyond those shipped with Windows. CMake is also supported (`cmake -B build && cmake --build build`); MSVC builds are untested.

On every platform the interface opens at http://127.0.0.1:8080. `make test` runs the engine self-tests.

### Packaging

```bash
make dist-mac        # dist/Soloptima-1.0.0-mac.dmg, requires macOS
make dist-windows    # dist/Soloptima-1.0.0-windows-x64.zip
make dist VERSION=1.1.0
```

The Windows package builds natively under MSYS2, or cross-compiles on macOS after `brew install mingw-w64`. The packaging scripts are in `packaging/`.

## Command-line use

The same binary runs projects without the interface:

```bash
./soloptima simulate web/examples/example_study.json results.json
./soloptima optimize web/examples/example_study.json optimum.json
./soloptima serve --port 8090 --data /path/to/projects --no-browser
```

`optimize` reads the project's `optimizer` block. Projects saved from the GUI store C-rates and sensitivity values as text, so a headless run uses a C-rate of 0.5 and no sensitivity cases.

## Documentation

- [docs/MANUAL.md](docs/MANUAL.md): each page of the application, the models behind the results, and known limitations
- [docs/FINANCE.md](docs/FINANCE.md): project finance formulas and presets
- [docs/LITERATURE.md](docs/LITERATURE.md): what was adopted from the published papers, the corrections made, and what was left out

Every input with an ⓘ button in the application has a short explanation and a typical value.

## Bug reports

**Report** in the top bar creates a bug report and saves it as a file in the data folder. Nothing is sent automatically. To share a report, open a [GitHub issue](https://github.com/Marcel-Bonifacio/Soloptima/issues) and paste the output of **Copy for an issue**, which omits the reporter name, project data and notes.

## Licence

Soloptima is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE.md). The licence text is authoritative. In summary, it permits personal research, study and hobby use with no commercial application, and use by charities, educational institutions, public research, public safety, health and environmental protection organisations, and government institutions, regardless of funding.

Commercial use, including paid consulting, client studies, internal company use and paid training, requires a separate licence. Contact: marcel@tirtawijata.com.

The [terms of use](TERMS.md) add the engineering and data-provider conditions. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) lists the bundled libraries with the licence of each.
