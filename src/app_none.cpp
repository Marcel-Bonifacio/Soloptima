// Systems without a desktop window (other than macOS, Windows and Linux): main.cpp runs the app command as serve.
#include "app.hpp"
#if !defined(_WIN32) && !defined(__APPLE__) && !defined(__linux__)
bool app_window_available() { return false; }
bool app_claim_single_instance(int) { return true; }
int run_app_window(const AppWindow&) { return -1; }
void app_quit() {}
#endif
