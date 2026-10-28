// Small platform layer: executable location, per-user data folder, opening the browser.
#pragma once
#include <filesystem>
#include <string>

std::filesystem::path exe_dir();
std::filesystem::path user_data_dir();   // macOS: ~/Library/Application Support/Soloptima, Windows: %LOCALAPPDATA%\Soloptima
void open_browser(const std::string& url);
// The system's folder picker; returns the chosen folder's path, or "" when cancelled. Throws std::runtime_error where
// there is none.
std::string pick_folder(const std::string& prompt);
// Moves `from` over `to` in one step, replacing it (on Windows too); throws std::filesystem::filesystem_error on failure.
void replace_file(const std::filesystem::path& from, const std::filesystem::path& to);
