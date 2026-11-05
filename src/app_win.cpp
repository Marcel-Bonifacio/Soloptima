// Windows desktop window: Microsoft Edge WebView2 showing the interface the engine serves on 127.0.0.1. The runtime is
// part of Windows 11 and of current Windows 10; WebView2Loader.dll ships next to the program. The page reaches the
// native side through window.chrome.webview (see Native in web/js/util.js): saving files, opening links in the default
// browser, and quitting once it has saved its work. Printing uses WebView2's own print preview.
#include "app.hpp"
#if defined(_WIN32)
#include "json.hpp"
#include "platform.hpp"
#include <windows.h>
#include <shellapi.h>
#include <shobjidl.h>
#include "WebView2.h"
#include <algorithm>
#include <atomic>
#include <filesystem>
#include <fstream>
#include <functional>
#include <memory>
#include <string>

namespace {

const wchar_t* const WINDOW_CLASS = L"SoloptimaWindow";   // also how a second start finds this window
const UINT WM_APP_QUIT = WM_APP + 1, WM_APP_SAVE = WM_APP + 2, WM_APP_OPEN = WM_APP + 3;
const UINT_PTR QUIT_TIMER = 1;

std::string narrow(const wchar_t* w) {
    if (!w) return "";
    const int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
    std::string s(size_t(n > 0 ? n - 1 : 0), '\0');
    if (n > 1) WideCharToMultiByte(CP_UTF8, 0, w, -1, s.data(), n, nullptr, nullptr);
    return s;
}
// A string WebView2 allocated, converted and freed
std::string take(LPWSTR w) { std::string s = narrow(w); CoTaskMemFree(w); return s; }

std::string base64_decode(const std::string& in) {
    static const std::string chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    unsigned buf = 0;
    int bits = 0;
    for (char c : in) {
        const size_t v = chars.find(c);
        if (v == std::string::npos) continue;   // padding, line breaks
        buf = (buf << 6) | unsigned(v);
        bits += 6;
        if (bits >= 8) { bits -= 8; out += char((buf >> bits) & 0xFF); }
    }
    return out;
}

// A WebView2 callback object around a function. QueryInterface answers for IUnknown and the one interface it implements.
template <class I, class... A>
class Callback final : public I {
public:
    Callback(const wchar_t* iid, std::function<HRESULT(A...)> f) : f_(std::move(f)) { IIDFromString(iid, &iid_); }
    ULONG STDMETHODCALLTYPE AddRef() override { return ++refs_; }
    ULONG STDMETHODCALLTYPE Release() override {
        const ULONG n = --refs_;
        if (n == 0) delete this;
        return n;
    }
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** p) override {
        if (IsEqualIID(riid, IID_IUnknown) || IsEqualIID(riid, iid_)) { *p = this; AddRef(); return S_OK; }
        *p = nullptr;
        return E_NOINTERFACE;
    }
    HRESULT STDMETHODCALLTYPE Invoke(A... a) override { return f_(a...); }

private:
    std::atomic<ULONG> refs_{1};
    IID iid_{};
    std::function<HRESULT(A...)> f_;
};
// The new callback object, released at the end of the call it is passed to (WebView2 keeps its own reference)
template <class I>
struct Handler {
    I* p;
    explicit Handler(I* x) : p(x) {}
    Handler(const Handler&) = delete;
    ~Handler() { p->Release(); }
    operator I*() const { return p; }
};
template <class I, class... A, class F>
Handler<I> callback(const wchar_t* iid, F f) { return Handler<I>(new Callback<I, A...>(iid, std::function<HRESULT(A...)>(std::move(f)))); }

struct SaveRequest { std::string id, name, data; };

struct Shell {
    HWND hwnd = nullptr;
    ICoreWebView2Controller* controller = nullptr;
    ICoreWebView2* web = nullptr;
    std::wstring origin;   // http://127.0.0.1:<port>
    bool quitting = false;
} shell;

bool is_external(const std::wstring& uri) { return uri.rfind(L"http://", 0) == 0 || uri.rfind(L"https://", 0) == 0 || uri.rfind(L"mailto:", 0) == 0; }
// Links to other sites open in the default browser, after the current WebView2 event has returned
void open_external(const std::wstring& uri) { if (is_external(uri)) PostMessageW(shell.hwnd, WM_APP_OPEN, 0, LPARAM(new std::wstring(uri))); }
bool is_home(const std::wstring& uri) { return uri.rfind(shell.origin + L"/", 0) == 0 || uri == shell.origin; }

// The window cannot show the interface: say why and close
void fail(const wchar_t* what, HRESULT hr) {
    wchar_t msg[400];
    swprintf(msg, 400, L"%ls (error 0x%08lX).\n\nRestart Soloptima. If it happens again, reinstall it or the Microsoft Edge WebView2 Runtime.", what, (unsigned long)hr);
    MessageBoxW(shell.hwnd, msg, L"Soloptima", MB_ICONERROR);
    DestroyWindow(shell.hwnd);
}

void run_script(const std::wstring& js, std::function<void(const std::string&)> done = nullptr) {
    if (!shell.web) { if (done) done(""); return; }
    shell.web->ExecuteScript(js.c_str(), callback<ICoreWebView2ExecuteScriptCompletedHandler, HRESULT, LPCWSTR>(
        L"{49511172-cc67-4bca-9923-137112f4c4cc}", [done](HRESULT hr, LPCWSTR result) {
            if (done) done(SUCCEEDED(hr) ? narrow(result) : "");
            return S_OK;
        }));
}
void reply(const std::string& id, const json::Value& v) { run_script(widen("SoloptimaNative.reply(" + id + "," + v.dump() + ")")); }

// A file from the page (base64) to a place the user picks
void save(const SaveRequest& r) {
    IFileSaveDialog* dlg = nullptr;
    if (FAILED(CoCreateInstance(CLSID_FileSaveDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dlg)))) {
        reply(r.id, json::Value(json::Object{{"error", "The save dialog could not be opened."}}));
        return;
    }
    const std::wstring name = widen(std::filesystem::u8path(r.name).filename().u8string());
    dlg->SetFileName(name.c_str());
    const size_t dot = name.rfind(L'.');
    std::wstring ext = dot == std::wstring::npos ? L"" : name.substr(dot + 1), pattern = L"*." + ext;
    if (!ext.empty()) {
        const COMDLG_FILTERSPEC types[] = {{ext.c_str(), pattern.c_str()}, {L"All files", L"*.*"}};
        dlg->SetFileTypes(2, types);
        dlg->SetDefaultExtension(ext.c_str());
    }
    json::Value out(json::Object{{"cancelled", true}});
    if (SUCCEEDED(dlg->Show(shell.hwnd))) {
        IShellItem* item = nullptr;
        LPWSTR path = nullptr;
        if (SUCCEEDED(dlg->GetResult(&item)) && SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &path))) {
            const std::filesystem::path p(path);
            CoTaskMemFree(path);
            std::ofstream f(p, std::ios::binary | std::ios::trunc);
            const std::string data = base64_decode(r.data);
            f.write(data.data(), std::streamsize(data.size()));
            f.close();
            out = f ? json::Value(json::Object{{"path", p.u8string()}}) : json::Value(json::Object{{"error", "The file could not be saved."}});
        }
        if (item) item->Release();
    }
    dlg->Release();
    reply(r.id, out);
    if (shell.controller) shell.controller->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
}

void on_message(const std::string& text) {
    json::Value m;
    try { m = json::parse(text); } catch (...) { return; }
    const std::string cmd = m.gets("cmd", ""), id = m.has("id") ? std::to_string((long long)m.get("id", 0)) : "null";
    if (cmd == "quit-ready") DestroyWindow(shell.hwnd);
    else if (cmd == "quit-cancel") { KillTimer(shell.hwnd, QUIT_TIMER); shell.quitting = false; }   // the user kept the window open
    else if (cmd == "open") open_external(widen(m.gets("url", "")));
    else if (cmd == "save")   // after this callback returns: the dialog runs its own message loop
        PostMessageW(shell.hwnd, WM_APP_SAVE, 0, LPARAM(new SaveRequest{id, m.gets("name", "Soloptima export"), m.gets("data", "")}));
}

// Closing asks the page to save first (the protocol is in app.hpp)
void begin_quit() {
    if (shell.quitting) return;
    shell.quitting = true;
    SetTimer(shell.hwnd, QUIT_TIMER, QUIT_ANSWER_MS, nullptr);
    run_script(widen(QUIT_REQUEST_JS), [](const std::string& r) {
        if (r != "1") DestroyWindow(shell.hwnd);
        else if (shell.quitting) SetTimer(shell.hwnd, QUIT_TIMER, QUIT_SAVE_MS, nullptr);
    });
}

// The controller is ready: set up the web view and load the interface
void show_interface(ICoreWebView2Controller* c, const std::wstring& boot, const std::wstring& url) {
    ICoreWebView2* web = nullptr;
    const HRESULT hr = c->get_CoreWebView2(&web);
    if (FAILED(hr) || !web) { fail(L"The window's web view could not be created", hr); return; }
    shell.controller = c;
    c->AddRef();
    shell.web = web;
    RECT r;
    GetClientRect(shell.hwnd, &r);
    c->put_Bounds(r);
    c->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);   // typing reaches the page from the start
    ICoreWebView2Settings* s = nullptr;
    if (SUCCEEDED(web->get_Settings(&s)) && s) {
        s->put_AreDevToolsEnabled(GetEnvironmentVariableW(L"SOLOPTIMA_DEVTOOLS", nullptr, 0) > 0);
        s->put_IsStatusBarEnabled(FALSE);
        s->Release();
    }
    EventRegistrationToken t;
    web->add_WebMessageReceived(callback<ICoreWebView2WebMessageReceivedEventHandler, ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs*>(
        L"{57213f19-00e6-49fa-8e07-898ea01ecbd2}", [](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* a) {
            LPWSTR src = nullptr, msg = nullptr;
            a->get_Source(&src);
            const bool home = src && is_home(src);   // only the interface itself
            CoTaskMemFree(src);
            if (home && SUCCEEDED(a->TryGetWebMessageAsString(&msg))) on_message(take(msg));
            return S_OK;
        }), &t);
    web->add_NewWindowRequested(callback<ICoreWebView2NewWindowRequestedEventHandler, ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs*>(
        L"{d4c185fe-c81c-4989-97af-2d3fa7ab5651}", [](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* a) {
            LPWSTR uri = nullptr;   // target="_blank" and window.open: the default browser
            if (SUCCEEDED(a->get_Uri(&uri)) && uri) { open_external(uri); CoTaskMemFree(uri); }
            a->put_Handled(TRUE);
            return S_OK;
        }), &t);
    web->add_NavigationStarting(callback<ICoreWebView2NavigationStartingEventHandler, ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs*>(
        L"{9adbe429-f36d-432b-9ddc-f8881fbd76e3}", [](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* a) {
            LPWSTR uri = nullptr;   // the interface stays in the window; other sites open in the browser
            if (SUCCEEDED(a->get_Uri(&uri)) && uri) {
                const std::wstring u(uri);
                CoTaskMemFree(uri);
                if (!is_home(u) && u.rfind(L"about:", 0) != 0 && u.rfind(L"data:", 0) != 0) { a->put_Cancel(TRUE); open_external(u); }
            }
            return S_OK;
        }), &t);
    web->AddScriptToExecuteOnDocumentCreated(boot.c_str(), callback<ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler, HRESULT, LPCWSTR>(
        L"{b99369f3-9b11-47b5-bc6f-8e7895fcea17}", [url](HRESULT, LPCWSTR) {
            if (shell.web) shell.web->Navigate(url.c_str());
            return S_OK;
        }));
}

void start_webview(const AppWindow& w, decltype(&CreateCoreWebView2EnvironmentWithOptions) create) {
    // the window's cache and browser storage, beside the default data folder (that folder may be moved or deleted)
    const std::filesystem::path data = user_data_dir().parent_path() / L"Soloptima-WebView2";
    std::error_code ec;
    std::filesystem::create_directories(data, ec);
    const std::wstring boot = widen(w.boot_script("windows")), url = widen(w.url);
    const HRESULT hr = create(nullptr, data.c_str(), nullptr,
        callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler, HRESULT, ICoreWebView2Environment*>(
            L"{4e8a3389-c9d8-4bd2-b6b5-124fee6cc14d}", [boot, url](HRESULT hr1, ICoreWebView2Environment* env) {
                if (FAILED(hr1) || !env) { fail(L"The WebView2 runtime could not be started", hr1); return S_OK; }
                const HRESULT hr2 = env->CreateCoreWebView2Controller(shell.hwnd, callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler, HRESULT, ICoreWebView2Controller*>(
                    L"{6c4819f3-c9b7-4260-8127-c9f5bde7f68c}", [boot, url](HRESULT hr3, ICoreWebView2Controller* c) {
                        if (!shell.hwnd) return S_OK;   // the window closed meanwhile
                        if (FAILED(hr3) || !c) fail(L"The window's web view could not be created", hr3);
                        else show_interface(c, boot, url);
                        return S_OK;
                    }));
                if (FAILED(hr2)) fail(L"The window's web view could not be created", hr2);
                return S_OK;
            }));
    if (FAILED(hr)) fail(L"The WebView2 runtime could not be started", hr);
}

// The smallest window: 960 x 620 at 100 % scaling, but never larger than the screen's work area
POINT min_size(HWND h) {
    const UINT dpi = GetDpiForWindow(h) ? GetDpiForWindow(h) : 96;
    MONITORINFO mi{};
    mi.cbSize = sizeof mi;
    GetMonitorInfoW(MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST), &mi);
    return {std::min<LONG>(LONG(960 * dpi / 96), mi.rcWork.right - mi.rcWork.left), std::min<LONG>(LONG(620 * dpi / 96), mi.rcWork.bottom - mi.rcWork.top)};
}

LRESULT CALLBACK wnd_proc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_SIZE:
        if (shell.controller) { RECT r; GetClientRect(h, &r); shell.controller->put_Bounds(r); }
        return 0;
    case WM_MOVE:
    case WM_MOVING:
        if (shell.controller) shell.controller->NotifyParentWindowPositionChanged();   // keeps pop-ups and accessibility aligned
        break;
    case WM_SETFOCUS:   // activation (Alt+Tab, a closed dialog) gives the page the keyboard again
        if (shell.controller) shell.controller->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
        return 0;
    case WM_GETMINMAXINFO:
        reinterpret_cast<MINMAXINFO*>(lp)->ptMinTrackSize = min_size(h);
        return 0;
    case WM_DPICHANGED: {   // moved to a screen with another scaling: take the size Windows suggests
        const RECT* r = reinterpret_cast<const RECT*>(lp);
        SetWindowPos(h, nullptr, r->left, r->top, r->right - r->left, r->bottom - r->top, SWP_NOZORDER | SWP_NOACTIVATE);
        return 0;
    }
    case WM_CLOSE:
        if (shell.web) begin_quit(); else DestroyWindow(h);
        return 0;
    case WM_TIMER:   // the page did not answer, or saving took too long: close anyway
        if (wp != QUIT_TIMER) break;
        KillTimer(h, QUIT_TIMER);
        DestroyWindow(h);
        return 0;
    case WM_APP_QUIT:
        DestroyWindow(h);
        return 0;
    case WM_APP_SAVE: {
        std::unique_ptr<SaveRequest> r(reinterpret_cast<SaveRequest*>(lp));
        save(*r);
        return 0;
    }
    case WM_APP_OPEN: {
        std::unique_ptr<std::wstring> u(reinterpret_cast<std::wstring*>(lp));
        ShellExecuteW(nullptr, L"open", u->c_str(), nullptr, nullptr, SW_SHOWNORMAL);
        return 0;
    }
    case WM_DESTROY:
        if (shell.controller) { shell.controller->Close(); shell.controller->Release(); shell.controller = nullptr; }
        if (shell.web) { shell.web->Release(); shell.web = nullptr; }
        shell.hwnd = nullptr;
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcW(h, msg, wp, lp);
}

} // namespace

bool app_window_available() { return true; }   // WebView2 itself is checked when the window opens

bool app_claim_single_instance(int) {
    // the mutex lives as long as the process; the setup program waits for it to go before it replaces the files
    CreateMutexW(nullptr, FALSE, L"Local\\SoloptimaApp");
    if (GetLastError() != ERROR_ALREADY_EXISTS) return true;
    if (HWND other = FindWindowW(WINDOW_CLASS, nullptr)) {
        if (IsIconic(other)) ShowWindow(other, SW_RESTORE);
        SetForegroundWindow(other);
    }
    return false;
}

int run_app_window(const AppWindow& w) {
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    shell.origin = widen(w.origin());
    HMODULE loader = LoadLibraryW((exe_dir() / L"WebView2Loader.dll").c_str());
    const auto fn = [loader](const char* name) { return loader ? reinterpret_cast<void*>(GetProcAddress(loader, name)) : nullptr; };
    auto create = reinterpret_cast<decltype(&CreateCoreWebView2EnvironmentWithOptions)>(fn("CreateCoreWebView2EnvironmentWithOptions"));
    auto version = reinterpret_cast<decltype(&GetAvailableCoreWebView2BrowserVersionString)>(fn("GetAvailableCoreWebView2BrowserVersionString"));
    if (!create || !version) {
        MessageBoxW(nullptr, L"WebView2Loader.dll is missing next to Soloptima.exe. Reinstall Soloptima.", L"Soloptima", MB_ICONERROR);
        return 1;
    }
    LPWSTR v = nullptr;
    if (FAILED(version(nullptr, &v)) || !v) {
        if (MessageBoxW(nullptr, L"Soloptima needs the Microsoft Edge WebView2 Runtime, which Windows 11 and current Windows 10 include but this "
                                 L"computer lacks.\n\nOpen the download page now?", L"Soloptima", MB_ICONWARNING | MB_YESNO) == IDYES)
            ShellExecuteW(nullptr, L"open", L"https://developer.microsoft.com/microsoft-edge/webview2/", nullptr, nullptr, SW_SHOWNORMAL);
        return 1;
    }
    CoTaskMemFree(v);

    const HINSTANCE inst = GetModuleHandleW(nullptr);
    WNDCLASSEXW wc{};
    wc.cbSize = sizeof wc;
    wc.lpfnWndProc = wnd_proc;
    wc.hInstance = inst;
    wc.hIcon = LoadIconW(inst, MAKEINTRESOURCEW(1));   // the app icon resource (packaging/windows/resources.sh)
    wc.hIconSm = static_cast<HICON>(LoadImageW(inst, MAKEINTRESOURCEW(1), IMAGE_ICON, GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON), 0));
    wc.hCursor = LoadCursorW(nullptr, MAKEINTRESOURCEW(32512));   // IDC_ARROW
    wc.hbrBackground = CreateSolidBrush(RGB(244, 246, 248));
    wc.lpszClassName = WINDOW_CLASS;
    RegisterClassExW(&wc);
    RECT area;
    SystemParametersInfoW(SPI_GETWORKAREA, 0, &area, 0);
    const int aw = area.right - area.left, ah = area.bottom - area.top, ww = aw * 88 / 100, wh = ah * 90 / 100;
    shell.hwnd = CreateWindowExW(0, WINDOW_CLASS, L"Soloptima", WS_OVERLAPPEDWINDOW, area.left + (aw - ww) / 2, area.top + (ah - wh) / 2, ww, wh,
                                 nullptr, nullptr, inst, nullptr);
    if (!shell.hwnd) return 1;
    ShowWindow(shell.hwnd, SW_SHOWNORMAL);
    UpdateWindow(shell.hwnd);
    start_webview(w, create);
    MSG m;
    while (GetMessageW(&m, nullptr, 0, 0) > 0) {
        TranslateMessage(&m);
        DispatchMessageW(&m);
    }
    return 0;
}

void app_quit() {
    if (HWND h = shell.hwnd) PostMessageW(h, WM_APP_QUIT, 0, 0);
}
#endif
