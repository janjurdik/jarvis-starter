// Jarvis HUD on the Mac desktop: the HUD (http://127.0.0.1:<port>) as a live wallpaper.
//
// The window sits at desktop level (below all windows, above the wallpaper) on every Space.
// When desktop icons are hidden (Finder CreateDesktop = false, opt-in from the menu), clicks and
// typing go straight to the HUD. The shortcut ⌃⌥J brings the HUD above all windows: hold = talk,
// tap = type. Esc sends it back to the desktop. Menu bar icon: reload, desktop icons on/off,
// launch at login, quit and restore the desktop.
// The app also starts the HUD server (node hud/server.mjs) when it is not running; the paths of
// node and of the Jarvis folder are written into Info.plist by desktop/build.sh.
// Build and install: desktop/build.sh. Log: ~/Library/Logs/jarvis-hud-desktop.log.

import Carbon.HIToolbox
import Cocoa
import WebKit

// MARK: - Konfigurácia

let HUD_PORT = (Bundle.main.object(forInfoDictionaryKey: "JarvisPort") as? String) ?? "4545"
let HUD_ORIGIN = ProcessInfo.processInfo.environment["JARVIS_HUD_ORIGIN"] ?? "http://127.0.0.1:\(HUD_PORT)"
/// Where the Jarvis folder and node live, baked in by build.sh so the app can start the server itself.
let JARVIS_REPO = (Bundle.main.object(forInfoDictionaryKey: "JarvisRepo") as? String) ?? ""
let NODE_PATH = (Bundle.main.object(forInfoDictionaryKey: "JarvisNode") as? String) ?? ""
let BUNDLE_ID = "com.jarvis-starter.hud"
let AGENT_LABEL = "com.jarvis-starter.hud-desktop"
let HOME = FileManager.default.homeDirectoryForCurrentUser
let CACHE_DIR = HOME.appendingPathComponent("Library/Caches/JarvisHUD", isDirectory: true)
let LOG_PATH = HOME.appendingPathComponent("Library/Logs/jarvis-hud-desktop.log").path
let SERVER_LOG_PATH = HOME.appendingPathComponent("Library/Logs/jarvis-hud-server.log").path
let AGENT_URL = HOME.appendingPathComponent("Library/LaunchAgents/\(AGENT_LABEL).plist")
let HOTKEY_LABEL = "⌃⌥J"

// MARK: - Pomocné funkcie

let logQueue = DispatchQueue(label: "jarvis.desktop.log")

func log(_ msg: String) {
  let stamp = ISO8601DateFormatter.string(from: Date(), timeZone: .current, formatOptions: [.withFullDate, .withFullTime])
  let line = "\(stamp) \(msg)\n"
  logQueue.async {
    guard let data = line.data(using: .utf8) else { return }
    if let h = FileHandle(forWritingAtPath: LOG_PATH) {
      h.seekToEndOfFile()
      h.write(data)
      try? h.close()
    } else {
      FileManager.default.createFile(atPath: LOG_PATH, contents: data)
    }
  }
}

/// Spustí krátky príkaz a vráti kód a výstup (defaults, killall).
@discardableResult
func run(_ exe: String, _ args: [String]) -> (code: Int32, out: String) {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: exe)
  p.arguments = args
  let pipe = Pipe()
  p.standardOutput = pipe
  p.standardError = pipe
  do {
    try p.run()
  } catch {
    return (-1, String(describing: error))
  }
  let data = pipe.fileHandleForReading.readDataToEndOfFile()
  p.waitUntilExit()
  return (p.terminationStatus, String(data: data, encoding: .utf8) ?? "")
}

/// Okno bez rámu, ktoré aj tak môže prijímať klávesnicu (písanie Jarvisovi, medzerník).
final class HUDWindow: NSWindow {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { true }
}

/// Prvý klik na plochu hneď funguje (klik na uzol, scroll panela), nielen aktivuje appku.
final class HUDWebView: WKWebView {
  /// Called when a drag carrying files enters the view, with where those files are.
  var onDragFiles: (([URL]) -> Void)?

  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  /// Files dragged from Finder. The drop itself stays WebKit's own (the page gets its usual drop
  /// event with the files); this only lets the page know the paths before it happens.
  override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
    let found = sender.draggingPasteboard.readObjects(
      forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true])
    if let urls = found as? [URL], !urls.isEmpty { onDragFiles?(urls) }
    return super.draggingEntered(sender)
  }
}

// MARK: - Appka

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate,
  WKScriptMessageHandler, NSMenuDelegate
{
  var window: HUDWindow!
  var web: HUDWebView!
  var statusLabel: NSTextField!
  var statusItem: NSStatusItem!
  let control = ControlOverlay()
  var hotKeyRef: EventHotKeyRef?
  var signalSource: DispatchSourceSignal?

  var raised = false
  var previousApp: NSRunningApplication?
  var lastInsets = NSEdgeInsetsZero
  var serverOK = false
  var serverFails = 0
  var lastStartRequest = Date.distantPast
  var serverProcess: Process?
  var pageLoaded = false
  var loading = false
  var ticks = 0
  var lastDailyReload = ""

  let defaults = UserDefaults.standard

  /// Úroveň okna: tesne nad tapetou, pod ikonami plochy a všetkými oknami.
  var desktopLevel: NSWindow.Level {
    NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) + 1)
  }

  var screen: NSScreen { NSScreen.screens.first ?? NSScreen.main! }

  func applicationDidFinishLaunching(_ notification: Notification) {
    let me = ProcessInfo.processInfo.processIdentifier
    let others = NSRunningApplication.runningApplications(withBundleIdentifier: BUNDLE_ID)
      .filter { $0.processIdentifier != me }
    if !others.isEmpty {
      log("Jarvis HUD už beží (pid \(others[0].processIdentifier)), druhá inštancia končí")
      exit(0)
    }
    NSApp.setActivationPolicy(.accessory)
    // Both are opt-in from the menu: the app never changes Finder or login items on its own.
    defaults.register(defaults: ["hideDesktopIcons": false, "launchAtLogin": false])
    try? FileManager.default.createDirectory(at: CACHE_DIR, withIntermediateDirectories: true)
    log("štart, \(Bundle.main.bundlePath)")

    buildWindow()
    buildStatusItem()
    registerHotKey()
    observe()
    installSignals()

    if defaults.bool(forKey: "hideDesktopIcons") && desktopIconsVisible() {
      setDesktopIcons(visible: false)
    }
    if defaults.bool(forKey: "launchAtLogin") && !loginItemEnabled() {
      setLoginItem(true)
    }

    checkServer()
    load()
    Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.tick() }
    }
  }

  // MARK: Okno a web

  func buildWindow() {
    let frame = screen.frame
    window = HUDWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
    window.setFrame(frame, display: false)
    window.level = desktopLevel
    window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenNone]
    window.backgroundColor = NSColor(red: 0.016, green: 0.027, blue: 0.039, alpha: 1)
    window.isOpaque = true
    window.hasShadow = false
    window.isMovable = false
    window.isReleasedWhenClosed = false
    window.acceptsMouseMovedEvents = true
    window.title = "Jarvis HUD"

    let root = NSView(frame: NSRect(origin: .zero, size: frame.size))
    root.autoresizingMask = [.width, .height]

    statusLabel = NSTextField(labelWithString: "Jarvis štartuje…")
    statusLabel.font = NSFont.systemFont(ofSize: 22, weight: .light)
    statusLabel.textColor = NSColor(red: 0.5, green: 0.95, blue: 1, alpha: 0.8)
    statusLabel.alignment = .center
    statusLabel.frame = NSRect(x: 0, y: frame.height / 2 - 20, width: frame.width, height: 40)
    statusLabel.autoresizingMask = [.width, .minYMargin, .maxYMargin]
    root.addSubview(statusLabel)

    let cfg = WKWebViewConfiguration()
    cfg.mediaTypesRequiringUserActionForPlayback = []
    cfg.websiteDataStore = .default()
    // The web inspector only for people who ask for it (JARVIS_HUD_INSPECT=1): it is a door into the page.
    let inspect = ProcessInfo.processInfo.environment["JARVIS_HUD_INSPECT"] == "1"
    cfg.preferences.setValue(inspect, forKey: "developerExtrasEnabled")
    let ucc = WKUserContentController()
    ucc.add(self, name: "jarvis")
    ucc.addUserScript(
      WKUserScript(source: bootstrapJS(), injectionTime: .atDocumentStart, forMainFrameOnly: true))
    cfg.userContentController = ucc

    web = HUDWebView(frame: root.bounds, configuration: cfg)
    web.autoresizingMask = [.width, .height]
    web.navigationDelegate = self
    web.uiDelegate = self
    web.underPageBackgroundColor = window.backgroundColor
    web.isInspectable = inspect
    web.alphaValue = 0
    web.onDragFiles = { [weak self] urls in self?.dragFiles(urls) }
    root.addSubview(web)

    window.contentView = root
    window.orderFront(nil)
    writeWindowInfo()
  }

  /// Most medzi appkou a stránkou: window.__jarvisDesktop (okraje lišty a Docku, skratka, vyvolanie).
  func bootstrapJS() -> String {
    """
    (() => {
      const d = (window.__jarvisDesktop = window.__jarvisDesktop || {});
      d.native = true;
      d.version = 1;
      d.isRaised = false;
      d.hotkeyLabel = '\(HOTKEY_LABEL)';
      d.post = (msg) => { try { window.webkit.messageHandlers.jarvis.postMessage(msg) } catch (e) {} };
      const emit = (detail) => window.dispatchEvent(new CustomEvent('jarvis-desktop', { detail }));
      d.setInsets = (ins) => {
        d.insets = ins;
        const s = document.documentElement.style;
        for (const k of ['top', 'right', 'bottom', 'left']) s.setProperty('--safe-' + k, (ins[k] || 0) + 'px');
        emit({ type: 'insets', insets: ins });
      };
      d.hotkey = (phase, wasRaised) => emit({ type: 'hotkey', phase, wasRaised: !!wasRaised });
      d.raised = (on) => {
        d.isRaised = !!on;
        document.documentElement.classList.toggle('jarvis-raised', !!on);
        emit({ type: 'raised', on: !!on });
      };
      d.dismiss = () => d.post({ type: 'dismiss' });
      d.summon = () => d.post({ type: 'raise' });
      document.documentElement.classList.add('jarvis-desktop');
      d.setInsets(\(insetsJSON(currentInsets())));
    })();
    """
  }

  func load() {
    loading = true
    var req = URLRequest(url: URL(string: HUD_ORIGIN + "/?desktop=1")!)
    req.cachePolicy = .reloadIgnoringLocalCacheData
    req.timeoutInterval = 15
    web.load(req)
  }

  func reload() {
    log("obnovujem HUD")
    load()
  }

  func showStatus(_ text: String?) {
    statusLabel.stringValue = text ?? ""
    statusLabel.isHidden = text == nil
  }

  func js(_ code: String) {
    web.evaluateJavaScript(code, completionHandler: nil)
  }

  /// A drag from Finder entered the window: the page learns where the files are. A folder or a
  /// very big export is then read by the HUD server in place (POST /api/upload/local) instead of
  /// being copied through the page. Smaller files and anything the server cannot reach go the
  /// ordinary way, as an upload from the page.
  func dragFiles(_ urls: [URL]) {
    let items: [[String: Any]] = urls.map { url in
      var isDir: ObjCBool = false
      FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir)
      return ["name": url.lastPathComponent, "path": url.path, "dir": isDir.boolValue]
    }
    guard let data = try? JSONSerialization.data(withJSONObject: items),
      let json = String(data: data, encoding: .utf8)
    else { return }
    js("window.__jarvisDrag && window.__jarvisDrag(\(json))")
  }

  // MARK: Okraje (menu lišta hore, Dock dole) pre rozloženie HUD

  func currentInsets() -> NSEdgeInsets {
    let f = screen.frame
    let v = screen.visibleFrame
    return NSEdgeInsets(
      top: max(0, f.maxY - v.maxY), left: max(0, v.minX - f.minX),
      bottom: max(0, v.minY - f.minY), right: max(0, f.maxX - v.maxX))
  }

  func insetsJSON(_ i: NSEdgeInsets) -> String {
    "{\"top\":\(Int(i.top.rounded())),\"right\":\(Int(i.right.rounded())),\"bottom\":\(Int(i.bottom.rounded())),\"left\":\(Int(i.left.rounded()))}"
  }

  func pushInsets(force: Bool = false) {
    let i = currentInsets()
    let same =
      i.top == lastInsets.top && i.bottom == lastInsets.bottom && i.left == lastInsets.left
      && i.right == lastInsets.right
    if same && !force { return }
    lastInsets = i
    js("window.__jarvisDesktop && window.__jarvisDesktop.setInsets(\(insetsJSON(i)))")
  }

  func refit() {
    let f = screen.frame
    if window.frame != f {
      window.setFrame(f, display: true)
      log("nový rozmer obrazovky \(Int(f.width))x\(Int(f.height))")
    }
    pushInsets(force: true)
    writeWindowInfo()
  }

  func writeWindowInfo() {
    let info = "{\"windowNumber\":\(window.windowNumber),\"pid\":\(ProcessInfo.processInfo.processIdentifier)}"
    try? info.write(to: CACHE_DIR.appendingPathComponent("window.json"), atomically: true, encoding: .utf8)
  }

  // MARK: Vyvolanie nad okná a návrat na plochu

  func raise() {
    if raised { return }
    let front = NSWorkspace.shared.frontmostApplication
    previousApp = front?.bundleIdentifier == BUNDLE_ID ? nil : front
    raised = true
    window.collectionBehavior = [.canJoinAllSpaces, .ignoresCycle, .fullScreenAuxiliary]
    window.level = .floating
    NSApp.activate()
    window.makeKeyAndOrderFront(nil)
    window.makeFirstResponder(web)
    js("window.__jarvisDesktop && window.__jarvisDesktop.raised(true)")
  }

  func lower(reactivatePrevious: Bool) {
    if !raised { return }
    raised = false
    window.level = desktopLevel
    window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenNone]
    window.orderFront(nil)
    js("window.__jarvisDesktop && window.__jarvisDesktop.raised(false)")
    if reactivatePrevious, let app = previousApp, !app.isTerminated {
      app.activate()
    }
    previousApp = nil
  }

  // MARK: Globálna skratka ⌃⌥J (Carbon, nepotrebuje povolenie Prístupnosti)

  func registerHotKey() {
    var spec = [
      EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
      EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased)),
    ]
    let me = Unmanaged.passUnretained(self).toOpaque()
    InstallEventHandler(
      GetApplicationEventTarget(),
      { _, event, user in
        guard let event, let user else { return noErr }
        let pressed = GetEventKind(event) == UInt32(kEventHotKeyPressed)
        let app = Unmanaged<AppDelegate>.fromOpaque(user).takeUnretainedValue()
        MainActor.assumeIsolated { app.hotkey(down: pressed) }
        return noErr
      }, 2, &spec, me, nil)
    let id = EventHotKeyID(signature: OSType(0x4A52_5653), id: 1)  // 'JRVS'
    let status = RegisterEventHotKey(
      UInt32(kVK_ANSI_J), UInt32(controlKey | optionKey), id, GetApplicationEventTarget(), 0, &hotKeyRef)
    log(status == noErr ? "skratka \(HOTKEY_LABEL) pripravená" : "skratka \(HOTKEY_LABEL) sa nezaregistrovala (\(status))")
  }

  func hotkey(down: Bool) {
    if down {
      let was = raised
      if !raised { raise() }
      js("window.__jarvisDesktop && window.__jarvisDesktop.hotkey('down', \(was))")
    } else {
      js("window.__jarvisDesktop && window.__jarvisDesktop.hotkey('up', true)")
    }
  }

  // MARK: Ikony na ploche (Finder CreateDesktop), vratné

  func desktopIconsVisible() -> Bool {
    let v = run("/usr/bin/defaults", ["read", "com.apple.finder", "CreateDesktop"]).out
      .trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    return !(v == "0" || v == "false" || v == "no")
  }

  func setDesktopIcons(visible: Bool) {
    run("/usr/bin/defaults", ["write", "com.apple.finder", "CreateDesktop", "-bool", visible ? "true" : "false"])
    run("/usr/bin/killall", ["Finder"])
    log(visible ? "ikony na ploche zapnuté" : "ikony na ploche skryté")
  }

  // MARK: Spúšťanie po prihlásení (LaunchAgent, pri páde sa appka znova spustí)

  func loginItemEnabled() -> Bool {
    FileManager.default.fileExists(atPath: AGENT_URL.path)
  }

  func setLoginItem(_ on: Bool) {
    if !on {
      try? FileManager.default.removeItem(at: AGENT_URL)
      log("spúšťanie po prihlásení vypnuté")
      return
    }
    guard let exe = Bundle.main.executableURL?.path else { return }
    let plist: [String: Any] = [
      "Label": AGENT_LABEL,
      "ProgramArguments": [exe],
      "RunAtLoad": true,
      "KeepAlive": ["SuccessfulExit": false],
      "ProcessType": "Interactive",
      "LimitLoadToSessionType": "Aqua",
      "ThrottleInterval": 10,
      "StandardOutPath": LOG_PATH,
      "StandardErrorPath": LOG_PATH,
    ]
    do {
      let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
      try FileManager.default.createDirectory(
        at: AGENT_URL.deletingLastPathComponent(), withIntermediateDirectories: true)
      try data.write(to: AGENT_URL, options: .atomic)
      log("spúšťanie po prihlásení zapnuté (\(AGENT_URL.path))")
    } catch {
      log("LaunchAgent sa nepodarilo zapísať: \(error)")
    }
  }

  // MARK: HUD server (the app starts it when it is not running)

  func checkServer() {
    var req = URLRequest(url: URL(string: HUD_ORIGIN + "/api/health")!)
    req.timeoutInterval = 2.5
    URLSession.shared.dataTask(with: req) { [weak self] _, resp, _ in
      let ok = (resp as? HTTPURLResponse)?.statusCode == 200
      Task { @MainActor in self?.serverStatus(ok) }
    }.resume()
  }

  func serverStatus(_ ok: Bool) {
    if ok {
      if !serverOK { log("server HUD beží") }
      serverOK = true
      serverFails = 0
      if !pageLoaded && !loading { load() }
      return
    }
    if serverOK { log("server HUD neodpovedá") }
    serverOK = false
    serverFails += 1
    if !pageLoaded { showStatus("Jarvis štartuje…") }
    if serverFails >= 2 && Date().timeIntervalSince(lastStartRequest) > 30 { requestServerStart() }
  }

  /// Starts the HUD server as a child process (node hud/server.mjs in the Jarvis folder).
  func requestServerStart() {
    lastStartRequest = Date()
    let script = JARVIS_REPO + "/hud/server.mjs"
    guard !JARVIS_REPO.isEmpty, FileManager.default.isExecutableFile(atPath: NODE_PATH),
      FileManager.default.fileExists(atPath: script)
    else {
      log("server HUD nebeží a neviem ho spustiť (node: \(NODE_PATH), priečinok: \(JARVIS_REPO)). Spusti v priečinku Jarvisa: npm start")
      showStatus("Jarvis nebeží. V priečinku Jarvisa spusti: npm start")
      return
    }
    if let p = serverProcess, p.isRunning { return }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: NODE_PATH)
    p.arguments = [script]
    p.currentDirectoryURL = URL(fileURLWithPath: JARVIS_REPO)
    var env = ProcessInfo.processInfo.environment
    let nodeDir = (NODE_PATH as NSString).deletingLastPathComponent
    env["PATH"] = [nodeDir, HOME.path + "/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", env["PATH"] ?? "/usr/bin:/bin"].joined(separator: ":")
    env["PORT"] = HUD_PORT
    p.environment = env
    let out = FileHandle(forWritingAtPath: SERVER_LOG_PATH) ?? {
      FileManager.default.createFile(atPath: SERVER_LOG_PATH, contents: nil)
      return FileHandle(forWritingAtPath: SERVER_LOG_PATH)
    }()
    out?.seekToEndOfFile()
    p.standardOutput = out
    p.standardError = out
    do {
      try p.run()
      serverProcess = p
      log("server HUD spustený (pid \(p.processIdentifier))")
    } catch {
      log("server HUD sa nepodarilo spustiť: \(error)")
    }
  }

  func tick() {
    ticks += 1
    pushInsets()
    if window.frame != screen.frame { refit() }
    // Server kontrolujeme každé 3 s, kým stránka nebeží, potom každých 9 s.
    if !pageLoaded || ticks % 3 == 0 { checkServer() }
    dailyReload()
  }

  /// Raz denne o 4:00 čerstvé načítanie: nový kód HUD, uvoľnená pamäť WebKitu a čas v shaderoch
  /// (float32) nezačne po dňoch behu sekať.
  func dailyReload() {
    let c = Calendar.current.dateComponents([.year, .month, .day, .hour], from: Date())
    guard c.hour == 4, !raised else { return }
    let day = "\(c.year ?? 0)-\(c.month ?? 0)-\(c.day ?? 0)"
    if lastDailyReload == day { return }
    lastDailyReload = day
    reload()
  }

  // MARK: WKNavigationDelegate

  /// The window shows the HUD and nothing else. The bridge to the app lives in the main frame, so
  /// the main frame never leaves the HUD's own address: any other link opens in the user's browser.
  func webView(
    _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
    let mainFrame = navigationAction.targetFrame?.isMainFrame ?? true
    if !mainFrame { return decisionHandler(.allow) }
    let home = URL(string: HUD_ORIGIN)
    let own = url.scheme == home?.scheme && url.host == home?.host && url.port == home?.port
    if own || url.scheme == "about" { return decisionHandler(.allow) }
    if url.scheme == "http" || url.scheme == "https" { NSWorkspace.shared.open(url) }
    decisionHandler(.cancel)
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    loading = false
    pageLoaded = true
    showStatus(nil)
    pushInsets(force: true)
    NSAnimationContext.runAnimationGroup { ctx in
      ctx.duration = 0.6
      web.animator().alphaValue = 1
    }
    log("HUD načítaný")
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    navigationFailed(error)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    navigationFailed(error)
  }

  func navigationFailed(_ error: Error) {
    loading = false
    pageLoaded = false
    web.alphaValue = 0
    showStatus("Jarvis štartuje…")
    log("HUD sa nenačítal: \(error.localizedDescription)")
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    log("proces stránky skončil, načítavam znova")
    pageLoaded = false
    load()
  }

  // MARK: WKUIDelegate: mikrofón a kamera len pre vlastný HUD

  func webView(
    _ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
    initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
    decisionHandler: @escaping (WKPermissionDecision) -> Void
  ) {
    // Only the HUD itself (its exact address, its main frame) may listen and, for hand control, see.
    // Another local port is another program. The page asks for the camera only after a click on its chip.
    let home = URL(string: HUD_ORIGIN)
    let own = (origin.host == "127.0.0.1" || origin.host == "localhost") && origin.port == (home?.port ?? 0)
    decisionHandler(own && frame.isMainFrame ? .grant : .deny)
  }

  // MARK: Správy zo stránky

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
    switch type {
    case "dismiss": lower(reactivatePrevious: true)
    case "raise": raise()
    case "ready": pushInsets(force: true)
    case "log": log("stránka: \(body["text"] ?? "")")
    case "control":
      // Jarvis is working the mouse, the keyboard or the browser: show where, above every window.
      let num = { (k: String) -> CGFloat? in (body[k] as? NSNumber).map { CGFloat(truncating: $0) } }
      control.update(on: (body["on"] as? Bool) ?? true, label: body["label"] as? String, x: num("x"), y: num("y"), click: (body["click"] as? Bool) ?? false)
    default: break
    }
  }

  // MARK: Ikona v lište

  func buildStatusItem() {
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    statusItem.button?.image = AppDelegate.menuIcon()
    statusItem.button?.toolTip = "Jarvis HUD"
    let menu = NSMenu()
    menu.delegate = self
    statusItem.menu = menu
  }

  static func menuIcon() -> NSImage {
    let img = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { r in
      NSColor.black.setStroke()
      NSColor.black.setFill()
      let ring = NSBezierPath(ovalIn: r.insetBy(dx: 2, dy: 2))
      ring.lineWidth = 1.6
      ring.stroke()
      let inner = NSBezierPath(ovalIn: r.insetBy(dx: 5.5, dy: 5.5))
      inner.lineWidth = 1.1
      inner.stroke()
      NSBezierPath(ovalIn: NSRect(x: 7.4, y: 7.4, width: 3.2, height: 3.2)).fill()
      return true
    }
    img.isTemplate = true
    return img
  }

  func menuNeedsUpdate(_ menu: NSMenu) {
    menu.removeAllItems()
    let head = NSMenuItem(title: serverOK ? "Jarvis HUD beží" : "Jarvis HUD: server štartuje", action: nil, keyEquivalent: "")
    head.isEnabled = false
    menu.addItem(head)
    menu.addItem(.separator())
    item(menu, "Vyvolať Jarvisa (\(HOTKEY_LABEL))", #selector(menuSummon))
    item(menu, "Obnoviť HUD", #selector(menuReload))
    item(menu, "Otvoriť v prehliadači", #selector(menuBrowser))
    menu.addItem(.separator())
    item(menu, "Ikony na ploche", #selector(menuIcons)).state = desktopIconsVisible() ? .on : .off
    item(menu, "Spúšťať po prihlásení", #selector(menuLogin)).state = loginItemEnabled() ? .on : .off
    menu.addItem(.separator())
    item(menu, "Ukončiť a vrátiť plochu", #selector(menuQuit))
  }

  @discardableResult
  func item(_ menu: NSMenu, _ title: String, _ action: Selector) -> NSMenuItem {
    let it = NSMenuItem(title: title, action: action, keyEquivalent: "")
    it.target = self
    menu.addItem(it)
    return it
  }

  @objc func menuSummon() { raise() }
  @objc func menuReload() { reload() }

  @objc func menuBrowser() {
    NSWorkspace.shared.open(URL(string: "http://localhost:\(HUD_PORT)/")!)
  }

  @objc func menuIcons() {
    let show = !desktopIconsVisible()
    defaults.set(!show, forKey: "hideDesktopIcons")
    setDesktopIcons(visible: show)
  }

  @objc func menuLogin() {
    let on = !loginItemEnabled()
    defaults.set(on, forKey: "launchAtLogin")
    setLoginItem(on)
  }

  @objc func menuQuit() {
    if !desktopIconsVisible() { setDesktopIcons(visible: true) }
    log("koniec cez menu")
    NSApp.terminate(nil)
  }

  // MARK: Udalosti systému

  func observe() {
    let nc = NotificationCenter.default
    nc.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) {
      [weak self] _ in MainActor.assumeIsolated { self?.refit() }
    }
    nc.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) {
      [weak self] _ in MainActor.assumeIsolated { self?.lower(reactivatePrevious: false) }
    }
    let ws = NSWorkspace.shared.notificationCenter
    ws.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated {
        self?.refit()
        self?.checkServer()
      }
      // Po spánku môže WebGL stratiť kontext: o 3 s stránku čisto načítame.
      DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
        MainActor.assumeIsolated {
          guard let self, !self.raised else { return }
          self.reload()
        }
      }
    }
  }

  /// SIGUSR1 uloží snímku stránky (overovanie), SIGUSR2 obnoví stránku.
  func installSignals() {
    signal(SIGUSR1, SIG_IGN)
    signal(SIGUSR2, SIG_IGN)
    let snap = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
    snap.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.snapshot() } }
    snap.resume()
    let rel = DispatchSource.makeSignalSource(signal: SIGUSR2, queue: .main)
    rel.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.reload() } }
    rel.resume()
    signalSource = snap
    reloadSource = rel
  }

  var reloadSource: DispatchSourceSignal?

  func snapshot() {
    writeWindowInfo()
    web.takeSnapshot(with: nil) { image, error in
      guard let image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
        let png = rep.representation(using: .png, properties: [:])
      else {
        log("snímka zlyhala: \(error.map { String(describing: $0) } ?? "?")")
        return
      }
      try? png.write(to: CACHE_DIR.appendingPathComponent("snapshot.png"))
      log("snímka uložená")
    }
  }
}

// MARK: Rámik nad všetkými oknami, keď Jarvis ovláda počítač

/// A frame around the screen, a label and a reticle where Jarvis acts, drawn above every window.
/// It never takes a click and stays out of screenshots, so the agent does not see itself.
@MainActor
final class ControlOverlay {
  private var window: NSWindow?
  private let frameLayer = CAShapeLayer()
  private let corners = CAShapeLayer()
  private let reticle = CALayer()
  private let pill = CAShapeLayer()
  private let text = CATextLayer()
  private var hideTimer: Timer?
  private let ice = NSColor(srgbRed: 0.5, green: 0.953, blue: 1, alpha: 1)
  private let amber = NSColor(srgbRed: 1, green: 0.698, blue: 0.361, alpha: 1)
  /// Tests keep the overlay in screenshots to look at it.
  var inScreenshots = false

  private func build(_ screen: NSScreen) -> NSWindow {
    let w = NSWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false)
    w.isOpaque = false
    w.backgroundColor = .clear
    w.hasShadow = false
    w.ignoresMouseEvents = true
    w.isReleasedWhenClosed = false
    w.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.screenSaverWindow)))
    w.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    if !inScreenshots { w.sharingType = .none }
    let view = NSView(frame: NSRect(origin: .zero, size: screen.frame.size))
    view.wantsLayer = true
    w.contentView = view
    guard let root = view.layer else { return w }
    let b = view.bounds

    frameLayer.path = CGPath(roundedRect: b.insetBy(dx: 5, dy: 5), cornerWidth: 16, cornerHeight: 16, transform: nil)
    frameLayer.fillColor = nil
    frameLayer.strokeColor = ice.withAlphaComponent(0.8).cgColor
    frameLayer.lineWidth = 3
    glow(frameLayer, ice, 16)
    let breathe = CABasicAnimation(keyPath: "opacity")
    breathe.fromValue = 1
    breathe.toValue = 0.45
    breathe.duration = 1.5
    breathe.autoreverses = true
    breathe.repeatCount = .infinity
    frameLayer.add(breathe, forKey: "breathe")
    root.addSublayer(frameLayer)

    // Corner brackets, like the frame of a viewfinder.
    let p = CGMutablePath()
    let m: CGFloat = 14
    let l: CGFloat = 46
    for (x, y, dx, dy) in [(m, m, 1.0, 1.0), (b.width - m, m, -1.0, 1.0), (b.width - m, b.height - m, -1.0, -1.0), (m, b.height - m, 1.0, -1.0)] {
      p.move(to: CGPoint(x: x + l * dx, y: y))
      p.addLine(to: CGPoint(x: x, y: y))
      p.addLine(to: CGPoint(x: x, y: y + l * dy))
    }
    corners.path = p
    corners.fillColor = nil
    corners.strokeColor = ice.cgColor
    corners.lineWidth = 3.5
    corners.lineCap = .round
    corners.lineJoin = .round
    glow(corners, ice, 10)
    root.addSublayer(corners)

    pill.fillColor = NSColor(srgbRed: 0.02, green: 0.06, blue: 0.08, alpha: 0.9).cgColor
    pill.strokeColor = ice.withAlphaComponent(0.6).cgColor
    pill.lineWidth = 1
    glow(pill, ice, 12)
    root.addSublayer(pill)
    text.fontSize = 15
    text.font = NSFont.systemFont(ofSize: 15, weight: .semibold)
    text.foregroundColor = NSColor(srgbRed: 0.92, green: 0.98, blue: 1, alpha: 1).cgColor
    text.alignmentMode = .center
    text.contentsScale = screen.backingScaleFactor
    root.addSublayer(text)

    // The reticle: a turning dashed ring, four ticks and a dot.
    reticle.bounds = CGRect(x: 0, y: 0, width: 96, height: 96)
    reticle.isHidden = true
    let c = CGPoint(x: 48, y: 48)
    let ring = CAShapeLayer()
    ring.frame = reticle.bounds
    ring.path = CGPath(ellipseIn: CGRect(x: 48 - 30, y: 48 - 30, width: 60, height: 60), transform: nil)
    ring.fillColor = nil
    ring.strokeColor = ice.cgColor
    ring.lineWidth = 2.2
    ring.lineDashPattern = [4, 7]
    glow(ring, ice, 8)
    let spin = CABasicAnimation(keyPath: "transform.rotation.z")
    spin.fromValue = 0
    spin.toValue = Double.pi * 2
    spin.duration = 7
    spin.repeatCount = .infinity
    ring.add(spin, forKey: "spin")
    reticle.addSublayer(ring)
    let inner = CAShapeLayer()
    inner.path = CGPath(ellipseIn: CGRect(x: 48 - 19, y: 48 - 19, width: 38, height: 38), transform: nil)
    inner.fillColor = ice.withAlphaComponent(0.1).cgColor
    inner.strokeColor = ice.cgColor
    inner.lineWidth = 2.6
    glow(inner, ice, 10)
    reticle.addSublayer(inner)
    let ticks = CAShapeLayer()
    let t = CGMutablePath()
    for (dx, dy) in [(0.0, 1.0), (0.0, -1.0), (1.0, 0.0), (-1.0, 0.0)] {
      t.move(to: CGPoint(x: c.x + 36 * dx, y: c.y + 36 * dy))
      t.addLine(to: CGPoint(x: c.x + 44 * dx, y: c.y + 44 * dy))
    }
    ticks.path = t
    ticks.strokeColor = ice.cgColor
    ticks.lineWidth = 2
    ticks.lineCap = .round
    glow(ticks, ice, 6)
    reticle.addSublayer(ticks)
    let dot = CAShapeLayer()
    dot.path = CGPath(ellipseIn: CGRect(x: 48 - 3.5, y: 48 - 3.5, width: 7, height: 7), transform: nil)
    dot.fillColor = NSColor.white.cgColor
    glow(dot, ice, 6)
    reticle.addSublayer(dot)
    root.addSublayer(reticle)
    return w
  }

  private func glow(_ layer: CALayer, _ color: NSColor, _ radius: CGFloat) {
    layer.shadowColor = color.cgColor
    layer.shadowRadius = radius
    layer.shadowOpacity = 0.9
    layer.shadowOffset = .zero
  }

  /// x and y are points of the main screen from its top left corner (the way events are posted).
  func update(on: Bool, label: String?, x: CGFloat?, y: CGFloat?, click: Bool) {
    guard on, let screen = NSScreen.screens.first else { return hide() }
    if window == nil || window?.frame != screen.frame {
      window?.orderOut(nil)
      window = build(screen)
    }
    guard let w = window, let root = w.contentView?.layer else { return }
    let b = root.bounds
    let line = "Jarvis · " + String((label ?? "").prefix(60)).trimmingCharacters(in: .whitespacesAndNewlines)
    let shown = line.hasSuffix("· ") ? "Jarvis ovláda počítač" : line
    let size = (shown as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: 15, weight: .semibold)])
    let pw = ceil(size.width) + 44
    let ph: CGFloat = 38
    let rect = CGRect(x: (b.width - pw) / 2, y: b.height - 58 - ph, width: pw, height: ph)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    pill.path = CGPath(roundedRect: rect, cornerWidth: ph / 2, cornerHeight: ph / 2, transform: nil)
    text.string = shown
    text.frame = CGRect(x: rect.minX, y: rect.minY + (ph - 20) / 2 - 1, width: pw, height: 20)
    CATransaction.commit()

    if let x, let y {
      let to = CGPoint(x: min(max(x, 0), b.width), y: b.height - min(max(y, 0), b.height))
      if reticle.isHidden {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        reticle.position = to
        reticle.isHidden = false
        CATransaction.commit()
      } else {
        CATransaction.begin()
        CATransaction.setAnimationDuration(0.3)
        CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(name: .easeInEaseOut))
        reticle.position = to
        CATransaction.commit()
      }
      if click { ripple(at: to, in: root) }
    }
    if !w.isVisible { log("rámik ovládania: zapnutý") }
    w.orderFrontRegardless()
    hideTimer?.invalidate()
    hideTimer = Timer.scheduledTimer(withTimeInterval: 8, repeats: false) { [weak self] _ in
      Task { @MainActor in self?.hide() }
    }
  }

  private func ripple(at p: CGPoint, in root: CALayer) {
    let r = CAShapeLayer()
    r.bounds = CGRect(x: 0, y: 0, width: 60, height: 60)
    r.position = p
    r.path = CGPath(ellipseIn: r.bounds.insetBy(dx: 2, dy: 2), transform: nil)
    r.fillColor = nil
    r.strokeColor = amber.cgColor
    r.lineWidth = 3
    glow(r, amber, 10)
    root.addSublayer(r)
    let grow = CABasicAnimation(keyPath: "transform.scale")
    grow.fromValue = 0.3
    grow.toValue = 2.2
    let fade = CABasicAnimation(keyPath: "opacity")
    fade.fromValue = 1
    fade.toValue = 0
    let g = CAAnimationGroup()
    g.animations = [grow, fade]
    g.duration = 0.5
    g.timingFunction = CAMediaTimingFunction(name: .easeOut)
    g.isRemovedOnCompletion = false
    g.fillMode = .forwards
    r.add(g, forKey: "ripple")
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.55) { r.removeFromSuperlayer() }
  }

  func hide() {
    hideTimer?.invalidate()
    hideTimer = nil
    reticle.isHidden = true
    if window?.isVisible == true { log("rámik ovládania: vypnutý") }
    window?.orderOut(nil)
  }
}

MainActor.assumeIsolated {
  let app = NSApplication.shared
  let delegate = AppDelegate()  // NSApplication.delegate je weak, run() sa nevráti, takže žije stále
  app.delegate = delegate
  app.run()
}
