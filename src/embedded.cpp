// The window functions of app.hpp when the engine is built into the desktop shell (src-tauri, SOLOPTIMA_EMBEDDED): the
// shell owns the window, so the engine only asks it to quit. Empty in the standalone build.
#ifdef SOLOPTIMA_EMBEDDED
#include "app.hpp"

namespace {
void (*quit_hook)() = nullptr;
}

extern "C" void soloptima_set_quit_hook(void (*hook)()) { quit_hook = hook; }

bool app_window_available() { return false; }
bool app_claim_single_instance(int) { return true; }
int run_app_window(const AppWindow&) { return 1; }
void app_quit() {
    if (quit_hook) quit_hook();
}
#endif
