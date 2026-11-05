// Small platform layer: program and data locations, files, the clock, starting programs, opening the browser.
#pragma once
#include <ctime>
#include <filesystem>
#include <string>
#include <vector>

std::filesystem::path exe_dir();
std::filesystem::path user_data_dir();   // macOS: ~/Library/Application Support/Soloptima, Windows: %LOCALAPPDATA%\Soloptima
void open_browser(const std::string& url);
// Random bytes from the system's generator, as hex (the app's session key)
std::string random_hex(size_t bytes);
// Windows: a program built for windows (no console of its own) attaches to the console it was started from, so the
// command-line modes print there. Elsewhere it does nothing.
void attach_console();
// The system's folder picker; returns the chosen folder's path, or "" when cancelled. Throws std::runtime_error where
// there is none.
std::string pick_folder(const std::string& prompt);
// Moves `from` over `to` in one step, replacing it (on Windows too); throws std::filesystem::filesystem_error on failure.
void replace_file(const std::filesystem::path& from, const std::filesystem::path& to);
// Creates `p` and any missing folder above it. On POSIX the folders it creates are the owner's alone (0700); folders that
// exist keep their modes, since a folder the user chose may be shared on purpose. Throws std::filesystem::filesystem_error.
void make_private_dirs(const std::filesystem::path& p);
// Standard base64 with padding ("" for none); throws std::runtime_error on any other character or length
std::string base64_decode(const std::string& in);
// The whole file; false when it cannot be opened.
bool read_file(const std::filesystem::path& p, std::string& out);
// UTC calendar time, safe from any thread (std::gmtime shares one buffer between threads)
std::tm utc_tm(std::time_t t);
std::string utc_now_iso();   // "YYYY-MM-DDTHH:MM:SSZ"

#if defined(_WIN32)
std::wstring widen(const std::string& utf8);
#else
// Starts args[0] (looked up on PATH) without a shell, with input and output on /dev/null; the engine's sockets carry
// FD_CLOEXEC, so it does not inherit them. wait: returns its exit status (-1 when it did not start or exit normally);
// otherwise 0 once it has started.
int spawn_program(const std::vector<std::string>& args, bool wait);
#endif
