# Soloptima 2.0.0

Soloptima 2.0 is a new build of the same program. The engine and the interface were rewritten, and the results are the same as in version 1 to within rounding. Your profiles, projects, reports and settings carry over without any step on your side.

## What changed for you

- **Same results.** The engine now runs inside the application window instead of as a separate local server. The hourly dispatch, battery ageing, fuel, optimiser, project finance, forecasting and EMS give the same numbers as version 1. The checks that compare the two are listed in `docs/VALIDATION.md`.
- **A new interface.** Every page was rebuilt, with the same pages, the same report and the same Excel export.
- **Quieter and safer.** Soloptima no longer opens a network port on your computer. Files, printing and links go through the application itself.
- **Saved before you quit.** Cmd+Q on macOS and closing the window save your work first.
- **Clearer update messages.** When a release has no update file, Soloptima says so instead of showing an error.

## Updating from version 1

Soloptima 1.x offers 2.0.0 in its own update page. Choose **Install**; the old copy closes, the new one replaces it and starts.

- Windows: the setup program installs into the same folder as before (`%LOCALAPPDATA%\Programs\Soloptima`) and takes over the entry in Apps & features, so you keep one copy. It asks no questions during an update.
- macOS: the new app replaces the old one in place.
- Linux: the new AppImage replaces the old one next to it.

Where your data lives does not change:

| System | Folder |
|---|---|
| Windows | `%LOCALAPPDATA%\Soloptima` |
| macOS | `~/Library/Application Support/Soloptima` |
| Linux | `~/.local/share/Soloptima` (or `$XDG_DATA_HOME/Soloptima`) |

A folder you chose in Settings, and a `data` folder next to the program (for a USB stick), are used as before. On Linux the `data` folder can also sit next to the AppImage file. The update choices you made in 1.x (automatic check, skipped version) are kept.

## Downloads

| System | File |
|---|---|
| Windows 10 or 11 (64-bit) | `Soloptima-Setup-windows-x64.exe` |
| macOS 11 or later | `Soloptima-mac.dmg` |
| Linux x86_64 | `Soloptima-linux-x86_64.AppImage` or `Soloptima-linux-x86_64.deb` |

`SHA256SUMS.txt` and its signature (`SHA256SUMS.txt.minisig`) list the checksum of each installer. The builds are not code-signed yet, so Windows and macOS show a security warning on first launch; the README describes the one-time steps.
