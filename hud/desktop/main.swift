// Jarvis for the Mac: one app, two ways to live on the screen.
//
//   desktop  the HUD (http://127.0.0.1:<port>) as a live wallpaper: a window at desktop level (below
//            all windows, above the wallpaper) on every Space, a ring in the menu bar, no Dock icon.
//            When desktop icons are hidden (Finder CreateDesktop = false, opt-in from the menu),
//            clicks and typing go straight to the HUD. ⌃⌥J brings the HUD above all windows:
//            hold = talk, tap = type. Esc sends it back to the desktop.
//   app      a normal macOS window: title bar, resizable, full screen with the green button or ⌃⌘F,
//            Dock icon and ⌘Tab. Closing the window hides it, Jarvis keeps running and keeps
//            talking; the Dock icon or opening the app again brings the window back.
//
// Which one comes from the place the user chose (`surface` in config/jarvis.json): the app asks the
// HUD server every 3 s (GET /api/health) and moves between the two on its own when it changes in
// Settings. Until the server answers it uses the launch argument (`--surface app`, from
// scripts/hud.mjs) or the mode it had last time. `browser` means Jarvis lives in a browser page: the
// app gives the desktop back and ends.
// The app also starts the HUD server (node hud/server.mjs) when it is not running; the paths of
// node and of the Jarvis folder are written into Info.plist by desktop/build.sh.
// Build and install: desktop/build.sh. Log: ~/Library/Logs/jarvis-app.log.

import Carbon.HIToolbox
import Cocoa
import UserNotifications
import AVFoundation
import WebKit

// MARK: - Konfigurácia

let HUD_PORT = (Bundle.main.object(forInfoDictionaryKey: "JarvisPort") as? String) ?? "4545"
let HUD_ORIGIN = ProcessInfo.processInfo.environment["JARVIS_HUD_ORIGIN"] ?? "http://127.0.0.1:\(HUD_PORT)"
/// Where the Jarvis folder and node live, baked in by build.sh so the app can start the server itself.
let JARVIS_REPO = (Bundle.main.object(forInfoDictionaryKey: "JarvisRepo") as? String) ?? ""
let NODE_PATH = (Bundle.main.object(forInfoDictionaryKey: "JarvisNode") as? String) ?? ""
let BUNDLE_ID = Bundle.main.bundleIdentifier ?? "com.jarvis-starter.app"
/// The desktop app of 1.9.7 and older ("Jarvis HUD.app"). Its settings are taken over once.
let OLD_BUNDLE_ID = "com.jarvis-starter.hud"
let AGENT_LABEL = "com.jarvis-starter.app-login"
let HOME = FileManager.default.homeDirectoryForCurrentUser
let CACHE_DIR = HOME.appendingPathComponent("Library/Caches/Jarvis", isDirectory: true)
let LOG_PATH = HOME.appendingPathComponent("Library/Logs/jarvis-app.log").path
let SERVER_LOG_PATH = HOME.appendingPathComponent("Library/Logs/jarvis-server.log").path
let AGENT_URL = HOME.appendingPathComponent("Library/LaunchAgents/\(AGENT_LABEL).plist")
let HOTKEY_LABEL = "⌃⌥J"
let WINDOW_AUTOSAVE = "JarvisWindow"

// MARK: - Pomocné funkcie

let logQueue = DispatchQueue(label: "jarvis.app.log")

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

/// The place given on the command line (`--surface desktop|app`), if any.
func launchSurface() -> String? {
  let args = CommandLine.arguments
  guard let i = args.firstIndex(of: "--surface"), i + 1 < args.count else { return nil }
  return args[i + 1].lowercased()
}

/// Okno, ktoré aj bez rámu môže prijímať klávesnicu (písanie Jarvisovi, medzerník).
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

/// The two ways the app lives on the screen.
enum Mode: String {
  case desktop
  case app
}

// MARK: - Appka

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate,
  WKScriptMessageHandler, NSMenuDelegate, NSWindowDelegate
{
  var window: HUDWindow?
  var root: NSView!
  var web: HUDWebView!
  var statusLabel: NSTextField!
  var statusItem: NSStatusItem?
  let control = ControlOverlay()
  let mic = NativeMic()
  var mode = Mode.desktop
  var started = false
  var leaving = false
  var hotKeyRef: EventHotKeyRef?
  var signalSource: DispatchSourceSignal?
  var reloadSource: DispatchSourceSignal?

  var raised = false
  var previousApp: NSRunningApplication?
  var lastInsets = NSEdgeInsetsZero
  var serverOK = false
  var serverFails = 0
  var lastStartRequest = Date.distantPast
  var serverProcess: Process?
  var pageLoaded = false
  var loading = false
  var lastDailyReload = ""

  let defaults = UserDefaults.standard
  let background = NSColor(red: 0.016, green: 0.027, blue: 0.039, alpha: 1)

  /// Úroveň okna na ploche: tesne nad tapetou, pod ikonami plochy a všetkými oknami.
  var desktopLevel: NSWindow.Level {
    NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) + 1)
  }

  var screen: NSScreen { NSScreen.screens.first ?? NSScreen.main! }

  func applicationDidFinishLaunching(_ notification: Notification) {
    let me = ProcessInfo.processInfo.processIdentifier
    let others = NSRunningApplication.runningApplications(withBundleIdentifier: BUNDLE_ID)
      .filter { $0.processIdentifier != me }
    if let other = others.first {
      // Opened a second time: the copy that runs shows itself (the reopen event does that) and this one ends.
      log("Jarvis už beží (pid \(other.processIdentifier)), druhá inštancia končí")
      other.activate()
      exit(0)
    }
    // The desktop app of 1.9.7 and older would show a second Jarvis next to this one.
    for old in NSRunningApplication.runningApplications(withBundleIdentifier: OLD_BUNDLE_ID) {
      log("končím starú appku Jarvis HUD (pid \(old.processIdentifier))")
      old.terminate()
    }
    NSApp.setActivationPolicy(.accessory)
    migrateDefaults()
    // Both are opt-in from the menu: the app never changes Finder or login items on its own.
    defaults.register(defaults: ["hideDesktopIcons": false, "launchAtLogin": false, "mode": Mode.desktop.rawValue, "fullScreen": false])
    try? FileManager.default.createDirectory(at: CACHE_DIR, withIntermediateDirectories: true)
    log("štart, \(Bundle.main.bundlePath)")

    buildContent()
    buildMainMenu()
    registerHotKey()
    observe()
    installSignals()

    // The server decides where Jarvis lives. Until it answers (or when it does not run yet), the
    // launch argument and then the mode of the last time.
    fetchHealth(timeout: 1.5) { [weak self] health in
      guard let self else { return }
      let surface = health?["surface"] as? String
      if surface == "browser" {
        // Opened while Jarvis lives in a browser page: the page opens instead (unless one is open already).
        let windows = health?["windows"] as? [String: Any]
        let tabs = (windows?["browser"] as? NSNumber)?.intValue ?? 0
        return self.leave(openBrowser: tabs == 0)
      }
      let wanted = surface ?? launchSurface() ?? self.defaults.string(forKey: "mode") ?? "desktop"
      self.enter(wanted == Mode.app.rawValue ? .app : .desktop)
      self.serverStatus(health != nil)
      if self.defaults.bool(forKey: "launchAtLogin") && !self.loginItemEnabled() { self.setLoginItem(true) }
      Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
        MainActor.assumeIsolated { self?.tick() }
      }
    }
  }

  /// The settings of the old "Jarvis HUD" app (another bundle id) come along once.
  func migrateDefaults() {
    guard !defaults.bool(forKey: "migratedFromHUD") else { return }
    defaults.set(true, forKey: "migratedFromHUD")
    guard let old = UserDefaults(suiteName: OLD_BUNDLE_ID) else { return }
    for key in ["hideDesktopIcons", "launchAtLogin"] {
      if let value = old.object(forKey: key) { defaults.set(value, forKey: key) }
    }
  }

  // MARK: Okno a web

  /// The web view with its status line. It lives in whichever window the mode has and moves between them.
  func buildContent() {
    root = NSView(frame: NSRect(x: 0, y: 0, width: 1200, height: 800))
    root.autoresizingMask = [.width, .height]

    statusLabel = NSTextField(labelWithString: "Jarvis štartuje…")
    statusLabel.font = NSFont.systemFont(ofSize: 22, weight: .light)
    statusLabel.textColor = NSColor(red: 0.5, green: 0.95, blue: 1, alpha: 0.8)
    statusLabel.alignment = .center
    statusLabel.frame = NSRect(x: 0, y: root.bounds.height / 2 - 20, width: root.bounds.width, height: 40)
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
    cfg.userContentController = ucc

    web = HUDWebView(frame: root.bounds, configuration: cfg)
    web.autoresizingMask = [.width, .height]
    web.navigationDelegate = self
    web.uiDelegate = self
    web.underPageBackgroundColor = background
    web.isInspectable = inspect
    web.alphaValue = 0
    web.onDragFiles = { [weak self] urls in self?.dragFiles(urls) }
    root.addSubview(web)
  }

  /// Jarvis as the desktop: borderless, the size of the screen, under every window, on every Space.
  func makeDesktopWindow() -> HUDWindow {
    let frame = screen.frame
    let w = HUDWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
    w.setFrame(frame, display: false)
    w.level = desktopLevel
    w.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenNone]
    w.isOpaque = true
    w.hasShadow = false
    w.isMovable = false
    return w
  }

  /// Jarvis in his own window: like any other program. Its size and place are remembered.
  func makeAppWindow() -> HUDWindow {
    let visible = screen.visibleFrame
    let w = HUDWindow(
      contentRect: visible, styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    w.titlebarAppearsTransparent = true
    w.titleVisibility = .hidden
    w.appearance = NSAppearance(named: .darkAqua)
    w.collectionBehavior = [.fullScreenPrimary, .managed]
    w.minSize = NSSize(width: 820, height: 560)
    w.isOpaque = true
    w.tabbingMode = .disallowed
    if !w.setFrameUsingName(WINDOW_AUTOSAVE) { w.setFrame(visible, display: false) }
    w.setFrameAutosaveName(WINDOW_AUTOSAVE)
    return w
  }

  /// Moves Jarvis into the given mode: a new window for it, the web view moves over and loads the page for it.
  func enter(_ next: Mode) {
    if started && next == mode { return }
    let from = started ? mode : nil
    started = true
    mode = next
    defaults.set(next.rawValue, forKey: "mode")
    log(from == nil ? "režim \(next.rawValue)" : "presúvam sa: \(from!.rawValue) → \(next.rawValue)")
    raised = false
    previousApp = nil

    let old = window
    let w = next == .desktop ? makeDesktopWindow() : makeAppWindow()
    w.backgroundColor = background
    w.isReleasedWhenClosed = false
    w.acceptsMouseMovedEvents = true
    w.title = "Jarvis"
    w.delegate = self
    old?.contentView = NSView()
    root.frame = NSRect(origin: .zero, size: w.contentLayoutRect.size)
    w.contentView = root
    window = w

    if next == .desktop {
      NSApp.setActivationPolicy(.accessory)
      buildStatusItem()
      if defaults.bool(forKey: "hideDesktopIcons") && desktopIconsVisible() { setDesktopIcons(visible: false) }
      old?.orderOut(nil)
      w.orderFront(nil)
    } else {
      removeStatusItem()
      // The desktop is not Jarvis any more: icons he hid come back.
      if defaults.bool(forKey: "hideDesktopIcons") && !desktopIconsVisible() { setDesktopIcons(visible: true) }
      NSApp.setActivationPolicy(.regular)
      old?.orderOut(nil)
      showWindow()
      if defaults.bool(forKey: "fullScreen") && !w.styleMask.contains(.fullScreen) {
        DispatchQueue.main.async { w.toggleFullScreen(nil) }
      }
    }
    old?.close()
    installBootstrap()
    pageLoaded = false
    web.alphaValue = 0
    showStatus("Jarvis štartuje…")
    load()
    writeWindowInfo()
  }

  /// The bridge for the page of the current mode, injected before the page's own scripts.
  func installBootstrap() {
    let ucc = web.configuration.userContentController
    ucc.removeAllUserScripts()
    ucc.addUserScript(WKUserScript(source: bootstrapJS(), injectionTime: .atDocumentStart, forMainFrameOnly: true))
  }

  /// Most medzi appkou a stránkou: window.__jarvisDesktop (okraje lišty a Docku, skratka, vyvolanie).
  func bootstrapJS() -> String {
    """
    (() => {
      const d = (window.__jarvisDesktop = window.__jarvisDesktop || {});
      d.native = true;
      d.version = 5;
      // 'desktop': Jarvis is the desktop under the windows. 'app': Jarvis in his own window.
      d.mode = '\(mode.rawValue)';
      // The microphone is opened by the app (a plain system input), not by the web view: the web
      // view's capture restarts the audio devices for every app and a call elsewhere loses its microphone.
      // The page sets d.onMicFrame(base64 of 1280 Int16 samples at 16 kHz, rms) and d.onMicState(state).
      d.mic = true;
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
      // What the menu bar icon offers, for the Settings sheet of the page: desktop icons and start at login.
      d.prefs = \(prefsJSON());
      d.setPref = (key, value) => d.post({ type: 'pref', key, value: !!value });
      d.prefsChanged = (prefs) => { d.prefs = prefs; emit({ type: 'prefs', prefs }); };
      d.dismiss = () => d.post({ type: 'dismiss' });
      // Jarvis moved (Settings, Plocha): the app follows to the desktop or to its window, or ends for a browser page.
      d.moved = (keep) => d.post({ type: 'moved', keep: String(keep || '') });
      d.leave = () => d.post({ type: 'leave' });
      d.summon = () => d.post({ type: 'raise' });
      d.fullscreen = () => d.post({ type: 'fullscreen' });
      if (d.mode === 'desktop') document.documentElement.classList.add('jarvis-desktop');
      d.setInsets(\(insetsJSON(currentInsets())));
    })();
    """
  }

  /// The two switches of the menu bar icon as JSON, for the page.
  func prefsJSON() -> String {
    "{\"icons\":\(desktopIconsVisible()),\"login\":\(loginItemEnabled())}"
  }

  func pushPrefs() {
    js("window.__jarvisDesktop && window.__jarvisDesktop.prefsChanged && window.__jarvisDesktop.prefsChanged(\(prefsJSON()))")
  }

  func load() {
    loading = true
    // A page that is loading again has no listener yet: the microphone is given back until it asks.
    mic.stop()
    let query = mode == .desktop ? "/?desktop=1" : "/?surface=app"
    var req = URLRequest(url: URL(string: HUD_ORIGIN + query)!)
    req.cachePolicy = .reloadIgnoringLocalCacheData
    req.timeoutInterval = 15
    web.load(req)
  }

  func reload() {
    log("obnovujem stránku")
    load()
  }

  func showStatus(_ text: String?) {
    statusLabel.stringValue = text ?? ""
    statusLabel.isHidden = text == nil
  }

  /// Connects the native microphone to the page (once): frames and state changes go to the bridge.
  func wireMic() {
    guard mic.onFrame == nil else { return }
    mic.onFrame = { [weak self] data, rms in
      let b64 = data.base64EncodedString()
      DispatchQueue.main.async {
        self?.js("window.__jarvisDesktop && window.__jarvisDesktop.onMicFrame && window.__jarvisDesktop.onMicFrame('\(b64)', \(rms))")
      }
    }
    mic.onState = { [weak self] state in
      DispatchQueue.main.async {
        log("mikrofón: \(state)")
        self?.js("window.__jarvisDesktop && window.__jarvisDesktop.onMicState && window.__jarvisDesktop.onMicState('\(state)')")
      }
    }
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
    // In his own window the title bar and the Dock are outside the page.
    if mode == .app { return NSEdgeInsetsZero }
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
    guard mode == .desktop, let window else { return }
    let f = screen.frame
    if window.frame != f {
      window.setFrame(f, display: true)
      log("nový rozmer obrazovky \(Int(f.width))x\(Int(f.height))")
    }
    pushInsets(force: true)
    writeWindowInfo()
  }

  func writeWindowInfo() {
    guard let window else { return }
    let info = "{\"windowNumber\":\(window.windowNumber),\"pid\":\(ProcessInfo.processInfo.processIdentifier),\"mode\":\"\(mode.rawValue)\"}"
    try? info.write(to: CACHE_DIR.appendingPathComponent("window.json"), atomically: true, encoding: .utf8)
  }

  // MARK: Vlastné okno: zatvorenie ho len schová

  /// The window of the app mode comes forward (also after it was closed or the app hidden).
  func showWindow() {
    guard let window else { return }
    NSApp.unhide(nil)
    if window.isMiniaturized { window.deminiaturize(nil) }
    window.makeKeyAndOrderFront(nil)
    NSApp.activate()
    window.makeFirstResponder(web)
  }

  /// Closing the window keeps Jarvis running: he still talks, rings and reminds, the window just goes away.
  func windowShouldClose(_ sender: NSWindow) -> Bool {
    guard mode == .app else { return false }
    // A full-screen window has its own Space: hiding the app leaves no empty Space behind.
    if sender.styleMask.contains(.fullScreen) { NSApp.hide(nil) } else { sender.orderOut(nil) }
    log("okno zatvorené, Jarvis beží ďalej")
    return false
  }

  func windowDidEnterFullScreen(_ notification: Notification) {
    if mode == .app { defaults.set(true, forKey: "fullScreen") }
  }

  func windowDidExitFullScreen(_ notification: Notification) {
    if mode == .app { defaults.set(false, forKey: "fullScreen") }
  }

  /// The Dock icon, Launchpad or `open` of the running app: the window comes back, the desktop comes above the windows.
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    if mode == .app { showWindow() } else { raise() }
    return false
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

  // MARK: Vyvolanie nad okná a návrat na plochu

  /// Is Jarvis in front right now (the window of the app mode is the key window)?
  var inFront: Bool {
    guard let window else { return false }
    return mode == .app ? NSApp.isActive && window.isVisible && window.isKeyWindow : raised
  }

  func raise() {
    if mode == .app { return showWindow() }
    if raised { return }
    guard let window else { return }
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
    if mode == .app {
      // A tap on the shortcut while the window is in front: back to whatever was there before.
      if reactivatePrevious { NSApp.hide(nil) }
      return
    }
    if !raised { return }
    guard let window else { return }
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
      let was = inFront
      if !was { raise() }
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

  /// GET /api/health: nil when the server does not answer.
  func fetchHealth(timeout: TimeInterval, _ done: @escaping @MainActor ([String: Any]?) -> Void) {
    var req = URLRequest(url: URL(string: HUD_ORIGIN + "/api/health")!)
    req.timeoutInterval = timeout
    URLSession.shared.dataTask(with: req) { data, resp, _ in
      let ok = (resp as? HTTPURLResponse)?.statusCode == 200
      let json = ok ? data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:] : nil
      Task { @MainActor in done(json) }
    }.resume()
  }

  func checkServer() {
    fetchHealth(timeout: 2.5) { [weak self] health in
      guard let self else { return }
      self.serverStatus(health != nil)
      // The server says where Jarvis lives (`surface`, the choice in Settings). The app follows it,
      // also when the page cannot hear it: a desktop covered by a full-screen window is put to sleep by the system.
      if let surface = health?["surface"] as? String { self.follow(surface) }
    }
  }

  /// Jarvis lives somewhere else now: the desktop and the window swap, a browser page means the app ends.
  func follow(_ surface: String) {
    guard started, !leaving else { return }
    switch surface {
    case Mode.desktop.rawValue: enter(.desktop)
    case Mode.app.rawValue: enter(.app)
    case "browser": leave(openBrowser: false)
    default: break
    }
  }

  /// The user chose a browser page for Jarvis: no start at login from here any more, the desktop
  /// icons come back and the app ends cleanly (launchd leaves a clean exit alone).
  func leave(openBrowser: Bool) {
    if leaving { return }
    leaving = true
    log(openBrowser ? "Jarvis býva v prehliadači, otváram stránku" : "sťahujem sa do prehliadača")
    mic.stop()
    defaults.set(false, forKey: "launchAtLogin")
    if loginItemEnabled() { setLoginItem(false) }
    if defaults.bool(forKey: "hideDesktopIcons") && !desktopIconsVisible() { setDesktopIcons(visible: true) }
    if openBrowser, let url = URL(string: "http://localhost:\(HUD_PORT)/") { NSWorkspace.shared.open(url) }
    NSApp.terminate(nil)
  }

  func serverStatus(_ ok: Bool) {
    if ok {
      if !serverOK { log("server HUD beží") }
      serverOK = true
      serverFails = 0
      if started && !pageLoaded && !loading { load() }
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
      log("server HUD nebeží a neviem ho spustiť (node: \(NODE_PATH), priečinok: \(JARVIS_REPO)). Spusti v priečinku Jarvisa: node scripts/hud.mjs")
      showStatus("Jarvis nebeží. V priečinku Jarvisa spusti: node scripts/hud.mjs")
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
    pushInsets()
    if mode == .desktop, let window, window.frame != screen.frame { refit() }
    // The server is asked every 3 s: is it there, and does Jarvis still live here.
    checkServer()
    dailyReload()
  }

  /// Nobody is looking at Jarvis right now: a fresh load does not interrupt anything.
  var unattended: Bool { mode == .app ? !NSApp.isActive : !raised }

  /// Raz denne o 4:00 čerstvé načítanie: nový kód HUD, uvoľnená pamäť WebKitu a čas v shaderoch
  /// (float32) nezačne po dňoch behu sekať.
  func dailyReload() {
    let c = Calendar.current.dateComponents([.year, .month, .day, .hour], from: Date())
    guard c.hour == 4, unattended else { return }
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
    log("stránka načítaná (\(mode.rawValue))")
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
    log("stránka sa nenačítala: \(error.localizedDescription)")
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
    decisionHandler(isHUDOrigin(origin) && frame.isMainFrame ? .grant : .deny)
  }

  /// The HUD's own address: http on 127.0.0.1 or localhost with the port of this Jarvis. Another local
  /// port is another program, an iframe (the video theater, a page Jarvis shows) is another site.
  func isHUDOrigin(_ origin: WKSecurityOrigin) -> Bool {
    let home = URL(string: HUD_ORIGIN)
    let port = home?.port ?? Int(HUD_PORT) ?? 4545
    return origin.protocol == (home?.scheme ?? "http") && (origin.host == "127.0.0.1" || origin.host == "localhost") && origin.port == port
  }

  // MARK: Správy zo stránky

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    // The bridge answers the HUD itself only: its main frame on its own address. A frame inside the page
    // (a video, a web page in the theater) can reach window.webkit too, and is ignored.
    guard message.frameInfo.isMainFrame, isHUDOrigin(message.frameInfo.securityOrigin) else {
      log("správa mostu z cudzieho rámca ignorovaná (\(message.frameInfo.securityOrigin.host))")
      return
    }
    guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
    switch type {
    case "dismiss": lower(reactivatePrevious: true)
    case "raise": raise()
    case "ready": pushInsets(force: true)
    case "log": log("stránka: \(body["text"] ?? "")")
    case "pref":
      // The Settings sheet flips the same switches the menu bar icon has.
      let on = (body["value"] as? Bool) ?? false
      switch body["key"] as? String {
      case "icons":
        defaults.set(!on, forKey: "hideDesktopIcons")
        setDesktopIcons(visible: on)
      case "login":
        defaults.set(on, forKey: "launchAtLogin")
        setLoginItem(on)
      default: break
      }
      pushPrefs()
    case "moved": follow((body["keep"] as? String) ?? "")
    // A page from before 2.0 says only that the desktop is not his place any more: the server knows where it is.
    case "leave": checkServer()
    case "fullscreen": if mode == .app { window?.toggleFullScreen(nil) }
    case "mic":
      wireMic()
      if (body["on"] as? Bool) ?? false { mic.start() } else { mic.stop() }
    case "notify":
      // The result of a background job: a notification the user sees over any window.
      let text = { (k: String, n: Int) -> String in String(((body[k] as? String) ?? "").prefix(n)) }
      notifyUser(title: text("title", 80).isEmpty ? "Jarvis" : text("title", 80), body: text("body", 220), job: body["job"] as? String, quiet: (body["quiet"] as? Bool) ?? false)
    case "control":
      // Jarvis is working the mouse, the keyboard or the browser: show where, above every window.
      let num = { (k: String) -> CGFloat? in (body[k] as? NSNumber).map { CGFloat(truncating: $0) } }
      control.update(on: (body["on"] as? Bool) ?? true, label: body["label"] as? String, x: num("x"), y: num("y"), click: (body["click"] as? Bool) ?? false)
    default: break
    }
  }

  // MARK: Hlavné menu (vo vlastnom okne v lište hore, na ploche len pre skratky)

  func buildMainMenu() {
    let main = NSMenu()
    func add(_ menu: NSMenu, _ title: String, _ action: Selector?, _ key: String, _ mods: NSEvent.ModifierFlags = [.command], target: AnyObject? = nil) {
      let it = NSMenuItem(title: title, action: action, keyEquivalent: key)
      it.keyEquivalentModifierMask = mods
      it.target = target
      menu.addItem(it)
    }
    func top(_ title: String, _ build: (NSMenu) -> Void) -> NSMenu {
      let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      let menu = NSMenu(title: title)
      build(menu)
      item.submenu = menu
      main.addItem(item)
      return menu
    }
    _ = top("Jarvis") { m in
      add(m, "O appke Jarvis", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), "")
      m.addItem(.separator())
      add(m, "Nastavenia…", #selector(menuSettings), ",", target: self)
      m.addItem(.separator())
      add(m, "Skryť Jarvisa", #selector(NSApplication.hide(_:)), "h")
      add(m, "Skryť ostatné", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option])
      add(m, "Zobraziť všetko", #selector(NSApplication.unhideAllApplications(_:)), "")
      m.addItem(.separator())
      add(m, "Ukončiť Jarvisa", #selector(menuQuit), "q", target: self)
    }
    _ = top("Upraviť") { m in
      add(m, "Späť", Selector(("undo:")), "z")
      add(m, "Znova", Selector(("redo:")), "z", [.command, .shift])
      m.addItem(.separator())
      add(m, "Vystrihnúť", #selector(NSText.cut(_:)), "x")
      add(m, "Kopírovať", #selector(NSText.copy(_:)), "c")
      add(m, "Vložiť", #selector(NSText.paste(_:)), "v")
      add(m, "Vybrať všetko", #selector(NSText.selectAll(_:)), "a")
    }
    _ = top("Zobraziť") { m in
      add(m, "Načítať Jarvisa znova", #selector(menuReload), "r", target: self)
      add(m, "Celá obrazovka", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control])
    }
    let windowMenu = top("Okno") { m in
      add(m, "Minimalizovať", #selector(NSWindow.performMiniaturize(_:)), "m")
      add(m, "Zväčšiť", #selector(NSWindow.performZoom(_:)), "")
      add(m, "Zavrieť", #selector(NSWindow.performClose(_:)), "w")
    }
    NSApp.mainMenu = main
    NSApp.windowsMenu = windowMenu
  }

  // MARK: Ikona v lište (len na ploche)

  func buildStatusItem() {
    if statusItem != nil { return }
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    item.button?.image = AppDelegate.menuIcon()
    item.button?.toolTip = "Jarvis"
    let menu = NSMenu()
    menu.delegate = self
    item.menu = menu
    statusItem = item
  }

  func removeStatusItem() {
    guard let item = statusItem else { return }
    NSStatusBar.system.removeStatusItem(item)
    statusItem = nil
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
    let head = NSMenuItem(title: serverOK ? "Jarvis beží na vašej ploche" : "Jarvis štartuje…", action: nil, keyEquivalent: "")
    head.isEnabled = false
    menu.addItem(head)
    menu.addItem(.separator())
    item(menu, "Ukázať Jarvisa nad oknami (\(HOTKEY_LABEL))", #selector(menuSummon)).toolTip = "Jarvis žije na ploche pod vašimi oknami. Toto ho vytiahne navrch, Esc ho vráti späť."
    item(menu, "Nastavenia Jarvisa…", #selector(menuSettings)).toolTip = "Hlas, oslovenie, počúvanie, tiché hodiny a plocha."
    menu.addItem(.separator())
    item(menu, "Zobrazovať ikony na ploche", #selector(menuIcons)).state = desktopIconsVisible() ? .on : .off
    item(menu, "Spúšťať po zapnutí počítača", #selector(menuLogin)).state = loginItemEnabled() ? .on : .off
    menu.addItem(.separator())
    item(menu, "Načítať Jarvisa znova", #selector(menuReload)).toolTip = "Keď sa niečo zasekne. Nič sa nestratí."
    item(menu, "Otvoriť ako stránku v prehliadači", #selector(menuBrowser))
    menu.addItem(.separator())
    item(menu, "Vypnúť Jarvisa a vrátiť pôvodnú plochu", #selector(menuQuit))
  }

  @discardableResult
  func item(_ menu: NSMenu, _ title: String, _ action: Selector) -> NSMenuItem {
    let it = NSMenuItem(title: title, action: action, keyEquivalent: "")
    it.target = self
    menu.addItem(it)
    return it
  }

  @objc func menuSummon() { raise() }
  @objc func menuSettings() {
    raise()
    js("window.dispatchEvent(new CustomEvent('jarvis-desktop', { detail: { type: 'settings' } }))")
  }
  @objc func menuReload() { reload() }

  @objc func menuBrowser() {
    NSWorkspace.shared.open(URL(string: "http://localhost:\(HUD_PORT)/")!)
  }

  @objc func menuIcons() {
    let show = !desktopIconsVisible()
    defaults.set(!show, forKey: "hideDesktopIcons")
    setDesktopIcons(visible: show)
    pushPrefs()
  }

  @objc func menuLogin() {
    let on = !loginItemEnabled()
    defaults.set(on, forKey: "launchAtLogin")
    setLoginItem(on)
    pushPrefs()
  }

  /// Quit from a menu or ⌘Q: the desktop gets its icons back. The HUD server keeps running.
  @objc func menuQuit() {
    if !desktopIconsVisible() && defaults.bool(forKey: "hideDesktopIcons") { setDesktopIcons(visible: true) }
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
          guard let self, self.unattended else { return }
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

// MARK: Oznámenia systému (výsledky úloh)

extension AppDelegate: UNUserNotificationCenterDelegate {
  /// A notification under the app's own name. Without the permission the system's scripting shows it instead.
  func notifyUser(title: String, body: String, job: String?, quiet: Bool) {
    let center = UNUserNotificationCenter.current()
    center.delegate = self
    center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
      guard granted else {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        p.arguments = ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", title, body]
        try? p.run()
        return
      }
      let content = UNMutableNotificationContent()
      content.title = title
      content.body = body
      if !quiet { content.sound = .default }
      if let job { content.userInfo = ["job": job] }
      UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }
  }

  /// Shown also while the HUD itself is in front.
  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .list, .sound])
  }

  /// A click on the notification brings the HUD forward and opens the job it was about.
  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let raw = (response.notification.request.content.userInfo["job"] as? String) ?? ""
    let job = String(raw.filter { $0.isLetter || $0.isNumber }.prefix(24))
    Task { @MainActor in
      self.raise()
      self.js("window.dispatchEvent(new CustomEvent('jarvis-desktop', { detail: { type: 'notify-open', job: \(job.isEmpty ? "null" : "'\(job)'") } }))")
    }
    completionHandler()
  }
}

// MARK: Rámik nad všetkými oknami, keď Jarvis ovláda počítač

/// A frame around the screen, a label and a reticle where Jarvis acts, drawn above every window.
/// It never takes a click and stays out of screenshots, so the agent does not see itself.
@MainActor
/// The microphone for the page: a plain capture of the default input device, no voice processing.
/// Delivers 16 kHz mono Int16 in frames of 1280 samples (80 ms) with their loudness (rms, 0 to 1).
/// Opening and closing it touches nothing but the input device, so a call in another app keeps going.
final class NativeMic: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
  static let frameBytes = 1280 * 2
  private let queue = DispatchQueue(label: "jarvis.desktop.mic")
  private var session: AVCaptureSession?
  private var deviceID: String?
  private var pending = Data()
  private var wanted = false
  var onFrame: ((Data, Float) -> Void)?
  var onState: ((String) -> Void)?

  func start() {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: queue.async { self.begin() }
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .audio) { ok in
        if ok { self.queue.async { self.begin() } } else { self.onState?("denied") }
      }
    default: onState?("denied")
    }
  }

  func stop() {
    queue.async {
      guard self.wanted || self.session?.isRunning == true else { return }
      self.wanted = false
      self.session?.stopRunning()
      self.pending.removeAll(keepingCapacity: true)
      self.onState?("off")
    }
  }

  /// The input to listen on. A Bluetooth headset's own microphone switches the headphones into their
  /// call mode (HFP: mono, 16 kHz, Jarvis sounds canned) for as long as it is open. When the default
  /// input is Bluetooth and the Mac has a built-in microphone, that one is used, so the headphones keep
  /// their full sound. The page does the same in the browser (public/js/mic-pick.js).
  nonisolated static func preferredDevice() -> AVCaptureDevice? {
    guard let def = AVCaptureDevice.default(for: .audio) else { return nil }
    func code(_ s: String) -> Int32 { Int32(bitPattern: s.utf8.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }) }
    guard [code("blue"), code("blea")].contains(def.transportType) else { return def }
    let mics = AVCaptureDevice.DiscoverySession(deviceTypes: [.microphone, .external], mediaType: .audio, position: .unspecified).devices
    return mics.first { $0.transportType == code("bltn") } ?? def
  }

  private func begin() {
    wanted = true
    guard let device = NativeMic.preferredDevice() else { return fail("no input device") }
    // Another default input since the last time (headphones plugged in): the session is built again.
    if session == nil || deviceID != device.uniqueID {
      session?.stopRunning()
      if let old = session { NotificationCenter.default.removeObserver(self, name: .AVCaptureSessionRuntimeError, object: old) }
      let fresh = AVCaptureSession()
      guard let input = try? AVCaptureDeviceInput(device: device), fresh.canAddInput(input) else { return fail("input refused") }
      let output = AVCaptureAudioDataOutput()
      output.audioSettings = [
        AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16000, AVNumberOfChannelsKey: 1,
        AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false,
        AVLinearPCMIsNonInterleaved: false,
      ]
      output.setSampleBufferDelegate(self, queue: queue)
      guard fresh.canAddOutput(output) else { return fail("output refused") }
      fresh.beginConfiguration()
      fresh.addInput(input)
      fresh.addOutput(output)
      fresh.commitConfiguration()
      NotificationCenter.default.addObserver(self, selector: #selector(runtimeError(_:)), name: .AVCaptureSessionRuntimeError, object: fresh)
      session = fresh
      deviceID = device.uniqueID
    }
    pending.removeAll(keepingCapacity: true)
    if session?.isRunning != true { session?.startRunning() }
    onState?(session?.isRunning == true ? "on" : "error")
  }

  private func fail(_ why: String) {
    log("mikrofón: \(why)")
    wanted = false
    session = nil
    deviceID = nil
    onState?("error")
  }

  /// The device went away while recording (unplugged headset): forget the session, the page asks again.
  @objc private func runtimeError(_ note: Notification) {
    queue.async { self.fail("runtime error \((note.userInfo?[AVCaptureSessionErrorKey] as? NSError)?.code ?? 0)") }
  }

  func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
    guard wanted, let block = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
    let length = CMBlockBufferGetDataLength(block)
    guard length > 0 else { return }
    var chunk = Data(count: length)
    let status = chunk.withUnsafeMutableBytes { raw -> OSStatus in
      guard let base = raw.baseAddress else { return -1 }
      return CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: base)
    }
    guard status == kCMBlockBufferNoErr else { return }
    pending.append(chunk)
    while pending.count >= NativeMic.frameBytes {
      let frame = pending.prefix(NativeMic.frameBytes)
      pending.removeFirst(NativeMic.frameBytes)
      var sum: Float = 0
      frame.withUnsafeBytes { raw in
        for v in raw.bindMemory(to: Int16.self) {
          let x = Float(Int16(littleEndian: v)) / 32768
          sum += x * x
        }
      }
      onFrame?(Data(frame), (sum / 1280).squareRoot())
    }
  }
}

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
