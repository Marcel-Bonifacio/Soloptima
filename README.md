# ![Soloptima](docs/brand/soloptima-logo.svg)

Soloptima is for sizing and modelling hybrid power plants: solar PV, a battery and diesel generators, with wind turbines if you want them. It started from one question:

> *Given a known load and a known diesel fleet, how much PV and how much battery should we build, and how should the plant be operated?*

You give it a site, a load profile and the generators already there. It simulates every hour of the project's life, searches for the PV and battery sizes that cost least, and carries the result through to fuel savings, project finance and a full engineering report.

Everything runs on your own computer. The engine is a small C++ program and the interface opens in your browser. There's no account and no cloud; projects are plain files on your disk.

## Download

Get the latest version from the [Releases page](https://github.com/Marcel-Bonifacio/Soloptima/releases/latest).

| System | File |
|---|---|
| Windows 10 or 11 (64-bit) | `Soloptima-1.0.0-windows-x64.zip` |
| macOS 11 or later (Apple silicon and Intel) | `Soloptima-1.0.0-mac.dmg` |

The app isn't code-signed, so Windows and macOS will both warn you the first time you open it. The steps below get you past that. You only have to do it once.

### Windows

1. Unzip the file somewhere you'll find it again, for example `Documents\Soloptima`.
2. Open the folder and double-click `Soloptima.exe`. Keep the `web` folder next to it, because the app loads its interface from there.
3. If you see "Windows protected your PC", click **More info**, then **Run anyway**.
4. Your browser opens the app. A black console window opens too. Leave it open while you work, because closing it stops Soloptima.

### macOS

1. Open the `.dmg` and drag Soloptima into Applications.
2. The first time, right-click the app, choose **Open**, then click **Open** again. A plain double-click is blocked once because Apple hasn't notarised the app. On macOS 15 and later the Open button may not appear. In that case go to System Settings, then Privacy & Security, and click **Open Anyway**.
3. Your browser opens the app. Soloptima runs in the background with no Dock icon. To stop it, open the user menu at the top right and choose **Quit Soloptima**.

If the app is already running, opening it again just brings the page back.

## First run

You start on a profile page. Make a profile with your name and accept the terms of use. Profiles only keep people's projects apart on a shared computer, so there are no passwords.

To see a finished study, click **Open the example study**. It's a generic off-grid industrial site with 30 MWp of PV, a 6.6 MWh battery and twenty 1.8 MW diesel generators, and the weather data comes with it. Work down the pages in the left sidebar, from the site and solar resource through to results, finance and the report.

The example's coordinates are only a placeholder. Set your real site before you rely on any numbers.

## Where your projects are saved

Projects save automatically while you work.

| System | Folder |
|---|---|
| Windows | `%LOCALAPPDATA%\Soloptima` |
| macOS | `~/Library/Application Support/Soloptima` |
| Linux | `~/.local/share/Soloptima` |

You can move the folder from **Settings** in the user menu. For a portable setup, on a USB stick for instance, create a folder called `data\users` next to the program and Soloptima will use that instead.

To send a project to someone, use **Export .json**. The file includes the weather and load data, so it also runs offline and from the command line. Your Google Maps and Open-Meteo API keys are left out of it.

## What needs the internet

Most of the app works offline. It goes online for weather data (PVGIS, NASA POWER), weather forecasts (Open-Meteo, MET Norway), map tiles and place search. Those requests carry the site's location. [TERMS.md](TERMS.md) lists exactly what is sent and to whom.

The built-in server only listens on `127.0.0.1`, so other computers on your network can't reach it. It uses port 8080, or the next free port up to 8099.

## Building from source

You need a C++17 compiler and `make`, nothing else. The JSON parser, HTTP server and maths are all in `src/`, and the browser libraries and fonts are in `web/vendor/`, so the interface doesn't depend on a CDN either.

### macOS

```bash
xcode-select --install
make
./soloptima
```

The first line installs Apple's command line tools; skip it if you already have them. You can also double-click `Soloptima.command` in Finder, which builds the app the first time and again whenever the source changes.

### Linux

```bash
sudo apt install build-essential libcurl4-openssl-dev
make
./soloptima
```

### Windows

Install [MSYS2](https://www.msys2.org), open the **MSYS2 UCRT64** shell and run this once:

```bash
pacman -S --needed mingw-w64-ucrt-x86_64-gcc make python zip
```

Then, in the source folder:

```bash
make
./soloptima.exe
```

The Windows build is fully static, so `soloptima.exe` runs on any Windows 10 or 11 machine without extra DLLs. CMake works too (`cmake -B build && cmake --build build`), though I haven't tested it with MSVC.

In every case the browser opens at http://127.0.0.1:8080. Run `make test` for the engine's self-tests.

### Building the installers

```bash
make dist-mac        # dist/Soloptima-1.0.0-mac.dmg, needs a Mac
make dist-windows    # dist/Soloptima-1.0.0-windows-x64.zip
make dist VERSION=1.1.0
```

The Windows package builds on Windows under MSYS2, or on a Mac after `brew install mingw-w64`. The packaging scripts are in `packaging/`.

## Command line

The same program runs projects without the interface:

```bash
./soloptima simulate web/examples/example_study.json results.json
./soloptima optimize web/examples/example_study.json optimum.json
./soloptima serve --port 8090 --data /path/to/projects --no-browser
```

`optimize` reads the project's `optimizer` block. A project saved from the app stores its C-rates and sensitivity values as text, so on the command line it runs with a C-rate of 0.5 and no sensitivity cases.

## Documentation

- [docs/MANUAL.md](docs/MANUAL.md) explains each page of the app, the models behind the results, and the known limitations.
- [docs/FINANCE.md](docs/FINANCE.md) has the project finance formulas and presets.
- [docs/LITERATURE.md](docs/LITERATURE.md) covers what came from the published papers, and what was corrected or left out.

In the app itself, every input with an ⓘ button has a short explanation and a typical value.

## Bugs and feedback

Click **Report** in the app's top bar. The report is saved as a file in your data folder and nothing is sent anywhere. If you'd like me to see it, open an [issue](https://github.com/Marcel-Bonifacio/Soloptima/issues) and paste it in; the **Copy for an issue** button leaves out your name and project.

## Licence

Soloptima is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE.md). The licence text is what counts, but in short: it's free for personal research, study and hobby use with no commercial purpose, and for charities, schools and universities, public research, public safety, health and environmental organisations, and government bodies, however they're funded.

Commercial use needs a separate licence. That covers things like paid consulting, studies for clients, use inside a company, and paid training. Write to marcel@tirtawijata.com.

The [terms of use](TERMS.md) add the engineering and data-provider conditions, and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) lists the bundled libraries and their licences.
