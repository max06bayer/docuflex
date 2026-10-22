// Docuflex OCR helper for macOS: renders PDF pages with Core Graphics and
// recognizes text with Apple's Vision framework (Neural Engine, on-device).
//
//   docuflex-vision-ocr <input.pdf> [--pages 0,2,5] [--languages de-DE,en-US] [--dpi 300]
//
// Prints JSON to stdout:
//   {"engine":"vision","pages":[{"index":0,"width":595,"height":842,
//     "words":[["text",blX,blY,brX,brY,tlX,tlY,confidence],...]}]}
// Points are in PDF points with a top-left origin on the page as displayed
// (crop box, /Rotate applied): the bottom-left, bottom-right and top-left
// corners of each word, so sideways or tilted text keeps its direction.

import CoreGraphics
import Foundation
import ImageIO
import Vision

struct Options {
  var input = ""
  var pages: [Int]? = nil
  var languages: [String] = []
  var dpi: Double = 300
}

struct Word: Encodable {
  let text: String
  let bottomLeft: CGPoint
  let bottomRight: CGPoint
  let topLeft: CGPoint
  let confidence: Float

  func encode(to encoder: Encoder) throws {
    var container = encoder.unkeyedContainer()
    try container.encode(text)
    for point in [bottomLeft, bottomRight, topLeft] {
      try container.encode((point.x * 100).rounded() / 100)
      try container.encode((point.y * 100).rounded() / 100)
    }
    try container.encode((Double(confidence) * 1000).rounded() / 1000)
  }
}

struct PageResult: Encodable {
  let index: Int
  let width: Double
  let height: Double
  let words: [Word]
}

struct Output: Encodable {
  let engine = "vision"
  let pages: [PageResult]
}

enum HelperError: Error, CustomStringConvertible {
  case usage(String)
  case unreadable
  case render(Int)

  var description: String {
    switch self {
    case .usage(let message): return message
    case .unreadable: return "The PDF could not be opened."
    case .render(let page): return "Page \(page + 1) could not be rendered."
    }
  }
}

func parseOptions() throws -> Options {
  var options = Options()
  var arguments = CommandLine.arguments.dropFirst()
  while let argument = arguments.popFirst() {
    switch argument {
    case "--pages":
      guard let value = arguments.popFirst() else { throw HelperError.usage("--pages needs a value.") }
      options.pages = value.split(separator: ",").compactMap { Int($0.trimmingCharacters(in: .whitespaces)) }
    case "--languages":
      guard let value = arguments.popFirst() else { throw HelperError.usage("--languages needs a value.") }
      options.languages = value.split(separator: ",").map { String($0) }.filter { !$0.isEmpty }
    case "--dpi":
      guard let value = arguments.popFirst(), let dpi = Double(value) else { throw HelperError.usage("--dpi needs a number.") }
      options.dpi = min(600, max(72, dpi))
    default:
      if argument.hasPrefix("-") || !options.input.isEmpty { throw HelperError.usage("Unknown argument: \(argument)") }
      options.input = argument
    }
  }
  if options.input.isEmpty { throw HelperError.usage("Usage: docuflex-vision-ocr <input.pdf> [--pages 0,1] [--languages en-US] [--dpi 300]") }
  return options
}

/// Renders a page the way PDF viewers show it: crop box, /Rotate applied, white paper.
/// Returns the image and the page's displayed size in points.
func renderPage(_ document: CGPDFDocument, index: Int, dpi: Double) throws -> (CGImage, CGSize) {
  guard let page = document.page(at: index + 1) else { throw HelperError.render(index) }
  let box = page.getBoxRect(.cropBox)
  let rotation = ((Int(page.rotationAngle) % 360) + 360) % 360
  let displaySize = rotation % 180 == 0 ? box.size : CGSize(width: box.height, height: box.width)
  // Keep huge pages (posters, plans) within Vision's comfortable working size.
  let longest = max(displaySize.width, displaySize.height)
  let scale = min(dpi / 72, 9000 / max(longest, 1))
  let width = max(1, Int((displaySize.width * scale).rounded()))
  let height = max(1, Int((displaySize.height * scale).rounded()))
  guard let context = CGContext(
    data: nil,
    width: width,
    height: height,
    bitsPerComponent: 8,
    bytesPerRow: 0,
    space: CGColorSpaceCreateDeviceGray(),
    bitmapInfo: CGImageAlphaInfo.none.rawValue
  ) else { throw HelperError.render(index) }
  context.setFillColor(gray: 1, alpha: 1)
  context.fill(CGRect(x: 0, y: 0, width: width, height: height))
  context.interpolationQuality = .high
  context.setShouldAntialias(true)
  // getDrawingTransform never scales up, so scale first and fit in points.
  context.scaleBy(x: CGFloat(width) / displaySize.width, y: CGFloat(height) / displaySize.height)
  context.concatenate(page.getDrawingTransform(.cropBox, rect: CGRect(origin: .zero, size: displaySize), rotate: 0, preserveAspectRatio: true))
  context.drawPDFPage(page)
  guard let image = context.makeImage() else { throw HelperError.render(index) }
  return (image, displaySize)
}

/// Maps "de" or "de-AT" onto what Vision offers ("de-DE"), keeping order.
func recognitionLanguages(_ identifiers: [String], supported: [String]) -> [String] {
  var usable: [String] = []
  for identifier in identifiers {
    let requested = Locale.Language(identifier: identifier)
    let candidates = supported.map { ($0, Locale.Language(identifier: $0)) }
    let match = candidates.first { $0.1.minimalIdentifier == requested.minimalIdentifier }
      ?? candidates.first { $0.1.languageCode == requested.languageCode && $0.1.script == requested.script }
      ?? candidates.first { $0.1.languageCode == requested.languageCode }
    if let match, !usable.contains(match.0) { usable.append(match.0) }
  }
  return usable
}

/// Vision recognizes rotated and tilted lines on its own; each word keeps the
/// corners Vision reports, converted from normalized bottom-left coordinates
/// to page points with a top-left origin.
///
/// This uses VNRecognizeTextRequest: the Swift-only RecognizeTextRequest
/// returns no text at all for some full-resolution scans.
func recognize(_ image: CGImage, size: CGSize, languages: [String]) throws -> [Word] {
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true
  let usable = recognitionLanguages(languages, supported: (try? request.supportedRecognitionLanguages()) ?? [])
  if usable.isEmpty {
    request.automaticallyDetectsLanguage = true
  } else {
    request.recognitionLanguages = usable
    request.automaticallyDetectsLanguage = usable.count > 1
  }
  try VNImageRequestHandler(cgImage: image).perform([request])
  let point = { (normalized: CGPoint) -> CGPoint in
    CGPoint(x: normalized.x * size.width, y: (1 - normalized.y) * size.height)
  }
  var words: [Word] = []
  for observation in request.results ?? [] {
    guard let candidate = observation.topCandidates(1).first else { continue }
    let line = candidate.string
    var ranges: [Range<String.Index>] = []
    var start: String.Index? = nil
    for index in line.indices {
      if line[index].isWhitespace {
        if let begin = start { ranges.append(begin..<index); start = nil }
      } else if start == nil {
        start = index
      }
    }
    if let begin = start { ranges.append(begin..<line.endIndex) }
    let lineBottomLeft = point(observation.bottomLeft)
    let lineBottomRight = point(observation.bottomRight)
    let lineTopLeft = point(observation.topLeft)
    let total = CGFloat(max(1, line.count))
    let along = CGPoint(x: lineBottomRight.x - lineBottomLeft.x, y: lineBottomRight.y - lineBottomLeft.y)
    let up = CGPoint(x: lineTopLeft.x - lineBottomLeft.x, y: lineTopLeft.y - lineBottomLeft.y)
    let lengthSquared = max(along.x * along.x + along.y * along.y, 0.0001)
    for range in ranges {
      // Where the word starts and ends along the line (0...1). Words are put
      // back on the line's own baseline: words that each carry a slightly
      // different tilt make viewers break a skewed line after every word.
      var from = CGFloat(line.distance(from: line.startIndex, to: range.lowerBound)) / total
      var to = CGFloat(line.distance(from: line.startIndex, to: range.upperBound)) / total
      if let box = try? candidate.boundingBox(for: range), ranges.count == 1 || box.boundingBox != observation.boundingBox {
        let project = { (normalized: CGPoint) -> CGFloat in
          let corner = point(normalized)
          return ((corner.x - lineBottomLeft.x) * along.x + (corner.y - lineBottomLeft.y) * along.y) / lengthSquared
        }
        from = min(project(box.bottomLeft), project(box.topLeft))
        to = max(project(box.bottomRight), project(box.topRight))
      }
      let bottomLeft = CGPoint(x: lineBottomLeft.x + along.x * from, y: lineBottomLeft.y + along.y * from)
      let corners = (
        bottomLeft,
        CGPoint(x: lineBottomLeft.x + along.x * to, y: lineBottomLeft.y + along.y * to),
        CGPoint(x: bottomLeft.x + up.x, y: bottomLeft.y + up.y)
      )
      let width = hypot(corners.1.x - corners.0.x, corners.1.y - corners.0.y)
      let height = hypot(corners.2.x - corners.0.x, corners.2.y - corners.0.y)
      guard width > 0.1, height > 0.1 else { continue }
      words.append(Word(text: String(line[range]), bottomLeft: corners.0, bottomRight: corners.1, topLeft: corners.2, confidence: candidate.confidence))
    }
  }
  return words
}

func run() throws {
  let options = try parseOptions()
  let url = URL(fileURLWithPath: options.input)
  guard let probe = CGPDFDocument(url as CFURL) else { throw HelperError.unreadable }
  if probe.isEncrypted && !probe.isUnlocked { _ = probe.unlockWithPassword("") }
  let pageCount = probe.numberOfPages
  let indices = (options.pages ?? Array(0..<pageCount)).filter { $0 >= 0 && $0 < pageCount }
  let workers = max(1, min(6, ProcessInfo.processInfo.activeProcessorCount, indices.count))

  let lock = NSLock()
  var results: [PageResult] = []
  var failure: Error? = nil
  var next = 0
  DispatchQueue.concurrentPerform(iterations: workers) { _ in
    // Each worker opens its own document: CGPDFDocument is not documented as
    // safe for concurrent drawing.
    guard let document = CGPDFDocument(url as CFURL) else {
      lock.withLock { failure = failure ?? HelperError.unreadable }
      return
    }
    if document.isEncrypted && !document.isUnlocked { _ = document.unlockWithPassword("") }
    while true {
      let position: Int? = lock.withLock {
        guard failure == nil, next < indices.count else { return nil }
        next += 1
        return next - 1
      }
      guard let position else { return }
      let index = indices[position]
      do {
        let page = try autoreleasepool { () throws -> PageResult in
          let (image, size) = try renderPage(document, index: index, dpi: options.dpi)
          var words = try recognize(image, size: size, languages: options.languages)
          // Vision now and then skips whole lines (or a whole page) at one
          // resolution and not at another, on handwriting most of all. A
          // second pass at a third more resolution catches that; the pass
          // that reads more text wins.
          let (sharper, _) = try renderPage(document, index: index, dpi: options.dpi * 4 / 3)
          let second = try recognize(sharper, size: size, languages: options.languages)
          let characters = { (list: [Word]) in list.reduce(0) { $0 + $1.text.count } }
          if Double(characters(second)) > Double(characters(words)) * 1.02 { words = second }
          return PageResult(index: index, width: Double(size.width), height: Double(size.height), words: words)
        }
        lock.withLock { results.append(page) }
      } catch {
        lock.withLock { failure = failure ?? error }
      }
    }
  }
  if let failure { throw failure }

  let encoder = JSONEncoder()
  encoder.outputFormatting = [.withoutEscapingSlashes]
  FileHandle.standardOutput.write(try encoder.encode(Output(pages: results.sorted { $0.index < $1.index })))
}

do {
  try run()
} catch {
  FileHandle.standardError.write("\(error)\n".data(using: .utf8)!)
  exit(1)
}
