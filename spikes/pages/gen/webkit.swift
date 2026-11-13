// Run check.html in WKWebView, the engine Tauri uses on macOS, and print window.RESULT.
// usage: swift gen/webkit.swift <url> [alpha]
import AppKit
import WebKit
let url = URL(string: CommandLine.arguments[1])!
let alpha = CommandLine.arguments.count > 2 ? CGFloat(Double(CommandLine.arguments[2])!) : 1
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let win = NSWindow(contentRect: NSRect(x: 40, y: 40, width: 1280, height: 800), styleMask: [.titled], backing: .buffered, defer: false)
win.alphaValue = alpha
let web = WKWebView(frame: win.contentView!.bounds)
win.contentView!.addSubview(web)
win.orderFrontRegardless()
web.load(URLRequest(url: url))
let start = Date()
if let shot = ProcessInfo.processInfo.environment["SHOT"] {
    Timer.scheduledTimer(withTimeInterval: 15, repeats: false) { _ in
        web.takeSnapshot(with: nil) { img, err in
            if let img = img, let t = img.tiffRepresentation, let b = NSBitmapImageRep(data: t), let png = b.representation(using: .png, properties: [:]) { try? png.write(to: URL(fileURLWithPath: shot)) }
            else { FileHandle.standardError.write("snapshot failed \(String(describing: err))\n".data(using: .utf8)!) }
        }
    }
}
Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
    web.evaluateJavaScript(CommandLine.arguments.count > 4 ? CommandLine.arguments[4] : "window.RESULT ? JSON.stringify(window.RESULT) : (document.getElementById('out')||{}).textContent") { v, e in
        if let s = v as? String, s.hasPrefix("{") { print(s); exit(0) }
        let el = Int(Date().timeIntervalSince(start))
        if el % 5 == 0, CommandLine.arguments.count > 3 { FileHandle.standardError.write("\(el)s: \(v ?? "nil") \(e.map { "\($0)" } ?? "")\n".data(using: .utf8)!) }
        if Date().timeIntervalSince(start) > 400 { print("timeout", v ?? "", e ?? ""); exit(1) }
    }
}
app.run()
