#include "platform.hpp"
#include <cstdio>
#include <cstdlib>
#include <stdexcept>

#if defined(_WIN32)
#include <windows.h>
#include <shellapi.h>
#elif defined(__APPLE__)
#include <mach-o/dyld.h>
#include <climits>
#else
#include <climits>
#include <unistd.h>
#endif

namespace fs = std::filesystem;

fs::path exe_dir() {
#if defined(_WIN32)
    wchar_t buf[MAX_PATH * 4];
    DWORD n = GetModuleFileNameW(nullptr, buf, DWORD(sizeof buf / sizeof buf[0]));
    if (n > 0) return fs::path(std::wstring(buf, n)).parent_path();
#elif defined(__APPLE__)
    char buf[PATH_MAX * 2];
    uint32_t size = sizeof buf;
    if (_NSGetExecutablePath(buf, &size) == 0) {
        std::error_code ec;
        fs::path p = fs::canonical(buf, ec);
        return (ec ? fs::path(buf) : p).parent_path();
    }
#else
    char buf[PATH_MAX];
    ssize_t n = readlink("/proc/self/exe", buf, sizeof buf - 1);
    if (n > 0) return fs::path(std::string(buf, size_t(n))).parent_path();
#endif
    return fs::current_path();
}

fs::path user_data_dir() {
#if defined(_WIN32)
    if (const wchar_t* la = _wgetenv(L"LOCALAPPDATA")) return fs::path(la) / L"Soloptima";
    if (const wchar_t* up = _wgetenv(L"USERPROFILE")) return fs::path(up) / L"Soloptima";
#elif defined(__APPLE__)
    if (const char* h = std::getenv("HOME")) return fs::path(h) / "Library" / "Application Support" / "Soloptima";
#else
    if (const char* x = std::getenv("XDG_DATA_HOME")) return fs::path(x) / "Soloptima";
    if (const char* h = std::getenv("HOME")) return fs::path(h) / ".local" / "share" / "Soloptima";
#endif
    return fs::current_path() / "data";
}

void open_browser(const std::string& url) {
    // url is always our own http://127.0.0.1:<port>/ address (digits only), never user input
#if defined(_WIN32)
    if (reinterpret_cast<INT_PTR>(ShellExecuteA(nullptr, "open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL)) <= 32)
        std::printf("Open %s in your browser.\n", url.c_str());
#elif defined(__APPLE__)
    if (std::system(("open '" + url + "'").c_str()) != 0) std::printf("Open %s in your browser.\n", url.c_str());
#else
    if (std::system(("xdg-open '" + url + "' >/dev/null 2>&1").c_str()) != 0) std::printf("Open %s in your browser.\n", url.c_str());
#endif
}

void replace_file(const std::filesystem::path& from, const std::filesystem::path& to) {
#if defined(_WIN32)
    if (!MoveFileExW(from.c_str(), to.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
        throw std::filesystem::filesystem_error("replace_file", from, to, std::error_code(int(GetLastError()), std::system_category()));
#else
    std::filesystem::rename(from, to);
#endif
}

std::string pick_folder(const std::string& prompt) {
    std::string out;
    char buf[1024];
#if defined(_WIN32)
    // a top-most owner window brings the dialog in front of the browser; output as UTF-8 so any path survives
    const std::string cmd = "powershell -NoProfile -STA -Command \"Add-Type -AssemblyName System.Windows.Forms; "
                            "$o = New-Object System.Windows.Forms.Form -Property @{TopMost=$true; ShowInTaskbar=$false}; "
                            "$d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '" + prompt + "'; "
                            "if ($d.ShowDialog($o) -eq 'OK') { [Console]::OutputEncoding = [Text.Encoding]::UTF8; [Console]::Write($d.SelectedPath) }\"";
    FILE* p = _popen(cmd.c_str(), "r");
#elif defined(__APPLE__)
    const std::string cmd = "osascript -e 'POSIX path of (choose folder with prompt \"" + prompt + "\")' 2>/dev/null";
    FILE* p = popen(cmd.c_str(), "r");
#else
    (void)prompt;
    FILE* p = nullptr;
    throw std::runtime_error("There is no folder picker on this system: type the folder path.");
#endif
    if (!p) throw std::runtime_error("The folder picker could not be opened: type the folder path.");
    while (std::fgets(buf, sizeof buf, p)) out += buf;
#if defined(_WIN32)
    _pclose(p);
#else
    pclose(p);
#endif
    while (!out.empty() && (out.back() == '\n' || out.back() == '\r')) out.pop_back();
    return out;
}
