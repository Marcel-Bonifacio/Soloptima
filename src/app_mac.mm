// macOS desktop window: a WKWebView showing the interface the engine serves on 127.0.0.1. The page reaches the native
// side through window.webkit.messageHandlers.soloptima (see Native in web/js/util.js): saving files, printing the report,
// opening links in the default browser, and quitting once it has saved its work.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#include "app.hpp"
#include <cstdlib>
#include <unistd.h>

@interface SoloptimaApp : NSObject <NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler>
@property(strong) NSWindow* window;
@property(strong) WKWebView* web;
@property(strong) NSURL* home;
@property(copy) NSString* bootScript;
@property(copy) NSString* iconPath;
@property(strong) WKWebView* printView;   // the report being printed
@property(strong) id printReply;
@property BOOL quitting, finished, terminating, quitAnswered;
@property NSUInteger quitRound;   // a cancelled quit must not be finished by its own timer
@end

static SoloptimaApp* gApp = nil;

@implementation SoloptimaApp

// Window and menus

- (void)applicationDidFinishLaunching:(NSNotification*)n {
    [self buildMenu];
    // run from the source folder there is no app bundle, so no bundle icon: give the Dock the app icon all the same
    if (!NSBundle.mainBundle.bundleIdentifier) {
        NSImage* icon = [[NSImage alloc] initWithContentsOfFile:self.iconPath];
        if (icon) NSApp.applicationIconImage = icon;
    }
    WKWebViewConfiguration* cfg = [WKWebViewConfiguration new];
    WKUserContentController* ucc = cfg.userContentController;
    [ucc addScriptMessageHandler:self name:@"soloptima"];
    [ucc addUserScript:[[WKUserScript alloc] initWithSource:self.bootScript injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                           forMainFrameOnly:YES]];
    if (std::getenv("SOLOPTIMA_DEVTOOLS")) [cfg.preferences setValue:@YES forKey:@"developerExtrasEnabled"];

    const NSRect screen = NSScreen.mainScreen.visibleFrame;
    const NSRect frame = NSMakeRect(0, 0, MIN(1440, screen.size.width - 40), MIN(920, screen.size.height - 40));
    self.window = [[NSWindow alloc] initWithContentRect:frame
                                              styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable |
                                                        NSWindowStyleMaskResizable
                                                backing:NSBackingStoreBuffered defer:NO];
    self.window.title = @"Soloptima";
    self.window.minSize = NSMakeSize(960, 620);
    self.window.delegate = self;
    self.window.releasedWhenClosed = NO;
    [self.window center];
    [self.window setFrameAutosaveName:@"SoloptimaMain"];   // the window comes back where it was left

    self.web = [[WKWebView alloc] initWithFrame:self.window.contentView.bounds configuration:cfg];
    self.web.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    self.web.navigationDelegate = self;
    self.web.UIDelegate = self;
    self.web.allowsMagnification = YES;
    if (@available(macOS 13.3, *)) self.web.inspectable = std::getenv("SOLOPTIMA_DEVTOOLS") != nullptr;
    [self.window.contentView addSubview:self.web];
    [self.web loadRequest:[NSURLRequest requestWithURL:self.home]];
    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
}

- (NSMenuItem*)item:(NSString*)title action:(SEL)action key:(NSString*)key {
    return [[NSMenuItem alloc] initWithTitle:title action:action keyEquivalent:key];
}
- (void)buildMenu {
    NSMenu* bar = [NSMenu new];
    NSMenu* app = [[NSMenu alloc] initWithTitle:@"Soloptima"];
    [app addItem:[self item:@"About Soloptima" action:@selector(orderFrontStandardAboutPanel:) key:@""]];
    NSMenuItem* upd = [self item:@"Check for Updates…" action:@selector(checkUpdates:) key:@""];
    upd.target = self;
    [app addItem:upd];
    [app addItem:[NSMenuItem separatorItem]];
    [app addItem:[self item:@"Hide Soloptima" action:@selector(hide:) key:@"h"]];
    NSMenuItem* others = [self item:@"Hide Others" action:@selector(hideOtherApplications:) key:@"h"];
    others.keyEquivalentModifierMask = NSEventModifierFlagCommand | NSEventModifierFlagOption;
    [app addItem:others];
    [app addItem:[self item:@"Show All" action:@selector(unhideAllApplications:) key:@""]];
    [app addItem:[NSMenuItem separatorItem]];
    [app addItem:[self item:@"Quit Soloptima" action:@selector(terminate:) key:@"q"]];

    NSMenu* edit = [[NSMenu alloc] initWithTitle:@"Edit"];   // the web view handles these when it has focus
    [edit addItem:[self item:@"Undo" action:@selector(undo:) key:@"z"]];
    NSMenuItem* redo = [self item:@"Redo" action:@selector(redo:) key:@"z"];
    redo.keyEquivalentModifierMask = NSEventModifierFlagCommand | NSEventModifierFlagShift;
    [edit addItem:redo];
    [edit addItem:[NSMenuItem separatorItem]];
    [edit addItem:[self item:@"Cut" action:@selector(cut:) key:@"x"]];
    [edit addItem:[self item:@"Copy" action:@selector(copy:) key:@"c"]];
    [edit addItem:[self item:@"Paste" action:@selector(paste:) key:@"v"]];
    [edit addItem:[self item:@"Select All" action:@selector(selectAll:) key:@"a"]];

    NSMenu* view = [[NSMenu alloc] initWithTitle:@"View"];
    for (NSArray* z in @[@[@"Actual Size", @"0", @"zoomReset:"], @[@"Zoom In", @"=", @"zoomIn:"], @[@"Zoom Out", @"-", @"zoomOut:"]]) {
        NSMenuItem* i = [self item:z[0] action:NSSelectorFromString(z[2]) key:z[1]];
        i.target = self;
        [view addItem:i];
    }
    [view addItem:[NSMenuItem separatorItem]];
    NSMenuItem* reload = [self item:@"Reload" action:@selector(reloadPage:) key:@"r"];
    reload.target = self;
    [view addItem:reload];

    NSMenu* win = [[NSMenu alloc] initWithTitle:@"Window"];
    [win addItem:[self item:@"Minimize" action:@selector(performMiniaturize:) key:@"m"]];
    [win addItem:[self item:@"Zoom" action:@selector(performZoom:) key:@""]];
    [win addItem:[self item:@"Close" action:@selector(performClose:) key:@"w"]];

    for (NSMenu* m in @[app, edit, view, win]) {
        NSMenuItem* top = [NSMenuItem new];
        top.submenu = m;
        [bar addItem:top];
    }
    NSApp.mainMenu = bar;
    NSApp.windowsMenu = win;
}
- (void)checkUpdates:(id)sender { [self.web evaluateJavaScript:@"window.Update && Update.check(true)" completionHandler:nil]; }
- (void)reloadPage:(id)sender {   // save first: the page does not get the chance to while it unloads
    [self.web evaluateJavaScript:@"(window.Home ? Home.flush() : Promise.resolve()).finally(() => location.reload()), 1" completionHandler:nil];
}
- (void)zoomReset:(id)sender { if (@available(macOS 11.0, *)) self.web.pageZoom = 1.0; }
- (void)zoomIn:(id)sender { if (@available(macOS 11.0, *)) self.web.pageZoom = MIN(self.web.pageZoom + 0.1, 2.0); }
- (void)zoomOut:(id)sender { if (@available(macOS 11.0, *)) self.web.pageZoom = MAX(self.web.pageZoom - 0.1, 0.5); }

// Quitting: the page saves first (closing the window or Quit; the protocol is in app.hpp)

- (void)beginQuit {
    if (self.quitting) return;
    self.quitting = YES;
    self.quitAnswered = NO;
    const NSUInteger round = ++self.quitRound;
    [self.web evaluateJavaScript:@(QUIT_REQUEST_JS) completionHandler:^(id r, NSError* e) {
        if (round != self.quitRound) return;
        if (e || ![r boolValue]) { [self finishQuit]; return; }
        self.quitAnswered = YES;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, int64_t(QUIT_SAVE_MS) * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
            if (round == self.quitRound) [self finishQuit];
        });
    }];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, int64_t(QUIT_ANSWER_MS) * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
        if (round == self.quitRound && !self.quitAnswered) [self finishQuit];
    });
}
- (void)cancelQuit {
    ++self.quitRound;
    self.quitting = NO;
    if (self.terminating) { self.terminating = NO; [NSApp replyToApplicationShouldTerminate:NO]; }
}
- (void)finishQuit {
    if (self.finished) return;
    self.finished = YES;
    if (self.terminating) { [NSApp replyToApplicationShouldTerminate:YES]; return; }   // Quit, log out, shut down
    [NSApp stop:nil];   // the window was closed: run_app_window returns and the engine ends the process
    [NSApp postEvent:[NSEvent otherEventWithType:NSEventTypeApplicationDefined location:NSZeroPoint modifierFlags:0 timestamp:0
                                    windowNumber:0 context:nil subtype:0 data1:0 data2:0]
             atStart:YES];
}
- (BOOL)windowShouldClose:(NSWindow*)w { [self beginQuit]; return NO; }
- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication*)a {
    if (self.finished) return NSTerminateNow;
    self.terminating = YES;
    [self beginQuit];
    return NSTerminateLater;
}
// End here, without running static destructors while the engine's request threads may still be about
- (void)applicationWillTerminate:(NSNotification*)n {
    std::fflush(nullptr);
    std::_Exit(0);
}
- (BOOL)applicationSupportsSecureRestorableState:(NSApplication*)a { return YES; }

// Messages from the page

- (void)reply:(id)rid value:(id)value {
    NSData* d = [NSJSONSerialization dataWithJSONObject:@[rid ?: [NSNull null], value ?: [NSNull null]] options:0 error:nil];
    NSString* args = [[NSString alloc] initWithData:d encoding:NSUTF8StringEncoding];
    args = [args substringWithRange:NSMakeRange(1, args.length - 2)];   // "[id,value]" -> "id,value"
    [self.web evaluateJavaScript:[NSString stringWithFormat:@"SoloptimaNative.reply(%@)", args] completionHandler:nil];
}
- (BOOL)isHome:(NSURL*)u {
    return [u.scheme isEqualToString:self.home.scheme] && [u.host isEqualToString:self.home.host] && [u.port isEqual:self.home.port];
}
- (void)openExternal:(NSURL*)u {
    NSString* s = u.scheme.lowercaseString;
    if ([s isEqualToString:@"http"] || [s isEqualToString:@"https"] || [s isEqualToString:@"mailto"]) [[NSWorkspace sharedWorkspace] openURL:u];
}
- (void)userContentController:(WKUserContentController*)c didReceiveScriptMessage:(WKScriptMessage*)m {
    // only the interface itself, never a frame inside it
    if (!m.frameInfo.isMainFrame || ![self isHome:m.frameInfo.request.URL] || ![m.body isKindOfClass:NSString.class]) return;
    NSDictionary* msg = [NSJSONSerialization JSONObjectWithData:[m.body dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
    if (![msg isKindOfClass:NSDictionary.class]) return;
    NSString* cmd = msg[@"cmd"];
    id rid = msg[@"id"];
    if ([cmd isEqualToString:@"quit-ready"]) [self finishQuit];
    else if ([cmd isEqualToString:@"quit-cancel"]) [self cancelQuit];
    else if ([cmd isEqualToString:@"open"] && [msg[@"url"] isKindOfClass:NSString.class]) [self openExternal:[NSURL URLWithString:msg[@"url"]]];
    else if ([cmd isEqualToString:@"save"]) [self save:msg reply:rid];
    else if ([cmd isEqualToString:@"print"] && [msg[@"html"] isKindOfClass:NSString.class]) [self print:msg[@"html"] reply:rid];
}

// A file from the page (base64) to a place the user picks
- (void)save:(NSDictionary*)msg reply:(id)rid {
    NSString* name = [msg[@"name"] isKindOfClass:NSString.class] ? [msg[@"name"] lastPathComponent] : @"Soloptima export";
    NSData* data = [msg[@"data"] isKindOfClass:NSString.class] ? [[NSData alloc] initWithBase64EncodedString:msg[@"data"] options:0] : nil;
    if (!data) { [self reply:rid value:@{@"error" : @"The file could not be prepared."}]; return; }
    NSSavePanel* p = [NSSavePanel savePanel];
    p.nameFieldStringValue = name;
    p.canCreateDirectories = YES;
    [p beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse r) {
        if (r != NSModalResponseOK) { [self reply:rid value:@{@"cancelled" : @YES}]; return; }
        NSError* err = nil;
        if ([data writeToURL:p.URL options:NSDataWritingAtomic error:&err]) [self reply:rid value:@{@"path" : p.URL.path}];
        else [self reply:rid value:@{@"error" : err.localizedDescription ?: @"The file could not be saved."}];
    }];
}

// The report goes to a separate view without scripts, which the system print panel prints (or saves as PDF).
// SOLOPTIMA_PRINT_TO=<file.pdf> writes the PDF there without the panel (for tests).
- (void)print:(NSString*)html reply:(id)rid {
    if (self.printView) { [self reply:rid value:@{@"ok" : @NO, @"busy" : @YES}]; return; }   // one report at a time
    WKWebViewConfiguration* cfg = [WKWebViewConfiguration new];
    if (@available(macOS 11.0, *)) cfg.defaultWebpagePreferences.allowsContentJavaScript = NO;
    WKWebView* v = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 794, 1123) configuration:cfg];
    v.navigationDelegate = self;
    v.hidden = YES;
    [self.window.contentView addSubview:v positioned:NSWindowBelow relativeTo:self.web];   // printing needs a view in a window
    self.printView = v;
    self.printReply = rid;
    [v loadHTMLString:html baseURL:nil];
}
- (void)runPrint {
    NSPrintInfo* pi = [[NSPrintInfo sharedPrintInfo] copy];
    pi.topMargin = pi.bottomMargin = 36;
    pi.leftMargin = pi.rightMargin = 36;
    pi.verticallyCentered = NO;
    const char* to = std::getenv("SOLOPTIMA_PRINT_TO");
    if (to) {
        pi.jobDisposition = NSPrintSaveJob;
        pi.dictionary[NSPrintJobSavingURL] = [NSURL fileURLWithPath:@(to)];
    }
    if (@available(macOS 11.0, *)) {
        NSPrintOperation* op = [self.printView printOperationWithPrintInfo:pi];
        op.showsPrintPanel = to == nullptr;
        op.showsProgressPanel = to == nullptr;
        op.view.frame = NSMakeRect(0, 0, pi.paperSize.width, pi.paperSize.height);   // without a frame the pages come out blank
        [op runOperationModalForWindow:self.window delegate:self didRunSelector:@selector(printDone:success:context:) contextInfo:nil];
    }
}
- (void)printDone:(NSPrintOperation*)op success:(BOOL)ok context:(void*)ctx {
    [self reply:self.printReply value:@{@"ok" : @(ok)}];
    [self.printView removeFromSuperview];
    self.printView = nil;
}
- (void)printFailed {   // the report did not load: the page's print call still gets an answer
    [self printDone:nil success:NO context:nullptr];
}

// Navigation: the interface stays in the window

- (void)webView:(WKWebView*)w decidePolicyForNavigationAction:(WKNavigationAction*)a decisionHandler:(void (^)(WKNavigationActionPolicy))h {
    NSURL* u = a.request.URL;
    const BOOL main = a.targetFrame == nil || a.targetFrame.isMainFrame;
    if (w == self.web && main && ![self isHome:u] && ![u.scheme isEqualToString:@"about"] && ![u.scheme isEqualToString:@"blob"]) {
        [self openExternal:u];   // links to other sites open in the default browser
        h(WKNavigationActionPolicyCancel);
        return;
    }
    h(WKNavigationActionPolicyAllow);
}
- (void)webView:(WKWebView*)w didFinishNavigation:(WKNavigation*)nav {
    if (w == self.printView) [self runPrint];
}
- (void)webViewWebContentProcessDidTerminate:(WKWebView*)w {
    if (w == self.web) [w reload];
    else if (w == self.printView) [self printFailed];
}
- (void)webView:(WKWebView*)w didFailNavigation:(WKNavigation*)nav withError:(NSError*)e {
    if (w == self.printView) [self printFailed];
}
- (void)webView:(WKWebView*)w didFailProvisionalNavigation:(WKNavigation*)nav withError:(NSError*)e {
    if (w == self.printView) [self printFailed];
}
- (WKWebView*)webView:(WKWebView*)w createWebViewWithConfiguration:(WKWebViewConfiguration*)c forNavigationAction:(WKNavigationAction*)a
          windowFeatures:(WKWindowFeatures*)f {
    [self openExternal:a.request.URL];   // target="_blank" and window.open
    return nil;
}

// Alert, confirm, prompt and file choosers

- (void)webView:(WKWebView*)w runJavaScriptAlertPanelWithMessage:(NSString*)message initiatedByFrame:(WKFrameInfo*)f
    completionHandler:(void (^)(void))h {
    NSAlert* a = [NSAlert new];
    a.messageText = message;
    [a beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse) { h(); }];
}
- (void)webView:(WKWebView*)w runJavaScriptConfirmPanelWithMessage:(NSString*)message initiatedByFrame:(WKFrameInfo*)f
    completionHandler:(void (^)(BOOL))h {
    NSAlert* a = [NSAlert new];
    a.messageText = message;
    [a addButtonWithTitle:@"OK"];
    [a addButtonWithTitle:@"Cancel"];
    [a beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse r) { h(r == NSAlertFirstButtonReturn); }];
}
- (void)webView:(WKWebView*)w runJavaScriptTextInputPanelWithPrompt:(NSString*)prompt defaultText:(NSString*)text
    initiatedByFrame:(WKFrameInfo*)f completionHandler:(void (^)(NSString*))h {
    NSAlert* a = [NSAlert new];
    a.messageText = prompt;
    [a addButtonWithTitle:@"OK"];
    [a addButtonWithTitle:@"Cancel"];
    NSTextField* input = [[NSTextField alloc] initWithFrame:NSMakeRect(0, 0, 320, 24)];
    input.stringValue = text ?: @"";
    a.accessoryView = input;
    [a beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse r) { h(r == NSAlertFirstButtonReturn ? input.stringValue : nil); }];
}
- (void)webView:(WKWebView*)w runOpenPanelWithParameters:(WKOpenPanelParameters*)p initiatedByFrame:(WKFrameInfo*)f
    completionHandler:(void (^)(NSArray<NSURL*>*))h {
    NSOpenPanel* o = [NSOpenPanel openPanel];
    o.allowsMultipleSelection = p.allowsMultipleSelection;
    o.canChooseFiles = YES;
    o.canChooseDirectories = NO;
    [o beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse r) { h(r == NSModalResponseOK ? o.URLs : nil); }];
}
@end

bool app_window_available() { return true; }

bool app_claim_single_instance(int) {
    NSString* bid = NSBundle.mainBundle.bundleIdentifier;   // nil outside an app bundle (development runs)
    if (!bid) return true;
    for (NSRunningApplication* a in [NSRunningApplication runningApplicationsWithBundleIdentifier:bid])
        if (a.processIdentifier != getpid()) {
            [a activateWithOptions:NSApplicationActivateAllWindows];
            return false;
        }
    return true;
}

int run_app_window(const AppWindow& w) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        NSApp.activationPolicy = NSApplicationActivationPolicyRegular;
        gApp = [SoloptimaApp new];
        gApp.home = [NSURL URLWithString:@(w.url.c_str())];
        gApp.iconPath = @(w.icon.c_str());
        gApp.bootScript = @(w.boot_script("mac").c_str());
        NSApp.delegate = gApp;
        [NSApp run];
    }
    return 0;
}

void app_quit() {
    dispatch_async(dispatch_get_main_queue(), ^{ [gApp finishQuit]; });
}
