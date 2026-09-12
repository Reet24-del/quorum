// Renders public/reel.html into an MP4, frame by frame, with the soundtrack muxed in.
// Apple frameworks only (WebKit + AVFoundation): no ffmpeg, no browser install.
//
//   swiftc -O -swift-version 5 demo/render.swift -o /tmp/render-reel
//   /tmp/render-reel frame <page-url> <seconds> <out.png>           one still, for checking
//   /tmp/render-reel video <page-url> <audio.m4a> <out.mp4> [fps]   the whole reel
//
// The page must expose renderAt(t), window.__reelReady and window.__reelDuration.

import AppKit
import AVFoundation
import WebKit

let W = 1920
let H = 1080

func fail(_ code: Int, _ message: String) -> NSError {
  NSError(domain: "reel", code: code, userInfo: [NSLocalizedDescriptionKey: message])
}

@MainActor
final class Page: NSObject, WKNavigationDelegate {
  let web: WKWebView
  let window: NSWindow
  private var onLoad: CheckedContinuation<Void, Error>?

  override init() {
    web = WKWebView(frame: NSRect(x: 0, y: 0, width: W, height: H))
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: W, height: H),
                      styleMask: [.borderless], backing: .buffered, defer: false)
    super.init()
    window.contentView = web
    // On the window server so WebKit keeps painting, but invisible and click-through.
    let alpha = Double(ProcessInfo.processInfo.environment["REEL_ALPHA"] ?? "") ?? 0.0
    window.alphaValue = CGFloat(alpha)
    window.ignoresMouseEvents = true
    window.orderFrontRegardless()
    web.navigationDelegate = self
  }

  func open(_ url: URL) async throws {
    try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
      onLoad = c
      web.load(URLRequest(url: url))
    }
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    onLoad?.resume(); onLoad = nil
  }
  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    onLoad?.resume(throwing: error); onLoad = nil
  }
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    onLoad?.resume(throwing: error); onLoad = nil
  }

  func js(_ source: String) async throws -> Any? {
    try await withCheckedThrowingContinuation { (c: CheckedContinuation<Any?, Error>) in
      web.evaluateJavaScript(source) { result, error in
        if let error { c.resume(throwing: error) } else { c.resume(returning: result) }
      }
    }
  }

  func waitReady() async throws -> Double {
    for _ in 0..<300 {
      if let ok = try? await js("window.__reelReady === true") as? Bool, ok {
        return (try await js("window.__reelDuration") as? Double) ?? 90
      }
      try await Task.sleep(nanoseconds: 100_000_000)
    }
    throw fail(2, "the page never became ready (fonts or data failed to load?)")
  }

  func frame(at t: Double) async throws -> CGImage {
    _ = try await js("renderAt(\(t)); true")
    let cfg = WKSnapshotConfiguration()
    cfg.rect = CGRect(x: 0, y: 0, width: W, height: H)
    cfg.snapshotWidth = NSNumber(value: W)
    let image: NSImage = try await withCheckedThrowingContinuation { (c: CheckedContinuation<NSImage, Error>) in
      web.takeSnapshot(with: cfg) { img, error in
        if let img { c.resume(returning: img) } else { c.resume(throwing: error ?? fail(3, "snapshot failed")) }
      }
    }
    guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
      throw fail(4, "the snapshot had no bitmap")
    }
    return cg
  }
}

func writePNG(_ cg: CGImage, to url: URL) throws {
  guard let data = NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:]) else {
    throw fail(5, "could not encode PNG")
  }
  try data.write(to: url)
}

@MainActor
func renderVideo(page: Page, audio: URL, out: URL, fps: Int, duration: Double) async throws {
  let silent = out.deletingPathExtension().appendingPathExtension("video-only.mp4")
  try? FileManager.default.removeItem(at: silent)

  let writer = try AVAssetWriter(outputURL: silent, fileType: .mp4)
  let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: W,
    AVVideoHeightKey: H,
    AVVideoCompressionPropertiesKey: [
      AVVideoAverageBitRateKey: 8_000_000,
      AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
      AVVideoMaxKeyFrameIntervalKey: fps * 2
    ]
  ])
  input.expectsMediaDataInRealTime = false
  let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    kCVPixelBufferWidthKey as String: W,
    kCVPixelBufferHeightKey as String: H
  ])
  writer.add(input)
  guard writer.startWriting() else { throw writer.error ?? fail(6, "writer would not start") }
  writer.startSession(atSourceTime: .zero)

  let space = CGColorSpace(name: CGColorSpace.sRGB)!
  let frames = Int((duration * Double(fps)).rounded())
  let started = Date()
  for i in 0..<frames {
    let cg = try await page.frame(at: Double(i) / Double(fps))
    while !input.isReadyForMoreMediaData { try await Task.sleep(nanoseconds: 2_000_000) }
    var pb: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &pb)
    guard let buf = pb else { throw fail(7, "no pixel buffer") }
    CVPixelBufferLockBaseAddress(buf, [])
    let ctx = CGContext(data: CVPixelBufferGetBaseAddress(buf), width: W, height: H, bitsPerComponent: 8,
                        bytesPerRow: CVPixelBufferGetBytesPerRow(buf), space: space,
                        bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
    ctx.interpolationQuality = .high
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: W, height: H))
    CVPixelBufferUnlockBaseAddress(buf, [])
    guard adaptor.append(buf, withPresentationTime: CMTime(value: CMTimeValue(i), timescale: CMTimeScale(fps))) else {
      throw writer.error ?? fail(8, "frame \(i) was rejected")
    }
    if i % (fps * 5) == 0 {
      print(String(format: "  frame %4d/%d   %2.0fs of video   %3.0fs elapsed",
                   i, frames, Double(i) / Double(fps), Date().timeIntervalSince(started)))
      fflush(stdout)
    }
  }
  input.markAsFinished()
  await writer.finishWriting()
  guard writer.status == .completed else { throw writer.error ?? fail(9, "video did not finish") }

  // Mux the H.264 video with the AAC soundtrack into one MP4, without re-encoding either.
  let comp = AVMutableComposition()
  let vAsset = AVURLAsset(url: silent)
  let aAsset = AVURLAsset(url: audio)
  let vDur = try await vAsset.load(.duration)
  let aDur = try await aAsset.load(.duration)
  guard let vt = try await vAsset.loadTracks(withMediaType: .video).first,
        let at = try await aAsset.loadTracks(withMediaType: .audio).first else {
    throw fail(10, "missing a video or audio track")
  }
  let cv = comp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)!
  try cv.insertTimeRange(CMTimeRange(start: .zero, duration: vDur), of: vt, at: .zero)
  let ca = comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)!
  try ca.insertTimeRange(CMTimeRange(start: .zero, duration: CMTimeMinimum(vDur, aDur)), of: at, at: .zero)

  try? FileManager.default.removeItem(at: out)
  guard let ex = AVAssetExportSession(asset: comp, presetName: AVAssetExportPresetPassthrough) else {
    throw fail(11, "could not create the export session")
  }
  ex.outputURL = out
  ex.outputFileType = .mp4
  await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in ex.exportAsynchronously { c.resume() } }
  guard ex.status == .completed else { throw ex.error ?? fail(12, "export did not complete") }
  try? FileManager.default.removeItem(at: silent)
}

@MainActor
func main() async {
  let a = CommandLine.arguments
  do {
    guard a.count >= 3, let url = URL(string: a[2]) else {
      throw fail(1, "usage: render-reel frame <url> <t> <out.png> | video <url> <audio.m4a> <out.mp4> [fps]")
    }
    let page = Page()
    try await page.open(url)
    let duration = try await page.waitReady()
    switch a[1] {
    case "frame":
      guard a.count >= 5, let t = Double(a[3]) else { throw fail(1, "frame needs <t> <out.png>") }
      let cg = try await page.frame(at: t)
      try writePNG(cg, to: URL(fileURLWithPath: a[4]))
      print("wrote \(a[4]) (\(cg.width)x\(cg.height))")
    case "video":
      guard a.count >= 5 else { throw fail(1, "video needs <audio.m4a> <out.mp4>") }
      let fps = a.count > 5 ? (Int(a[5]) ?? 30) : 30
      try await renderVideo(page: page, audio: URL(fileURLWithPath: a[3]),
                            out: URL(fileURLWithPath: a[4]), fps: fps, duration: duration)
      print("wrote \(a[4])")
    default:
      throw fail(1, "unknown mode \(a[1])")
    }
    exit(0)
  } catch {
    print("error: \(error.localizedDescription)")
    exit(1)
  }
}

NSApplication.shared.setActivationPolicy(.prohibited)
Task { @MainActor in await main() }
NSApplication.shared.run()
