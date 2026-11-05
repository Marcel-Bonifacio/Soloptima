// The desktop window around the interface: WebKit on macOS (app_mac.mm), WebView2 on Windows (app_win.cpp), WebKitGTK on
// Linux (app_linux.cpp). The engine keeps serving the interface on 127.0.0.1; the window loads it and hands the page a
// session key, which every /api/ call must then carry, so other programs on the computer cannot use the engine.
//
// Closing the window runs QUIT_REQUEST_JS, which asks the page to save (SoloptimaApp.requestQuit in web/js/home.js). The
// page answers "quit-ready", or "quit-cancel" when a save failed and the user keeps the window. A page that has not taken
// the request within QUIT_ANSWER_MS does not hold the window open; once it has, saving (or the user's choice) gets
// QUIT_SAVE_MS.
#pragma once
#include <string>

constexpr const char* QUIT_REQUEST_JS = "window.SoloptimaApp ? (SoloptimaApp.requestQuit(), 1) : 0";
constexpr unsigned QUIT_ANSWER_MS = 5000, QUIT_SAVE_MS = 120000;

struct AppWindow {
    std::string url;       // http://127.0.0.1:<port>/
    std::string token;     // the session key
    std::string version;
    std::string icon;      // the app icon as PNG: the window icon on Linux, the Dock icon outside an app bundle on macOS

    std::string origin() const { return url.substr(0, url.size() - 1); }   // http://127.0.0.1:<port>
    // Runs at the start of every document; only the interface's own pages get the session key
    std::string boot_script(const char* platform) const {
        return "if (location.origin === '" + origin() + "') window.SOLOPTIMA = {token: '" + token + "', platform: '" + platform +
               "', version: '" + version + "'};";
    }
};

// A window can be shown: always on macOS and Windows; on Linux when WebKitGTK is installed and there is a display.
bool app_window_available();
// False when Soloptima already runs as an app; that one is brought to the front instead.
bool app_claim_single_instance(int port);
// Opens the window and runs the event loop until the user quits; returns the exit code.
int run_app_window(const AppWindow& w);
// Close the app from any thread (the page has saved its work). Does nothing when no window runs.
void app_quit();

// Another Soloptima answers on this port (main.cpp).
bool soloptima_running(int port);
