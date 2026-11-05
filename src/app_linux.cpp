// Linux desktop window: WebKitGTK (GTK 3) showing the interface the engine serves on 127.0.0.1. The library is loaded at
// run time, so the program also starts where it is missing: main.cpp then shows the interface in the browser instead.
// The page reaches the native side through window.webkit.messageHandlers.soloptima, as on macOS (see Native in
// web/js/util.js): saving files, opening links in the default browser, and quitting once it has saved its work.
#include "app.hpp"
#if defined(__linux__)
#include "json.hpp"
#include "platform.hpp"
#include <dlfcn.h>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <type_traits>
#include <string>

namespace {

// GLib, GTK 3 and WebKitGTK through dlsym: every object is an opaque pointer here
using Ptr = void*;
using Callback = void (*)();
struct Gtk {
    int (*init_check)(int*, char***);
    void (*set_prgname)(const char*);
    Ptr (*window_new)(int);
    void (*window_set_title)(Ptr, const char*);
    void (*window_set_default_size)(Ptr, int, int);
    int (*window_set_icon_from_file)(Ptr, const char*, Ptr);
    void (*container_add)(Ptr, Ptr);
    void (*widget_show_all)(Ptr);
    void (*widget_destroy)(Ptr);
    void (*main)();
    void (*main_quit)();
    unsigned long (*signal_connect_data)(Ptr, const char*, Callback, Ptr, Ptr, int);
    unsigned (*idle_add)(int (*)(Ptr), Ptr);
    unsigned (*timeout_add)(unsigned, int (*)(Ptr), Ptr);
    void (*free)(Ptr);
    unsigned char* (*base64_decode)(const char*, size_t*);
    Ptr (*file_chooser_dialog_new)(const char*, Ptr, int, const char*, ...);
    void (*file_chooser_set_do_overwrite_confirmation)(Ptr, int);
    void (*file_chooser_set_current_name)(Ptr, const char*);
    char* (*file_chooser_get_filename)(Ptr);
    int (*dialog_run)(Ptr);
    Ptr (*ucm_new)();
    Ptr (*user_script_new)(const char*, int, int, const char* const*, const char* const*);
    void (*ucm_add_script)(Ptr, Ptr);
    int (*ucm_register_handler)(Ptr, const char*);
    Ptr (*web_view_new_with_ucm)(Ptr);
    void (*load_uri)(Ptr, const char*);
    const char* (*web_view_get_uri)(Ptr);
    void (*stop_loading)(Ptr);
    void (*drag_dest_unset)(Ptr);
    void (*run_javascript)(Ptr, const char*, Ptr, void (*)(Ptr, Ptr, Ptr), Ptr);
    Ptr (*run_javascript_finish)(Ptr, Ptr, Ptr*);
    Ptr (*js_result_get_value)(Ptr);
    void (*js_result_unref)(Ptr);
    char* (*jsc_to_string)(Ptr);
    int (*jsc_to_int32)(Ptr);
    Ptr (*nav_decision_get_action)(Ptr);
    Ptr (*nav_action_get_request)(Ptr);
    int (*nav_action_get_type)(Ptr);
    const char* (*request_get_uri)(Ptr);
    void (*decision_ignore)(Ptr);
} G;
bool loaded = false;

bool load() {
    if (loaded) return true;
    void* h = nullptr;
    for (const char* lib : {"libwebkit2gtk-4.1.so.0", "libwebkit2gtk-4.0.so.37"})
        if ((h = dlopen(lib, RTLD_NOW | RTLD_GLOBAL))) break;
    if (!h) return false;
    bool ok = true;
    const auto sym = [&](auto& f, const char* name) {
        f = reinterpret_cast<std::remove_reference_t<decltype(f)>>(dlsym(h, name));   // the library's dependencies are searched too
        ok = ok && f;
    };
    sym(G.init_check, "gtk_init_check");
    sym(G.set_prgname, "g_set_prgname");
    sym(G.window_new, "gtk_window_new");
    sym(G.window_set_title, "gtk_window_set_title");
    sym(G.window_set_default_size, "gtk_window_set_default_size");
    sym(G.window_set_icon_from_file, "gtk_window_set_icon_from_file");
    sym(G.container_add, "gtk_container_add");
    sym(G.widget_show_all, "gtk_widget_show_all");
    sym(G.widget_destroy, "gtk_widget_destroy");
    sym(G.main, "gtk_main");
    sym(G.main_quit, "gtk_main_quit");
    sym(G.signal_connect_data, "g_signal_connect_data");
    sym(G.idle_add, "g_idle_add");
    sym(G.timeout_add, "g_timeout_add");
    sym(G.free, "g_free");
    sym(G.base64_decode, "g_base64_decode");
    sym(G.file_chooser_dialog_new, "gtk_file_chooser_dialog_new");
    sym(G.file_chooser_set_do_overwrite_confirmation, "gtk_file_chooser_set_do_overwrite_confirmation");
    sym(G.file_chooser_set_current_name, "gtk_file_chooser_set_current_name");
    sym(G.file_chooser_get_filename, "gtk_file_chooser_get_filename");
    sym(G.dialog_run, "gtk_dialog_run");
    sym(G.ucm_new, "webkit_user_content_manager_new");
    sym(G.user_script_new, "webkit_user_script_new");
    sym(G.ucm_add_script, "webkit_user_content_manager_add_script");
    sym(G.ucm_register_handler, "webkit_user_content_manager_register_script_message_handler");
    sym(G.web_view_new_with_ucm, "webkit_web_view_new_with_user_content_manager");
    sym(G.load_uri, "webkit_web_view_load_uri");
    sym(G.web_view_get_uri, "webkit_web_view_get_uri");
    sym(G.stop_loading, "webkit_web_view_stop_loading");
    sym(G.drag_dest_unset, "gtk_drag_dest_unset");
    sym(G.run_javascript, "webkit_web_view_run_javascript");
    sym(G.run_javascript_finish, "webkit_web_view_run_javascript_finish");
    sym(G.js_result_get_value, "webkit_javascript_result_get_js_value");
    sym(G.js_result_unref, "webkit_javascript_result_unref");
    sym(G.jsc_to_string, "jsc_value_to_string");
    sym(G.jsc_to_int32, "jsc_value_to_int32");
    sym(G.nav_decision_get_action, "webkit_navigation_policy_decision_get_navigation_action");
    sym(G.nav_action_get_request, "webkit_navigation_action_get_request");
    sym(G.nav_action_get_type, "webkit_navigation_action_get_navigation_type");
    sym(G.request_get_uri, "webkit_uri_request_get_uri");
    sym(G.decision_ignore, "webkit_policy_decision_ignore");
    return loaded = ok;
}
template <class F>
void connect(Ptr obj, const char* signal, F handler) { G.signal_connect_data(obj, signal, reinterpret_cast<Callback>(handler), nullptr, nullptr, 0); }

struct Shell {
    Ptr window = nullptr, web = nullptr;
    std::string origin;   // http://127.0.0.1:<port>
    std::string home;     // the interface's address, origin + "/"
    std::string diverted; // the address the current main-frame load was sent to the browser for
    std::string token;    // the session key: only the interface's own document has it
    bool quitting = false, answered = false, done = false;
    unsigned round = 0;   // a cancelled quit must not be finished by its own timer
} shell;

bool is_home(const std::string& uri) { return uri.rfind(shell.origin + "/", 0) == 0 || uri == shell.origin; }
// Links to other sites open in the default browser
void open_external(const std::string& uri) {
    if (uri.rfind("http://", 0) == 0 || uri.rfind("https://", 0) == 0 || uri.rfind("mailto:", 0) == 0) spawn_program({"xdg-open", uri}, false);
}
void run_script(const std::string& js) { if (shell.web) G.run_javascript(shell.web, js.c_str(), nullptr, nullptr, nullptr); }
void reply(const std::string& id, const json::Value& v) { run_script("SoloptimaNative.reply(" + id + "," + v.dump() + ")"); }

void finish_quit() {
    if (shell.done) return;
    shell.done = true;
    G.main_quit();
}
// A file from the page (base64) to a place the user picks
void save(const std::string& id, const std::string& name, const std::string& data) {
    Ptr dlg = G.file_chooser_dialog_new("Save", shell.window, 1 /* SAVE */, "_Cancel", -6 /* CANCEL */, "_Save", -3 /* ACCEPT */, nullptr);
    G.file_chooser_set_do_overwrite_confirmation(dlg, 1);
    G.file_chooser_set_current_name(dlg, name.substr(name.find_last_of('/') + 1).c_str());
    json::Value out(json::Object{{"cancelled", true}});
    if (G.dialog_run(dlg) == -3) {
        char* path = G.file_chooser_get_filename(dlg);
        if (path) {
            size_t n = 0;
            unsigned char* bytes = G.base64_decode(data.c_str(), &n);
            std::ofstream f(path, std::ios::binary | std::ios::trunc);
            f.write(reinterpret_cast<const char*>(bytes), std::streamsize(n));
            f.close();
            out = f ? json::Value(json::Object{{"path", std::string(path)}}) : json::Value(json::Object{{"error", "The file could not be saved."}});
            G.free(bytes);
            G.free(path);
        }
    }
    G.widget_destroy(dlg);
    reply(id, out);
}

// A message counts only when it comes from the interface itself: it carries the session key (which only the interface's
// top document receives) and the window still shows the interface. A frame inside it, or a page dropped onto the window,
// gets neither.
bool from_interface(const json::Value& m) {
    const char* u = G.web_view_get_uri(shell.web);
    const std::string k = m.gets("key", "");
    if (!u || !is_home(u) || shell.token.empty() || k.size() != shell.token.size()) return false;
    unsigned char d = 0;
    for (size_t i = 0; i < k.size(); ++i) d |= static_cast<unsigned char>(k[i] ^ shell.token[i]);
    return d == 0;
}

void on_message(Ptr, Ptr result, Ptr) {
    char* s = G.jsc_to_string(G.js_result_get_value(result));
    json::Value m;
    try { m = json::parse(s ? s : ""); } catch (...) { G.free(s); return; }
    G.free(s);
    if (!from_interface(m)) return;
    const std::string cmd = m.gets("cmd", ""), id = m.has("id") ? std::to_string((long long)m.get("id", 0)) : "null";
    if (cmd == "quit-ready") finish_quit();
    else if (cmd == "quit-cancel") { ++shell.round; shell.quitting = false; }   // the user kept the window open
    else if (cmd == "open") open_external(m.gets("url", ""));
    else if (cmd == "save") save(id, m.gets("name", "Soloptima export"), m.gets("data", ""));
}

// The interface stays in the window: a link the user follows to another site, and any new window, opens in the browser
int on_decide_policy(Ptr, Ptr decision, int type, Ptr) {
    if (type != 0 && type != 1) return 0;   // navigation and new-window decisions only
    Ptr action = G.nav_decision_get_action(decision);
    const char* uri = G.request_get_uri(G.nav_action_get_request(action));
    const std::string u = uri ? uri : "";
    if (type == 1 || (G.nav_action_get_type(action) == 0 /* link clicked */ && !is_home(u))) {
        open_external(u);
        G.decision_ignore(decision);
        return 1;
    }
    return 0;
}

// The main frame never leaves the interface, whatever starts the load (link, script, form, redirect): other http, https
// and mailto addresses open in the browser instead. load-changed reports main-frame loads only. A load is stopped when it
// starts; one whose address is not known yet at that point is replaced by the interface when it commits.
void on_load_changed(Ptr web, int event, Ptr) {
    if (event == 0 /* WEBKIT_LOAD_STARTED */) shell.diverted.clear();   // a new load: its address may be opened again
    if (event == 3 /* WEBKIT_LOAD_FINISHED */) return;
    const char* uri = G.web_view_get_uri(web);
    const std::string u = uri ? uri : "";
    if (u.empty() || is_home(u)) return;
    if (u != shell.diverted) open_external(u);
    shell.diverted = u;
    if (event == 2 /* WEBKIT_LOAD_COMMITTED */) G.load_uri(web, shell.home.c_str());
    else G.stop_loading(web);
}

// Closing asks the page to save first (the protocol is in app.hpp)
struct Wait { unsigned round; bool saving; };   // saving: the page answered and is saving (or asking the user)
int quit_timeout(Ptr p) {
    const Wait* w = static_cast<Wait*>(p);
    if (w->round == shell.round && (w->saving || !shell.answered)) finish_quit();
    delete w;
    return 0;
}
void on_quit_answer(Ptr web, Ptr result, Ptr data) {
    const unsigned round = unsigned(reinterpret_cast<uintptr_t>(data));
    Ptr js = G.run_javascript_finish(web, result, nullptr);
    const bool page = js && G.jsc_to_int32(G.js_result_get_value(js)) == 1;
    if (js) G.js_result_unref(js);
    if (round != shell.round) return;
    if (!page) { finish_quit(); return; }
    shell.answered = true;
    G.timeout_add(QUIT_SAVE_MS, quit_timeout, new Wait{round, true});
}
int on_delete(Ptr, Ptr, Ptr) {
    if (!shell.quitting) {
        shell.quitting = true;
        shell.answered = false;
        ++shell.round;
        G.run_javascript(shell.web, QUIT_REQUEST_JS, nullptr, on_quit_answer, reinterpret_cast<Ptr>(uintptr_t(shell.round)));
        G.timeout_add(QUIT_ANSWER_MS, quit_timeout, new Wait{shell.round, false});
    }
    return 1;   // the window stays until the page has saved
}
int idle_quit(Ptr) { finish_quit(); return 0; }

} // namespace

bool app_window_available() {
    static const bool ok = [] {
        if (!load()) return false;
        G.set_prgname("soloptima");   // matches StartupWMClass in soloptima.desktop
        return G.init_check(nullptr, nullptr) != 0;   // false without a display
    }();
    return ok;
}

bool app_claim_single_instance(int port) {
    if (!soloptima_running(port)) return true;
    std::fprintf(stderr, "Soloptima is already running.\n");   // the running one already has the window
    return false;
}

int run_app_window(const AppWindow& w) {
    if (!app_window_available()) return -1;
    shell.origin = w.origin();
    shell.home = w.url;
    shell.token = w.token;
    shell.window = G.window_new(0 /* toplevel */);
    G.window_set_title(shell.window, "Soloptima");
    G.window_set_default_size(shell.window, 1400, 900);
    if (!w.icon.empty()) G.window_set_icon_from_file(shell.window, w.icon.c_str(), nullptr);
    Ptr ucm = G.ucm_new();
    const std::string boot = w.boot_script("linux");
    G.ucm_add_script(ucm, G.user_script_new(boot.c_str(), 1 /* top frame */, 0 /* document start */, nullptr, nullptr));
    G.ucm_register_handler(ucm, "soloptima");
    connect(ucm, "script-message-received::soloptima", on_message);
    shell.web = G.web_view_new_with_ucm(ucm);
    G.drag_dest_unset(shell.web);   // the interface takes no drops: a dropped link or file would load in its place
    connect(shell.web, "decide-policy", on_decide_policy);
    connect(shell.web, "load-changed", on_load_changed);
    connect(shell.window, "delete-event", on_delete);
    G.container_add(shell.window, shell.web);
    G.load_uri(shell.web, w.url.c_str());
    G.widget_show_all(shell.window);
    G.main();
    return 0;
}

void app_quit() {
    if (loaded && shell.window) G.idle_add(idle_quit, nullptr);   // from any thread: GTK runs it on its own
}
#endif
