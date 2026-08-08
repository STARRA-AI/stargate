// STARGATE — native macOS app (WKWebView) wrapping the local deck.
// Its own window + dock icon; starts the deck server if needed, then loads it
// live. Uses the system WebKit (no Electron). Grants mic/camera to the web view
// so the voice call + eye-cam work.
import Cocoa
import WebKit

let DECK_URL = URL(string: "https://127.0.0.1:3000/")!

final class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var webView: WKWebView!
    var loading: NSTextField!

    func applicationDidFinishLaunching(_ note: Notification) {
        startServerIfNeeded()
        buildWindow()
        waitForServerThenLoad()
    }

    // Start the Next dev server via the project's launcher if it's not already up.
    func startServerIfNeeded() {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = ["-lc",
            "curl -skf --max-time 2 https://127.0.0.1:3000/ >/dev/null 2>&1 || " +
            "\"$HOME/STARGATE/stargate/scripts/starra\" up >/dev/null 2>&1 &"]
        try? p.run()
    }

    func buildWindow() {
        let cfg = WKWebViewConfiguration()
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.allowsAirPlayForMediaPlayback = true

        // Capture any client-side error/exception from the deck to a log file so
        // it's never invisible (WKWebView has no console for Classic to read).
        let ucc = WKUserContentController()
        ucc.add(self, name: "starraErr")
        let capture = """
        (function(){
          function send(t){ try{ window.webkit.messageHandlers.starraErr.postMessage(String(t)); }catch(e){} }
          window.addEventListener('error', function(e){ send('ERROR: '+(e.message||'')+' @ '+(e.filename||'')+':'+(e.lineno||'')+'\\n'+((e.error&&e.error.stack)||'')); }, true);
          window.addEventListener('unhandledrejection', function(e){ var r=e.reason||{}; send('REJECTION: '+((r.stack||r.message)||r)); });
          var oe = console.error.bind(console); console.error = function(){ try{ send('CONSOLE.ERROR: '+Array.prototype.join.call(arguments,' ')); }catch(_){} oe.apply(null, arguments); };
        })();
        """
        ucc.addUserScript(WKUserScript(source: capture, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        cfg.userContentController = ucc

        let rect = NSRect(x: 0, y: 0, width: 1320, height: 880)
        webView = WKWebView(frame: rect, configuration: cfg)
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground") // let the deck's dark bg show

        window = NSWindow(contentRect: rect,
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.title = "STARGATE"
        window.titlebarAppearsTransparent = true
        window.backgroundColor = .black
        window.center()
        window.setFrameAutosaveName("StargateMain")

        // a small "waking STARGATE…" label until the deck loads
        loading = NSTextField(labelWithString: "waking STARGATE…")
        loading.textColor = NSColor(calibratedRed: 0.8, green: 0.6, blue: 1.0, alpha: 1)
        loading.font = NSFont.systemFont(ofSize: 15, weight: .medium)
        loading.alignment = .center
        let container = NSView(frame: rect)
        container.wantsLayer = true
        container.layer?.backgroundColor = NSColor.black.cgColor
        webView.frame = container.bounds
        webView.autoresizingMask = [.width, .height]
        loading.frame = NSRect(x: 0, y: rect.height/2 - 12, width: rect.width, height: 24)
        loading.autoresizingMask = [.width, .minYMargin, .maxYMargin]
        container.addSubview(webView)
        container.addSubview(loading)
        window.contentView = container
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func waitForServerThenLoad() {
        DispatchQueue.global(qos: .userInitiated).async {
            for _ in 0..<90 {
                if self.serverUp() { break }
                Thread.sleep(forTimeInterval: 1)
            }
            DispatchQueue.main.async { self.clearCachesThenLoad() }
        }
    }

    // Wipe stale web caches + any old service worker on every launch (keep
    // cookies so login persists) — this is what prevents the "stale chunk ->
    // client-side exception" crash after a deck rebuild.
    func clearCachesThenLoad() {
        var types: Set<String> = [
            WKWebsiteDataTypeDiskCache,
            WKWebsiteDataTypeMemoryCache,
            WKWebsiteDataTypeFetchCache,
            WKWebsiteDataTypeServiceWorkerRegistrations,
        ]
        types.insert(WKWebsiteDataTypeOfflineWebApplicationCache)
        WKWebsiteDataStore.default().removeData(
            ofTypes: types, modifiedSince: Date(timeIntervalSince1970: 0)
        ) {
            self.webView.load(URLRequest(url: DECK_URL))
        }
    }

    func serverUp() -> Bool {
        var ok = false
        let sem = DispatchSemaphore(value: 0)
        var req = URLRequest(url: DECK_URL)
        req.timeoutInterval = 3
        req.httpMethod = "GET"
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            if let h = resp as? HTTPURLResponse, h.statusCode > 0 { ok = true }
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 4)
        return ok
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loading.isHidden = true
    }

    // Grant mic/camera to the deck's voice call + eye-cam (macOS 12+).
    @available(macOS 12.0, *)
    func webView(_ webView: WKWebView,
                 requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.grant)
    }

    // Write captured web errors to ~/stargate_webview_errors.log for Claude to read.
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "starraErr" else { return }
        let line = "[\(Date())] \(message.body)\n"
        let path = (NSHomeDirectory() as NSString).appendingPathComponent("stargate_webview_errors.log")
        guard let data = line.data(using: .utf8) else { return }
        if let fh = FileHandle(forWritingAtPath: path) {
            fh.seekToEndOfFile(); fh.write(data); try? fh.close()
        } else {
            try? data.write(to: URL(fileURLWithPath: path))
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
