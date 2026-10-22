import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.awt.image.BufferedImage;
import java.awt.image.ConvolveOp;
import java.awt.image.Kernel;
import java.awt.geom.AffineTransform;
import java.awt.geom.NoninvertibleTransformException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.Deque;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.WeakHashMap;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import org.apache.pdfbox.contentstream.operator.Operator;
import org.apache.pdfbox.cos.COSArray;
import org.apache.pdfbox.cos.COSBase;
import org.apache.pdfbox.cos.COSDictionary;
import org.apache.pdfbox.cos.COSFloat;
import org.apache.pdfbox.cos.COSInteger;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.cos.COSNumber;
import org.apache.pdfbox.cos.COSString;
import org.apache.pdfbox.pdfparser.PDFStreamParser;
import org.apache.pdfbox.pdfwriter.ContentStreamWriter;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDResources;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.common.PDStream;
import org.apache.pdfbox.pdmodel.font.PDFont;
import org.apache.pdfbox.pdmodel.font.PDFontDescriptor;
import org.apache.pdfbox.pdmodel.font.PDSimpleFont;
import org.apache.pdfbox.pdmodel.font.PDType0Font;
import org.apache.pdfbox.pdmodel.font.PDType1Font;
import org.apache.pdfbox.pdmodel.font.Standard14Fonts;
import org.apache.pdfbox.pdmodel.encryption.AccessPermission;
import org.apache.pdfbox.pdmodel.encryption.StandardProtectionPolicy;
import org.apache.pdfbox.pdmodel.font.encoding.Encoding;
import org.apache.pdfbox.pdmodel.font.encoding.GlyphList;
import org.apache.pdfbox.pdmodel.graphics.PDXObject;
import org.apache.pdfbox.pdmodel.graphics.image.JPEGFactory;
import org.apache.pdfbox.pdmodel.graphics.image.LosslessFactory;
import org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject;
import org.apache.pdfbox.pdmodel.graphics.form.PDFormXObject;
import org.apache.pdfbox.pdmodel.graphics.blend.BlendMode;
import org.apache.pdfbox.pdmodel.graphics.state.PDExtendedGraphicsState;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAppearanceCharacteristicsDictionary;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAppearanceDictionary;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAppearanceEntry;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAppearanceStream;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAnnotation;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAnnotationHighlight;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAnnotationMarkup;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAnnotationText;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAnnotationWidget;
import org.apache.pdfbox.pdmodel.interactive.form.PDAcroForm;
import org.apache.pdfbox.pdmodel.interactive.form.PDCheckBox;
import org.apache.pdfbox.pdmodel.interactive.form.PDField;
import org.apache.pdfbox.pdmodel.interactive.form.PDTerminalField;
import org.apache.pdfbox.pdmodel.interactive.form.PDTextField;
import org.apache.pdfbox.pdmodel.graphics.color.PDColor;
import org.apache.pdfbox.pdmodel.graphics.color.PDDeviceRGB;
import org.apache.pdfbox.util.Matrix;
import org.apache.pdfbox.rendering.ImageType;
import org.apache.pdfbox.rendering.PDFRenderer;
import org.apache.pdfbox.Loader;

public class DocuflexPdfServer {
  private static final int PORT = environmentInt("PDF_BACKEND_PORT", 8080);
  private static final String HOST = environmentString("PDF_BACKEND_HOST", "127.0.0.1");
  private static final int MAX_REQUEST_BYTES = 225 * 1024 * 1024;
  private static final int MAX_PDF_BYTES = 150 * 1024 * 1024;
  private static final int MAX_RESPONSE_BYTES = 300 * 1024 * 1024;
  private static final int MAX_PDF_PAGES = 2000;
  private static final int MAX_JSON_DEPTH = 64;
  private static final float EDITOR_PAGE_SCALE = 1.42f;

  public static void main(String[] args) throws IOException {
    HttpServer server = HttpServer.create(new InetSocketAddress(HOST, PORT), 0);
    server.createContext("/health", DocuflexPdfServer::handleHealth);
    server.createContext("/edit", DocuflexPdfServer::handleEdit);
    server.createContext("/fonts", DocuflexPdfServer::handleFonts);
    server.createContext("/installed-font", DocuflexPdfServer::handleInstalledFont);
    server.createContext("/decrypt", DocuflexPdfServer::handleDecrypt);
    server.createContext("/uncrop", DocuflexPdfServer::handleUncrop);
    server.createContext("/pages", DocuflexPdfServer::handlePages);
    server.createContext("/export", DocuflexPdfServer::handleExport);
    server.createContext("/ocr-layer", DocuflexPdfServer::handleOcrLayer);
    server.setExecutor(new ThreadPoolExecutor(
        2,
        4,
        60,
        TimeUnit.SECONDS,
        new ArrayBlockingQueue<>(8),
        new ThreadPoolExecutor.AbortPolicy()));
    server.start();
    System.out.println("Docuflex PDFBox server listening on http://" + HOST + ":" + PORT);
  }

  private static void handleHealth(HttpExchange exchange) throws IOException {
    addCors(exchange);
    if ("OPTIONS".equals(exchange.getRequestMethod())) {
      sendNoContent(exchange);
      return;
    }
    if (!"GET".equals(exchange.getRequestMethod())) {
      sendJson(exchange, 405, "{\"error\":\"GET required\"}");
      return;
    }
    sendJson(exchange, 200, "{\"ok\":true}");
  }

  private static void handleEdit(HttpExchange exchange) throws IOException {
    addCors(exchange);
    if ("OPTIONS".equals(exchange.getRequestMethod())) {
      sendNoContent(exchange);
      return;
    }
    if (!"POST".equals(exchange.getRequestMethod())) {
      sendJson(exchange, 405, "{\"error\":\"POST required\"}");
      return;
    }

    try {
      String body = readRequestBody(exchange);
      Map<String, Object> payload = asObject(new JsonParser(body).parse());
      String pdfBase64 = asString(payload.get("pdfBase64"));
      List<Object> rawEdits = asArray(payload.get("edits"));
      List<TextEdit> edits = parseEdits(rawEdits);
      List<ImageEdit> imageEdits = parseImageEdits(rawEdits);

      EditResult result = applyEdits(decodePdf(pdfBase64), edits, imageEdits);
      String response = "{"
          + "\"pdfBase64\":\"" + escapeJson(Base64.getEncoder().encodeToString(result.pdfBytes)) + "\","
          + "\"applied\":" + result.applied + ","
          + "\"misses\":" + result.missesJson() + ","
          + "\"missedEditIndices\":" + result.missedEditIndicesJson()
          + "}";
      sendJson(exchange, 200, response);
    } catch (Exception error) {
      sendFailure(exchange, error, "Could not apply the requested PDF edits.");
    }
  }

  /** GET /installed-font?name=ArialMT: the installed font as TrueType, or 404. */
  private static void handleInstalledFont(HttpExchange exchange) throws IOException {
    addCors(exchange);
    if (!"GET".equals(exchange.getRequestMethod())) {
      sendJson(exchange, 405, "{\"error\":\"GET required\"}");
      return;
    }
    String query = exchange.getRequestURI().getRawQuery();
    String name = "";
    if (query != null) {
      for (String part : query.split("&")) {
        if (part.startsWith("name=")) name = java.net.URLDecoder.decode(part.substring(5), StandardCharsets.UTF_8);
      }
    }
    if (!name.matches("[A-Za-z0-9+_.,-]{1,128}")) {
      sendJson(exchange, 400, "{\"error\":\"Invalid font name.\"}");
      return;
    }
    try {
      byte[] font = installedFontFile(name);
      if (font == null) {
        sendJson(exchange, 404, "{\"error\":\"Font not installed.\"}");
        return;
      }
      exchange.getResponseHeaders().set("Content-Type", "font/ttf");
      exchange.getResponseHeaders().set("Cache-Control", "private, max-age=3600");
      exchange.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
      exchange.sendResponseHeaders(200, font.length);
      try (OutputStream response = exchange.getResponseBody()) {
        response.write(font);
      }
    } catch (Exception error) {
      sendFailure(exchange, error, "Could not read the installed font.");
    }
  }

  private static void handleFonts(HttpExchange exchange) throws IOException {
    addCors(exchange);
    if ("OPTIONS".equals(exchange.getRequestMethod())) {
      sendNoContent(exchange);
      return;
    }
    if (!"POST".equals(exchange.getRequestMethod())) {
      sendJson(exchange, 405, "{\"error\":\"POST required\"}");
      return;
    }

    try {
      String body = readRequestBody(exchange);
      Map<String, Object> payload = asObject(new JsonParser(body).parse());
      String pdfBase64 = asString(payload.get("pdfBase64"));
      FontExtractResult result = extractFonts(decodePdf(pdfBase64));
      sendJson(exchange, 200, result.toJson());
    } catch (Exception error) {
      sendFailure(exchange, error, "Could not extract fonts from this PDF.");
    }
  }

  private static void handleExport(HttpExchange exchange) throws IOException {
    addCors(exchange);
    if ("OPTIONS".equals(exchange.getRequestMethod())) {
      sendNoContent(exchange);
      return;
    }
    if (!"POST".equals(exchange.getRequestMethod())) {
      sendJson(exchange, 405, "{\"error\":\"POST required\"}");
      return;
    }

    try {
      String body = readRequestBody(exchange);
      Map<String, Object> payload = asObject(new JsonParser(body).parse());
      byte[] pdfBytes = decodePdf(asString(payload.get("pdfBase64")));
      List<AnnotationStroke> annotations = parseAnnotations(asArray(payload.get("annotations")));
      String sourcePassword = optionalString(payload.get("sourcePassword"));
      String encryptionPassword = optionalString(payload.get("encryptionPassword"));
      if (encryptionPassword.getBytes(StandardCharsets.UTF_8).length > 32) {
        throw new IllegalArgumentException("Encryption password must be 32 bytes or fewer.");
      }
      boolean printCopy = Boolean.TRUE.equals(payload.get("printCopy"));
      List<Object> formValues = payload.get("formValues") instanceof List<?> ? asArray(payload.get("formValues")) : List.of();
      List<PageCommentData> comments = parseComments(payload.get("comments"));
      List<PdfReplyData> pdfReplies = parsePdfReplies(payload.get("commentReplies"));
      boolean incremental = Boolean.TRUE.equals(payload.get("incremental"));
      byte[] exported;
      boolean redacting = annotations.stream().anyMatch((annotation) ->
          "blackout".equals(annotation.type) || "whiteout".equals(annotation.type));
      if (redacting && (incremental || !formValues.isEmpty())) {
        // An incremental save keeps the original bytes in the file.
        throw new IllegalArgumentException("Redactions need a full save, not an incremental one.");
      }
      if (incremental || !formValues.isEmpty()) {
        exported = applyAllowedChangesIncremental(pdfBytes, formValues, comments, pdfReplies);
      } else if (annotations.isEmpty() && comments.isEmpty() && pdfReplies.isEmpty() && sourcePassword.isEmpty() && encryptionPassword.isEmpty() && !printCopy) {
        exported = pdfBytes;
      } else {
        exported = applyAnnotations(pdfBytes, annotations, comments, pdfReplies, sourcePassword, encryptionPassword, printCopy);
      }
      sendPdf(exchange, exported);
    } catch (Exception error) {
      sendFailure(exchange, error, "Could not export this PDF.");
    }
  }

  /**
   * OCR support. "inspect" reports, per page, how much text the page already
   * has and how much of it is covered by images, so the caller only
   * recognizes scanned pages. "apply" lays the recognized words over the
   * original pages as invisible text: the pages themselves are not touched,
   * so the document looks exactly as before and stays as sharp and as small.
   */
  private static void handleOcrLayer(HttpExchange exchange) throws IOException {
    addCors(exchange);
    if ("OPTIONS".equals(exchange.getRequestMethod())) {
      sendNoContent(exchange);
      return;
    }
    if (!"POST".equals(exchange.getRequestMethod())) {
      sendJson(exchange, 405, "{\"error\":\"POST required\"}");
      return;
    }

    try {
      String body = readRequestBody(exchange);
      Map<String, Object> payload = asObject(new JsonParser(body).parse());
      String action = asString(payload.get("action"));
      byte[] pdfBytes = decodePdf(asString(payload.get("pdfBase64")));
      try (PDDocument document = loadPdf(pdfBytes)) {
        if ("inspect".equals(action)) {
          sendJson(exchange, 200, inspectOcrPages(document));
        } else if ("apply".equals(action)) {
          assertEditable(document);
          for (Object pageValue : asArray(payload.get("pages"))) {
            Map<String, Object> pageData = asObject(pageValue);
            int pageIndex = asInt(pageData.get("index"));
            if (pageIndex < 0 || pageIndex >= document.getNumberOfPages()) {
              throw new IllegalArgumentException("Invalid OCR page index.");
            }
            addOcrTextLayer(document, pageIndex, pageData);
          }
          ByteArrayOutputStream output = new ByteArrayOutputStream();
          document.save(output);
          sendPdf(exchange, output.toByteArray());
        } else {
          throw new IllegalArgumentException("Unknown OCR action.");
        }
      }
    } catch (Exception error) {
      sendFailure(exchange, error, "Could not add the recognized text.");
    }
  }

  private static String inspectOcrPages(PDDocument document) throws IOException {
    int pageCount = document.getNumberOfPages();
    int[] characters = new int[pageCount];
    org.apache.pdfbox.text.PDFTextStripper stripper = new org.apache.pdfbox.text.PDFTextStripper() {
      @Override
      protected void processTextPosition(org.apache.pdfbox.text.TextPosition text) {
        String unicode = text.getUnicode();
        if (unicode != null && !unicode.isBlank()) characters[getCurrentPageNo() - 1] += 1;
      }
    };
    stripper.getText(document);
    StringBuilder json = new StringBuilder("{\"pages\":[");
    for (int index = 0; index < pageCount; index += 1) {
      if (index > 0) json.append(',');
      json.append("{\"characters\":").append(characters[index])
          .append(",\"imageCoverage\":")
          .append(String.format(Locale.ROOT, "%.3f", imageCoverage(document.getPage(index))))
          .append('}');
    }
    return json.append("]}").toString();
  }

  /** The share of the crop box covered by images (0..1), counting overlapping images once per pixel row at most. */
  private static double imageCoverage(PDPage page) throws IOException {
    PDRectangle box = page.getCropBox();
    double pageArea = Math.max(1, (double) box.getWidth() * box.getHeight());
    double[] covered = {0};
    org.apache.pdfbox.contentstream.PDFGraphicsStreamEngine engine = new org.apache.pdfbox.contentstream.PDFGraphicsStreamEngine(page) {
      private final java.awt.geom.Point2D.Float current = new java.awt.geom.Point2D.Float();

      @Override
      public void drawImage(org.apache.pdfbox.pdmodel.graphics.image.PDImage image) {
        Matrix ctm = getGraphicsState().getCurrentTransformationMatrix();
        double left = Double.MAX_VALUE, bottom = Double.MAX_VALUE, right = -Double.MAX_VALUE, top = -Double.MAX_VALUE;
        for (double[] corner : new double[][] {{0, 0}, {1, 0}, {0, 1}, {1, 1}}) {
          double x = ctm.getScaleX() * corner[0] + ctm.getShearX() * corner[1] + ctm.getTranslateX();
          double y = ctm.getShearY() * corner[0] + ctm.getScaleY() * corner[1] + ctm.getTranslateY();
          left = Math.min(left, x);
          right = Math.max(right, x);
          bottom = Math.min(bottom, y);
          top = Math.max(top, y);
        }
        double width = Math.min(right, box.getUpperRightX()) - Math.max(left, box.getLowerLeftX());
        double height = Math.min(top, box.getUpperRightY()) - Math.max(bottom, box.getLowerLeftY());
        if (width > 0 && height > 0) covered[0] += width * height;
      }

      @Override public void appendRectangle(java.awt.geom.Point2D p0, java.awt.geom.Point2D p1, java.awt.geom.Point2D p2, java.awt.geom.Point2D p3) {}
      @Override public void clip(int windingRule) {}
      @Override public void moveTo(float x, float y) { current.setLocation(x, y); }
      @Override public void lineTo(float x, float y) { current.setLocation(x, y); }
      @Override public void curveTo(float x1, float y1, float x2, float y2, float x3, float y3) { current.setLocation(x3, y3); }
      @Override public java.awt.geom.Point2D getCurrentPoint() { return current; }
      @Override public void closePath() {}
      @Override public void endPath() {}
      @Override public void strokePath() {}
      @Override public void fillPath(int windingRule) {}
      @Override public void fillAndStrokePath(int windingRule) {}
      @Override public void shadingFill(COSName shadingName) {}
    };
    engine.processPage(page);
    return Math.min(1, covered[0] / pageArea);
  }

  /**
   * Adds one page's recognized words as invisible text. Each word arrives as
   * [text, bottomLeftX, bottomLeftY, bottomRightX, bottomRightY, topLeftX,
   * topLeftY, confidence] in the engine's coordinates (top-left origin over
   * the displayed page of the given width and height), so sideways and
   * tilted words keep their direction. Words lying on text the page already
   * has are skipped, which keeps mixed pages and repeated OCR runs free of
   * duplicates.
   */
  private static void addOcrTextLayer(PDDocument document, int pageIndex, Map<String, Object> pageData) throws IOException {
    PDPage page = document.getPage(pageIndex);
    float[] display = displaySize(page);
    double scaleX = display[0] / Math.max(0.0001, asDouble(pageData.get("width")));
    double scaleY = display[1] / Math.max(0.0001, asDouble(pageData.get("height")));
    List<double[]> existing = new ArrayList<>();
    for (PageGlyph glyph : pageGlyphs(document, pageIndex, page)) existing.add(glyph.bounds());

    List<Object> words = asArray(pageData.get("words"));
    List<String> texts = new ArrayList<>();
    List<double[]> geometry = new ArrayList<>();
    for (Object wordValue : words) {
      List<Object> word = asArray(wordValue);
      if (word.size() < 7) continue;
      String text = asString(word.get(0)).strip();
      if (text.isEmpty() || text.length() > 512) continue;
      double[] points = new double[6];
      for (int index = 0; index < 6; index += 1) {
        points[index] = asDouble(word.get(index + 1)) * (index % 2 == 0 ? scaleX : scaleY);
        if (!Double.isFinite(points[index])) throw new IllegalArgumentException("Invalid OCR word geometry.");
      }
      double[] bounds = {
          Math.min(Math.min(points[0], points[2]), points[4]),
          Math.min(Math.min(points[1], points[3]), points[5]),
          Math.max(Math.max(points[0], points[2]), points[4]),
          Math.max(Math.max(points[1], points[3]), points[5])};
      if (coveredByExistingText(bounds, existing)) continue;
      texts.add(text);
      geometry.add(points);
    }
    if (texts.isEmpty()) return;

    // The words are written in display space with y flipped (y up); this
    // matrix maps that space onto the page's user space, crop box offset and
    // /Rotate included.
    PdfPoint origin = normalizedToPdfPoint(page, new NormalizedPoint(0, 1));
    PdfPoint right = normalizedToPdfPoint(page, new NormalizedPoint(1, 1));
    PdfPoint top = normalizedToPdfPoint(page, new NormalizedPoint(0, 0));
    Matrix displayToUser = new Matrix(
        (right.x - origin.x) / display[0], (right.y - origin.y) / display[0],
        (top.x - origin.x) / display[1], (top.y - origin.y) / display[1],
        origin.x, origin.y);

    PDFont base = new PDType1Font(Standard14Fonts.FontName.HELVETICA);
    try (PDPageContentStream content = new PDPageContentStream(
        document, page, PDPageContentStream.AppendMode.APPEND, true, true)) {
      content.transform(displayToUser);
      content.beginText();
      content.setRenderingMode(org.apache.pdfbox.pdmodel.graphics.state.RenderingMode.NEITHER);
      // One font size per line, chosen so the line's words fill their boxes
      // at their natural proportions: a size taken from the (padded) box
      // height alone needs so much negative spacing that viewers split the
      // words into single letters.
      List<List<FontRun>> wordRuns = new ArrayList<>();
      double[] naturals = new double[texts.size()];
      for (int index = 0; index < texts.size(); index += 1) {
        List<FontRun> runs = fontRuns(document, base, texts.get(index));
        for (FontRun run : runs) naturals[index] += run.font().getStringWidth(run.text()) / 1000.0;
        wordRuns.add(runs);
      }
      double[] lineSizes = new double[texts.size()];
      for (int start = 0; start < texts.size();) {
        int end = start + 1;
        while (end < texts.size() && sameOcrLine(geometry.get(end - 1), geometry.get(end))) end += 1;
        double widths = 0, natural = 0, lineHeight = 0;
        for (int index = start; index < end; index += 1) {
          double[] points = geometry.get(index);
          widths += Math.hypot(points[2] - points[0], points[3] - points[1]);
          natural += naturals[index];
          lineHeight = Math.max(lineHeight, Math.abs(ocrWordHeight(points)));
        }
        double fit = natural > 0 ? widths / natural : lineHeight;
        Arrays.fill(lineSizes, start, end, Math.max(lineHeight * 0.5, Math.min(lineHeight, fit)));
        start = end;
      }
      for (int index = 0; index < texts.size(); index += 1) {
        double[] points = geometry.get(index);
        double width = Math.hypot(points[2] - points[0], points[3] - points[1]);
        if (!(width > 0)) continue;
        // Unit vectors along the baseline and up from it (perpendicular, in
        // the y-down display space).
        double alongX = (points[2] - points[0]) / width, alongY = (points[3] - points[1]) / width;
        double upX = alongY, upY = -alongX;
        double height = ocrWordHeight(points);
        if (height < 0) {
          upX = -upX;
          upY = -upY;
          height = -height;
        }
        if (!(height > 0)) continue;
        String word = texts.get(index);
        List<FontRun> runs = wordRuns.get(index);
        double natural = naturals[index];
        if (!(natural > 0)) continue;
        boolean lineContinues = index + 1 < texts.size() && sameOcrLine(points, geometry.get(index + 1));
        double[] next = lineContinues ? geometry.get(index + 1) : null;
        double gap = next == null ? 0 : (next[0] - points[2]) * alongX + (next[1] - points[3]) * alongY;
        // The glyphs keep their proportions (viewers such as pdf.js only
        // follow rotated lines when text is not stretched) and character
        // spacing between them makes the word as wide as its box.
        double size = lineSizes[index];
        // Viewers find word breaks from the gap after a word's last glyph; a
        // word that ends right where the next begins would run into it.
        if (next != null) width = Math.max(width * 0.5, Math.min(width, width + gap - size * 0.15));
        int characters = word.codePointCount(0, word.length());
        // Wider spacing than a fiftieth of the size reads as spaces inside the word.
        double spacing = characters > 1 ? Math.min(size * 0.02, (width - natural * size) / (characters - 1)) : 0;
        width = natural * size + spacing * Math.max(0, characters - 1);
        // Helvetica sits about a fifth of its size below the baseline: lift the
        // baseline so the glyph cells line up with the word's box.
        double baseX = points[0] + upX * height * 0.2, baseY = points[1] + upY * height * 0.2;
        content.setTextMatrix(new Matrix(
            (float) alongX, (float) -alongY,
            (float) upX, (float) -upY,
            (float) baseX, (float) (display[1] - baseY)));
        content.setCharacterSpacing((float) spacing);
        for (int runIndex = 0; runIndex < runs.size(); runIndex += 1) {
          FontRun run = runs.get(runIndex);
          content.setFont(run.font(), (float) size);
          if (runIndex + 1 < runs.size()) {
            content.showText(run.text());
            continue;
          }
          // No spacing after the last glyph: it would shift where the word ends.
          int last = run.text().offsetByCodePoints(run.text().length(), -1);
          if (last > 0) content.showText(run.text().substring(0, last));
          content.setCharacterSpacing(0);
          content.showText(run.text().substring(last));
        }
        // A space after each word (except at the end of a line) lets viewers
        // copy and search the text with its word breaks. It reaches exactly to
        // the next word, which viewers read as one gap.
        if (next != null) {
          content.setFont(base, (float) size);
          content.setCharacterSpacing((float) (gap + (points[2] - points[0]) * alongX + (points[3] - points[1]) * alongY
              - width - base.getStringWidth(" ") / 1000.0 * size));
          content.showText(" ");
        }
      }
      content.endText();
    }
  }

  /** A word's height measured perpendicular to its baseline, signed by which side its top lies on. */
  private static double ocrWordHeight(double[] points) {
    double width = Math.hypot(points[2] - points[0], points[3] - points[1]);
    if (!(width > 0)) return 0;
    double upX = (points[3] - points[1]) / width, upY = -(points[2] - points[0]) / width;
    return (points[4] - points[0]) * upX + (points[5] - points[1]) * upY;
  }

  /** True when the next word continues the same line: it starts near this word's end along the same baseline. */
  private static boolean sameOcrLine(double[] word, double[] next) {
    double advanceX = word[2] - word[0], advanceY = word[3] - word[1];
    double length = Math.hypot(advanceX, advanceY);
    double height = Math.hypot(word[4] - word[0], word[5] - word[1]);
    if (!(length > 0) || !(height > 0)) return false;
    double unitX = advanceX / length, unitY = advanceY / length;
    double deltaX = next[0] - word[2], deltaY = next[1] - word[3];
    double along = deltaX * unitX + deltaY * unitY;
    double across = Math.abs(-deltaX * unitY + deltaY * unitX);
    return along > -height && along < height * 4 && across < height * 0.6;
  }

  private static boolean coveredByExistingText(double[] bounds, List<double[]> existing) {
    double area = (bounds[2] - bounds[0]) * (bounds[3] - bounds[1]);
    if (!(area > 0) || existing.isEmpty()) return false;
    double covered = 0;
    for (double[] glyph : existing) {
      if (!intersects(bounds, glyph)) continue;
      double width = Math.min(bounds[2], glyph[2]) - Math.max(bounds[0], glyph[0]);
      double height = Math.min(bounds[3], glyph[3]) - Math.max(bounds[1], glyph[1]);
      covered += Math.max(0, width) * Math.max(0, height);
      if (covered > area * 0.4) return true;
    }
    return false;
  }

  private static void handleDecrypt(HttpExchange exchange) throws IOException {
    addCors(exchange);
    if ("OPTIONS".equals(exchange.getRequestMethod())) {
      sendNoContent(exchange);
      return;
    }
    if (!"POST".equals(exchange.getRequestMethod())) {
      sendJson(exchange, 405, "{\"error\":\"POST required\"}");
      return;
    }

    try {
      String body = readRequestBody(exchange);
      Map<String, Object> payload = asObject(new JsonParser(body).parse());
      byte[] pdfBytes = decodePdf(asString(payload.get("pdfBase64")));
      String password = asString(payload.get("password"));
      try (PDDocument document = loadPdf(pdfBytes, password)) {
        document.setAllSecurityToBeRemoved(true);
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        document.save(output);
        sendPdf(exchange, output.toByteArray());
      }
    } catch (Exception error) {
      sendJson(exchange, 400, "{\"error\":\"Incorrect password or unsupported encrypted PDF.\"}");
    }
  }

  private static void handleUncrop(HttpExchange exchange) throws IOException {
    addCors(exchange);
    if ("OPTIONS".equals(exchange.getRequestMethod())) {
      sendNoContent(exchange);
      return;
    }
    if (!"POST".equals(exchange.getRequestMethod())) {
      sendJson(exchange, 405, "{\"error\":\"POST required\"}");
      return;
    }

    try {
      String body = readRequestBody(exchange);
      Map<String, Object> payload = asObject(new JsonParser(body).parse());
      byte[] pdfBytes = decodePdf(asString(payload.get("pdfBase64")));
      ByteArrayOutputStream output = new ByteArrayOutputStream();
      StringBuilder pagesJson = new StringBuilder("[");
      boolean changed = false;

      try (PDDocument document = loadPdf(pdfBytes)) {
        for (int pageIndex = 0; pageIndex < document.getNumberOfPages(); pageIndex += 1) {
          if (pageIndex > 0) pagesJson.append(',');
          PDPage page = document.getPage(pageIndex);
          PDRectangle mediaBox = page.getMediaBox();
          PDRectangle cropBox = page.getCropBox();
          int rotation = ((page.getRotation() % 360) + 360) % 360;
          NormalizedPoint first = pdfPointToNormalized(mediaBox, rotation, cropBox.getLowerLeftX(), cropBox.getLowerLeftY());
          NormalizedPoint second = pdfPointToNormalized(mediaBox, rotation, cropBox.getUpperRightX(), cropBox.getLowerLeftY());
          NormalizedPoint third = pdfPointToNormalized(mediaBox, rotation, cropBox.getLowerLeftX(), cropBox.getUpperRightY());
          NormalizedPoint fourth = pdfPointToNormalized(mediaBox, rotation, cropBox.getUpperRightX(), cropBox.getUpperRightY());
          double left = clamp(Math.min(Math.min(first.x, second.x), Math.min(third.x, fourth.x)), 0, 1);
          double right = clamp(Math.max(Math.max(first.x, second.x), Math.max(third.x, fourth.x)), 0, 1);
          double top = clamp(Math.min(Math.min(first.y, second.y), Math.min(third.y, fourth.y)), 0, 1);
          double bottom = clamp(Math.max(Math.max(first.y, second.y), Math.max(third.y, fourth.y)), 0, 1);
          boolean cropped = left > 0.0001 || top > 0.0001 || right < 0.9999 || bottom < 0.9999;
          changed |= cropped;
          pagesJson.append('{')
              .append("\"x\":").append(left).append(',')
              .append("\"y\":").append(top).append(',')
              .append("\"width\":").append(Math.max(0, right - left)).append(',')
              .append("\"height\":").append(Math.max(0, bottom - top)).append(',')
              .append("\"cropped\":").append(cropped)
              .append('}');

          if (cropped) {
            page.setCropBox(new PDRectangle(
                mediaBox.getLowerLeftX(),
                mediaBox.getLowerLeftY(),
                mediaBox.getWidth(),
                mediaBox.getHeight()));
          }
        }
        if (changed) document.save(output);
      }
      pagesJson.append(']');
      byte[] expandedBytes = changed ? output.toByteArray() : pdfBytes;
      String response = "{"
          + "\"pdfBase64\":\"" + Base64.getEncoder().encodeToString(expandedBytes) + "\","
          + "\"changed\":" + changed + ","
          + "\"pages\":" + pagesJson
          + "}";
      sendJson(exchange, 200, response);
    } catch (Exception error) {
      sendFailure(exchange, error, "Could not inspect the PDF page boxes.");
    }
  }

  private static void handlePages(HttpExchange exchange) throws IOException {
    addCors(exchange);
    if ("OPTIONS".equals(exchange.getRequestMethod())) {
      sendNoContent(exchange);
      return;
    }
    if (!"POST".equals(exchange.getRequestMethod())) {
      sendJson(exchange, 405, "{\"error\":\"POST required\"}");
      return;
    }

    try {
      String body = readRequestBody(exchange);
      Map<String, Object> payload = asObject(new JsonParser(body).parse());
      String operation = asString(payload.get("operation"));
      byte[] pdfBytes = decodePdf(asString(payload.get("pdfBase64")));
      byte[] result;

      if ("rotate".equals(operation)) {
        List<Integer> pages = integerList(asArray(payload.get("pages")));
        int rotation = ((int) asDouble(payload.get("rotation")) % 360 + 360) % 360;
        try (PDDocument document = loadPdf(pdfBytes)) {
          assertEditable(document);
          validatePageIndexes(pages, document.getNumberOfPages());
          for (int pageIndex : pages) {
            PDPage page = document.getPage(pageIndex);
            page.setRotation(((page.getRotation() + rotation) % 360 + 360) % 360);
          }
          ByteArrayOutputStream output = new ByteArrayOutputStream();
          document.save(output);
          result = output.toByteArray();
        }
      } else if ("insert".equals(operation)) {
        byte[] insertedBytes = decodePdf(asString(payload.get("insertPdfBase64")));
        int insertAt = (int) asDouble(payload.get("insertAt"));
        try (PDDocument source = loadPdf(pdfBytes);
             PDDocument inserted = loadPdf(insertedBytes);
             PDDocument outputDocument = new PDDocument()) {
          assertEditable(source);
          assertEditable(inserted);
          if (insertAt < 0 || insertAt > source.getNumberOfPages()) {
            throw new IllegalArgumentException("Invalid page insertion position.");
          }
          for (int index = 0; index <= source.getNumberOfPages(); index += 1) {
            if (index == insertAt) {
              for (PDPage page : inserted.getPages()) outputDocument.importPage(page);
            }
            if (index < source.getNumberOfPages()) outputDocument.importPage(source.getPage(index));
          }
          ByteArrayOutputStream output = new ByteArrayOutputStream();
          outputDocument.save(output);
          result = output.toByteArray();
        }
      } else if ("reorder".equals(operation) || "extract".equals(operation)) {
        List<Integer> order = "reorder".equals(operation)
            ? integerList(asArray(payload.get("order")))
            : integerList(asArray(payload.get("pages")));
        try (PDDocument source = loadPdf(pdfBytes);
             PDDocument outputDocument = new PDDocument()) {
          assertEditable(source);
          validatePageIndexes(order, source.getNumberOfPages());
          if (order.isEmpty()) throw new IllegalArgumentException("At least one page is required.");
          for (int pageIndex : order) outputDocument.importPage(source.getPage(pageIndex));
          ByteArrayOutputStream output = new ByteArrayOutputStream();
          outputDocument.save(output);
          result = output.toByteArray();
        }
      } else if ("rasterize".equals(operation)) {
        List<Object> rasterPages = asArray(payload.get("rasterPages"));
        try (PDDocument document = loadPdf(pdfBytes)) {
          assertEditable(document);
          for (Object entry : rasterPages) {
            Map<String, Object> rasterPage = asObject(entry);
            int pageIndex = (int) asDouble(rasterPage.get("index"));
            validatePageIndexes(List.of(pageIndex), document.getNumberOfPages());
            replacePageWithImage(document, document.getPage(pageIndex), asString(rasterPage.get("imageBase64")));
          }
          ByteArrayOutputStream output = new ByteArrayOutputStream();
          document.save(output);
          result = output.toByteArray();
        }
      } else {
        throw new IllegalArgumentException("Unsupported page operation.");
      }

      sendPdf(exchange, result);
    } catch (Exception error) {
      sendFailure(exchange, error, "Could not apply the requested page operation.");
    }
  }

  /**
   * Replaces everything drawn on a page with one full-page JPEG rendered by the
   * editor. The page boxes and rotation stay as they are so existing form
   * widgets keep their positions; the image is mapped onto the visible crop box
   * in display orientation. Markup annotations are dropped because the editor
   * already baked them into the image.
   */
  private static void replacePageWithImage(PDDocument document, PDPage page, String imageData) throws IOException {
    if (imageData == null || imageData.isBlank()) throw new IllegalArgumentException("Missing raster image.");
    int comma = imageData.indexOf(',');
    byte[] imageBytes;
    try {
      imageBytes = Base64.getDecoder().decode(comma >= 0 ? imageData.substring(comma + 1) : imageData);
    } catch (IllegalArgumentException error) {
      throw new IllegalArgumentException("Invalid raster image data.", error);
    }
    if (imageBytes.length > 48 * 1024 * 1024) throw new IllegalArgumentException("Raster image is too large.");
    PDImageXObject image = JPEGFactory.createFromByteArray(document, imageBytes);

    List<PDAnnotation> widgets = new ArrayList<>();
    for (PDAnnotation annotation : page.getAnnotations()) {
      if (annotation instanceof PDAnnotationWidget) widgets.add(annotation);
    }
    page.setAnnotations(widgets);
    page.setResources(new PDResources());
    page.setContents(new PDStream(document));

    PdfPoint bottomLeft = normalizedToPdfPoint(page, new NormalizedPoint(0, 1));
    PdfPoint bottomRight = normalizedToPdfPoint(page, new NormalizedPoint(1, 1));
    PdfPoint topLeft = normalizedToPdfPoint(page, new NormalizedPoint(0, 0));
    try (PDPageContentStream content = new PDPageContentStream(
        document, page, PDPageContentStream.AppendMode.OVERWRITE, true, false)) {
      content.drawImage(image, new Matrix(
          bottomRight.x - bottomLeft.x,
          bottomRight.y - bottomLeft.y,
          topLeft.x - bottomLeft.x,
          topLeft.y - bottomLeft.y,
          bottomLeft.x,
          bottomLeft.y));
    }
  }

  private static List<Integer> integerList(List<Object> values) {
    List<Integer> result = new ArrayList<>();
    for (Object value : values) result.add((int) asDouble(value));
    return result;
  }

  private static void validatePageIndexes(List<Integer> indexes, int pageCount) {
    for (int index : indexes) {
      if (index < 0 || index >= pageCount) throw new IllegalArgumentException("Invalid page index.");
    }
  }

  private static NormalizedPoint pdfPointToNormalized(
      PDRectangle box,
      int rotation,
      double pointX,
      double pointY) {
    double relativeX = (pointX - box.getLowerLeftX()) / Math.max(0.0001, box.getWidth());
    double relativeY = (pointY - box.getLowerLeftY()) / Math.max(0.0001, box.getHeight());
    return switch (rotation) {
      case 90 -> new NormalizedPoint(relativeY, relativeX);
      case 180 -> new NormalizedPoint(1 - relativeX, relativeY);
      case 270 -> new NormalizedPoint(1 - relativeY, 1 - relativeX);
      default -> new NormalizedPoint(relativeX, 1 - relativeY);
    };
  }

  private static byte[] applyAnnotations(
      byte[] pdfBytes,
      List<AnnotationStroke> annotations,
      List<PageCommentData> comments,
      List<PdfReplyData> pdfReplies,
      String sourcePassword,
      String encryptionPassword,
      boolean printCopy) throws IOException {
    try (PDDocument document = loadPdf(pdfBytes, sourcePassword)) {
      // Exporting rewrites the file without its security settings, so a file
      // whose owner restricted editing must not get through here. The one
      // exception is a print copy, which the owner allows by allowing printing:
      // the same thing "Print to PDF" in Preview or Chrome produces.
      if (isEditRestricted(document)) {
        if (!printCopy) {
          throw new IllegalArgumentException("This PDF is edit protected. Remove the protection or download a flattened copy.");
        }
        if (!document.getCurrentAccessPermission().canPrint()) {
          throw new IllegalArgumentException("This PDF's owner disabled printing, so it can't be flattened.");
        }
      }
      document.setAllSecurityToBeRemoved(true);
      Map<Integer, List<AnnotationStroke>> redactedPages = new LinkedHashMap<>();
      List<AnnotationStroke> formFields = new ArrayList<>();
      List<AnnotationStroke> pageCrops = new ArrayList<>();
      Set<String> flattenedFieldNames = new java.util.HashSet<>();
      for (int pageIndex = 0; pageIndex < document.getNumberOfPages(); pageIndex += 1) {
        List<AnnotationStroke> markers = new ArrayList<>();
        List<AnnotationStroke> textMarks = new ArrayList<>();
        List<AnnotationStroke> redactions = new ArrayList<>();
        List<AnnotationStroke> pens = new ArrayList<>();
        List<AnnotationStroke> shapes = new ArrayList<>();
        for (AnnotationStroke annotation : annotations) {
          if (annotation.page != pageIndex) {
            continue;
          }
          if ("marker".equals(annotation.type)) {
            if (!annotation.points.isEmpty()) markers.add(annotation);
          } else if ("highlight".equals(annotation.type) || "underline".equals(annotation.type) ||
              "crossout".equals(annotation.type)) {
            textMarks.add(annotation);
          } else if ("blackout".equals(annotation.type) || "whiteout".equals(annotation.type)) {
            redactions.add(annotation);
          } else if ("pen".equals(annotation.type)) {
            if (!annotation.points.isEmpty()) pens.add(annotation);
          } else if ("checkbox".equals(annotation.type) || "input".equals(annotation.type)) {
            formFields.add(annotation);
          } else if ("crop".equals(annotation.type)) {
            pageCrops.add(annotation);
          } else {
            shapes.add(annotation);
          }
        }

        PDPage page = document.getPage(pageIndex);
        // Viewers like Chrome and pdf.js always paint form fields above the page
        // content, whatever the annotation order. An original field the editor's
        // additions cover (e.g. an image box) is therefore baked into the page
        // first, as printing would, so the additions drawn next end up on top.
        // Fields that are not covered stay interactive.
        if (redactions.isEmpty() && pageHasFormWidgets(page)) {
          List<AnnotationStroke> covering = new ArrayList<>(markers);
          covering.addAll(pens);
          for (AnnotationStroke shape : shapes) {
            if (!"watermark".equals(shape.type)) covering.add(shape);
          }
          flattenCoveredFields(document, page, covering, flattenedFieldNames);
        }
        if (!markers.isEmpty()) {
          drawAnnotationLayer(document, page, markers, true);
        }
        if (!textMarks.isEmpty()) {
          drawTextMarkLayer(document, page, textMarks);
        }
        if (!shapes.isEmpty()) {
          drawShapeLayer(document, pageIndex, page, shapes);
        }
        if (!pens.isEmpty()) {
          drawAnnotationLayer(document, page, pens, false);
        }
        if (!redactions.isEmpty()) {
          drawRedactionLayer(document, page, redactions);
          redactedPages.put(pageIndex, redactions);
        }
      }
      if (!redactedPages.isEmpty()) {
        redactPages(document, redactedPages);
      }
      if (!formFields.isEmpty()) {
        // A field baked into the page above must not be recreated as a new one.
        formFields.removeIf((field) -> field.existingField && flattenedFieldNames.contains(field.fieldName == null ? "" : field.fieldName.trim()));
        applyFormFields(document, formFields);
      }
      if (!comments.isEmpty()) {
        addComments(document, comments);
      }
      if (!pdfReplies.isEmpty()) {
        addPdfReplies(document, pdfReplies);
      }
      if (!pageCrops.isEmpty()) {
        applyPageCrops(document, pageCrops);
      }

      if (!encryptionPassword.isEmpty()) {
        AccessPermission permissions = new AccessPermission();
        byte[] ownerSecret = new byte[32];
        new SecureRandom().nextBytes(ownerSecret);
        String ownerPassword = Base64.getEncoder().encodeToString(ownerSecret);
        StandardProtectionPolicy policy = new StandardProtectionPolicy(
            ownerPassword, encryptionPassword, permissions);
        policy.setEncryptionKeyLength(256);
        policy.setPreferAES(true);
        document.setAllSecurityToBeRemoved(false);
        document.protect(policy);
      }

      ByteArrayOutputStream output = new ByteArrayOutputStream();
      document.save(output);
      return output.toByteArray();
    }
  }

  private static void drawTextMarkLayer(
      PDDocument document,
      PDPage page,
      List<AnnotationStroke> textMarks) throws IOException {
    try (PDPageContentStream content = new PDPageContentStream(
        document, page, PDPageContentStream.AppendMode.APPEND, true, true)) {
      PDExtendedGraphicsState graphicsState = new PDExtendedGraphicsState();
      graphicsState.setNonStrokingAlphaConstant(1f);
      graphicsState.setBlendMode(BlendMode.MULTIPLY);
      content.setGraphicsStateParameters(graphicsState);
      content.setNonStrokingColor(1f, 0.894f, 0.231f);
      content.setLineCapStyle(1);
      for (AnnotationStroke textMark : textMarks) {
        if (textMark.width <= 0 || textMark.height <= 0) continue;
        if ("highlight".equals(textMark.type)) {
          content.setNonStrokingColor(
              annotationColorComponent(textMark.color, 0),
              annotationColorComponent(textMark.color, 1),
              annotationColorComponent(textMark.color, 2));
          PdfPoint topLeft = shapePoint(page, textMark, 0, 0);
          PdfPoint topRight = shapePoint(page, textMark, 1, 0);
          PdfPoint bottomRight = shapePoint(page, textMark, 1, 1);
          PdfPoint bottomLeft = shapePoint(page, textMark, 0, 1);
          content.moveTo(topLeft.x, topLeft.y);
          content.lineTo(topRight.x, topRight.y);
          content.lineTo(bottomRight.x, bottomRight.y);
          content.lineTo(bottomLeft.x, bottomLeft.y);
          content.closePath();
          content.fill();
          continue;
        }

        double lineY = "underline".equals(textMark.type) ? 0.9 : 0.52;
        float red = annotationColorComponent(textMark.color, 0);
        float green = annotationColorComponent(textMark.color, 1);
        float blue = annotationColorComponent(textMark.color, 2);
        content.setStrokingColor(red, green, blue);
        PDRectangle box = page.getCropBox();
        int rotation = ((page.getRotation() % 360) + 360) % 360;
        double displayHeight = rotation == 90 || rotation == 270 ? box.getWidth() : box.getHeight();
        float requestedThickness = textMark.color.size() > 3 ? (float) textMark.color.get(3).doubleValue() / EDITOR_PAGE_SCALE : 0;
        content.setLineWidth(requestedThickness > 0
            ? Math.max(0.35f, requestedThickness)
            : (float) Math.max(0.75, Math.min(1.8, textMark.height * displayHeight * 0.09)));
        PdfPoint start = shapePoint(page, textMark, 0, lineY);
        PdfPoint end = shapePoint(page, textMark, 1, lineY);
        content.moveTo(start.x, start.y);
        content.lineTo(end.x, end.y);
        content.stroke();
      }
    }
  }

  private static void drawRedactionLayer(
      PDDocument document,
      PDPage page,
      List<AnnotationStroke> redactions) throws IOException {
    try (PDPageContentStream content = new PDPageContentStream(
        document, page, PDPageContentStream.AppendMode.APPEND, true, true)) {
      for (AnnotationStroke redaction : redactions) {
        if (redaction.width <= 0 || redaction.height <= 0) continue;
        if ("blackout".equals(redaction.type)) content.setNonStrokingColor(0f, 0f, 0f);
        else content.setNonStrokingColor(1f, 1f, 1f);
        PdfPoint topLeft = shapePoint(page, redaction, 0, 0);
        PdfPoint topRight = shapePoint(page, redaction, 1, 0);
        PdfPoint bottomRight = shapePoint(page, redaction, 1, 1);
        PdfPoint bottomLeft = shapePoint(page, redaction, 0, 1);
        content.moveTo(topLeft.x, topLeft.y);
        content.lineTo(topRight.x, topRight.y);
        content.lineTo(bottomRight.x, bottomRight.y);
        content.lineTo(bottomLeft.x, bottomLeft.y);
        content.closePath();
        content.fill();
      }
    }
  }

  /** Resolution redacted pages are re-rendered at. */
  private static final float REDACTION_DPI = 220f;
  /** Above this a re-rendered page is stored as JPEG instead of lossless. */
  private static final int REDACTION_LOSSLESS_LIMIT = 1_500_000;
  /** Page-dictionary entries that can carry copies of the old page content. */
  private static final String[] REDACTED_PAGE_KEYS = {
      "Thumb", "PieceInfo", "Metadata", "StructParents", "B", "AA", "SeparationInfo",
      "PZ", "VP", "ID", "Group", "TrimBox", "BleedBox", "ArtBox", "BoxColorInfo"
  };

  /**
   * One character of the page in display coordinates (points, top-left
   * origin, after /Rotate): its baseline origin, advance and "up" vectors, and
   * the bounding box of its full glyph cell (descender to ascender).
   */
  private record PageGlyph(
      String text,
      double originX, double originY,
      double advanceX, double advanceY,
      double upX, double upY,
      double[] bounds) {}

  /**
   * Redaction that cannot be undone. Each redacted page is re-rendered to an
   * image with the boxes painted into its pixels, so no text, vector or image
   * data under a box survives, and the page's old content, resources and
   * annotations are dropped. A box is widened to the full cell of every glyph
   * it touches, so a box drawn a little too tight never leaves the tops or
   * descenders of letters readable. Text that lies clearly outside every box
   * is put back as an invisible layer (the way OCR'd scans work) so the rest of
   * the page stays searchable. Document-level copies of page content (form
   * values, the tag tree's ActualText/Alt, XFA data) go too.
   */
  private static void redactPages(PDDocument document, Map<Integer, List<AnnotationStroke>> redactionsByPage) throws IOException {
    Map<Integer, List<PageGlyph>> glyphsByPage = new HashMap<>();
    for (int pageIndex : redactionsByPage.keySet()) {
      glyphsByPage.put(pageIndex, pageGlyphs(document, pageIndex, document.getPage(pageIndex)));
    }

    Set<COSBase> redactedWidgets = Collections.newSetFromMap(new IdentityHashMap<>());
    PDFRenderer renderer = new PDFRenderer(document);
    renderer.setSubsamplingAllowed(false);
    for (Map.Entry<Integer, List<AnnotationStroke>> entry : redactionsByPage.entrySet()) {
      int pageIndex = entry.getKey();
      PDPage page = document.getPage(pageIndex);
      for (PDAnnotation annotation : page.getAnnotations()) {
        if (annotation instanceof PDAnnotationWidget) redactedWidgets.add(annotation.getCOSObject());
      }
      float[] display = displaySize(page);
      List<PageGlyph> glyphs = glyphsByPage.get(pageIndex);
      // Boxes in display points: the drawn boxes plus every glyph cell they touch.
      List<double[]> boxes = new ArrayList<>();
      List<double[][]> polygons = new ArrayList<>();
      List<Boolean> black = new ArrayList<>();
      for (AnnotationStroke redaction : entry.getValue()) {
        if (redaction.width <= 0 || redaction.height <= 0) continue;
        double[][] corners = redactionCorners(page, redaction);
        double[][] polygon = new double[4][];
        double left = Double.MAX_VALUE, top = Double.MAX_VALUE, right = -Double.MAX_VALUE, bottom = -Double.MAX_VALUE;
        for (int index = 0; index < 4; index += 1) {
          polygon[index] = new double[] {corners[index][0] * display[0], corners[index][1] * display[1]};
          left = Math.min(left, polygon[index][0]);
          right = Math.max(right, polygon[index][0]);
          top = Math.min(top, polygon[index][1]);
          bottom = Math.max(bottom, polygon[index][1]);
        }
        double[] box = {left, top, right, bottom};
        boxes.add(box);
        polygons.add(polygon);
        black.add("blackout".equals(redaction.type));
        for (PageGlyph glyph : glyphs) {
          double[] cell = glyph.bounds();
          // Ignore absurd cells (e.g. a broken font matrix) instead of blacking out half the page.
          if (cell[3] - cell[1] > display[1] * 0.25 || cell[2] - cell[0] > display[0] * 0.5) continue;
          if (!intersects(cell, box)) continue;
          double pad = Math.max(0.75, (cell[3] - cell[1]) * 0.06);
          double[] widened = {cell[0] - pad, cell[1] - pad, cell[2] + pad, cell[3] + pad};
          boxes.add(widened);
          polygons.add(new double[][] {{widened[0], widened[1]}, {widened[2], widened[1]}, {widened[2], widened[3]}, {widened[0], widened[3]}});
          black.add("blackout".equals(redaction.type));
        }
      }

      BufferedImage rendered = renderer.renderImageWithDPI(pageIndex, REDACTION_DPI, ImageType.RGB);
      paintRedactions(rendered, display, polygons, black);
      PDImageXObject pageImage = LosslessFactory.createFromImage(document, rendered);
      if (pageImage.getCOSObject().getLength() > REDACTION_LOSSLESS_LIMIT) {
        pageImage = JPEGFactory.createFromImage(document, rendered, 0.9f);
      }
      rendered.flush();

      List<PageGlyph> kept = new ArrayList<>();
      for (PageGlyph glyph : glyphs) {
        double[] cell = glyph.bounds();
        // Painting and keeping use the same glyph geometry, so a small guard is enough.
        double marginY = Math.max(0.75, (cell[3] - cell[1]) * 0.1);
        double[] guarded = {cell[0] - 0.5, cell[1] - marginY, cell[2] + 0.5, cell[3] + marginY};
        boolean clear = cell[0] >= -1 && cell[1] >= -1 && cell[2] <= display[0] + 1 && cell[3] <= display[1] + 1;
        for (double[] box : boxes) {
          if (!clear) break;
          if (intersects(guarded, box)) clear = false;
        }
        if (clear) kept.add(glyph);
      }

      COSDictionary pageDictionary = page.getCOSObject();
      for (String key : REDACTED_PAGE_KEYS) pageDictionary.removeItem(COSName.getPDFName(key));
      page.setRotation(0);
      page.setMediaBox(new PDRectangle(display[0], display[1]));
      page.setCropBox(new PDRectangle(display[0], display[1]));
      page.setResources(new PDResources());
      page.setContents(new PDStream(document));
      page.setAnnotations(new ArrayList<>());
      try (PDPageContentStream content = new PDPageContentStream(
          document, page, PDPageContentStream.AppendMode.OVERWRITE, false, false)) {
        content.drawImage(pageImage, 0, 0, display[0], display[1]);
        writeInvisibleText(document, content, display[1], kept);
      }
    }

    // The tag tree can hold ActualText/Alt copies of the removed text and
    // points into content that no longer exists.
    COSDictionary catalog = document.getDocumentCatalog().getCOSObject();
    catalog.removeItem(COSName.STRUCT_TREE_ROOT);
    catalog.removeItem(COSName.MARK_INFO);
    removeRedactedFields(document, redactedWidgets);
  }

  private static boolean intersects(double[] first, double[] second) {
    return first[0] < second[2] && first[2] > second[0] && first[1] < second[3] && first[3] > second[1];
  }

  private static float[] displaySize(PDPage page) {
    PDRectangle box = page.getCropBox();
    int rotation = ((page.getRotation() % 360) + 360) % 360;
    boolean sideways = rotation == 90 || rotation == 270;
    return new float[] {sideways ? box.getHeight() : box.getWidth(), sideways ? box.getWidth() : box.getHeight()};
  }

  /** The corners of a redaction box in display-normalized coordinates (0..1, top-left origin). */
  private static double[][] redactionCorners(PDPage page, AnnotationStroke shape) {
    float[] display = displaySize(page);
    double centerX = shape.x + shape.width / 2;
    double centerY = shape.y + shape.height / 2;
    double radians = Math.toRadians(shape.rotation);
    double cosine = Math.cos(radians);
    double sine = Math.sin(radians);
    double[][] corners = new double[4][];
    double[][] local = {{0, 0}, {1, 0}, {1, 1}, {0, 1}};
    for (int index = 0; index < 4; index += 1) {
      double deltaX = (shape.x + local[index][0] * shape.width - centerX) * display[0];
      double deltaY = (shape.y + local[index][1] * shape.height - centerY) * display[1];
      corners[index] = new double[] {
          centerX + (deltaX * cosine - deltaY * sine) / display[0],
          centerY + (deltaX * sine + deltaY * cosine) / display[1]
      };
    }
    return corners;
  }

  /** Paints the boxes (display points) into the rendered pixels, slightly enlarged so anti-aliased edges are covered too. */
  private static void paintRedactions(BufferedImage image, float[] display, List<double[][]> polygons, List<Boolean> black) {
    java.awt.Graphics2D graphics = image.createGraphics();
    try {
      graphics.setRenderingHint(java.awt.RenderingHints.KEY_ANTIALIASING, java.awt.RenderingHints.VALUE_ANTIALIAS_OFF);
      graphics.setStroke(new java.awt.BasicStroke(4f, java.awt.BasicStroke.CAP_SQUARE, java.awt.BasicStroke.JOIN_MITER));
      double scaleX = image.getWidth() / (double) display[0];
      double scaleY = image.getHeight() / (double) display[1];
      for (int index = 0; index < polygons.size(); index += 1) {
        java.awt.geom.Path2D.Double polygon = new java.awt.geom.Path2D.Double();
        double[][] corners = polygons.get(index);
        for (int corner = 0; corner < corners.length; corner += 1) {
          if (corner == 0) polygon.moveTo(corners[corner][0] * scaleX, corners[corner][1] * scaleY);
          else polygon.lineTo(corners[corner][0] * scaleX, corners[corner][1] * scaleY);
        }
        polygon.closePath();
        graphics.setColor(black.get(index) ? java.awt.Color.BLACK : java.awt.Color.WHITE);
        graphics.fill(polygon);
        graphics.draw(polygon);
      }
    } finally {
      graphics.dispose();
    }
  }

  /**
   * Every character on the page with its geometry in display coordinates,
   * computed from the text rendering matrix so rotated pages, rotated text and
   * offset crop boxes all map the same way the editor and the boxes do.
   */
  private static List<PageGlyph> pageGlyphs(PDDocument document, int pageIndex, PDPage page) throws IOException {
    float[] display = displaySize(page);
    PDRectangle cropBox = page.getCropBox();
    int rotation = ((page.getRotation() % 360) + 360) % 360;
    List<PageGlyph> glyphs = new ArrayList<>();
    org.apache.pdfbox.text.PDFTextStripper stripper = new org.apache.pdfbox.text.PDFTextStripper() {
      @Override
      protected void processTextPosition(org.apache.pdfbox.text.TextPosition text) {
        String unicode = text.getUnicode();
        if (unicode == null || unicode.isEmpty()) return;
        // The stripper reports the matrix relative to the crop box's lower-left corner.
        Matrix matrix = text.getTextMatrix();
        double advance = 0;
        try {
          for (int code : text.getCharacterCodes()) advance += text.getFont().getWidth(code) / 1000.0;
        } catch (IOException | RuntimeException ignored) {
          advance = 0;
        }
        if (!(advance > 0)) advance = 0.6;
        double[][] local = {{0, 0}, {advance, 0}, {0, 1}, {0, -0.3}, {advance, -0.3}, {0, 1.05}, {advance, 1.05}};
        double[][] points = new double[local.length][];
        for (int index = 0; index < local.length; index += 1) {
          double userX = matrix.getScaleX() * local[index][0] + matrix.getShearX() * local[index][1] + matrix.getTranslateX() + cropBox.getLowerLeftX();
          double userY = matrix.getShearY() * local[index][0] + matrix.getScaleY() * local[index][1] + matrix.getTranslateY() + cropBox.getLowerLeftY();
          NormalizedPoint point = pdfPointToNormalized(cropBox, rotation, userX, userY);
          points[index] = new double[] {point.x() * display[0], point.y() * display[1]};
        }
        double left = Double.MAX_VALUE, top = Double.MAX_VALUE, right = -Double.MAX_VALUE, bottom = -Double.MAX_VALUE;
        for (int index = 3; index < points.length; index += 1) {
          left = Math.min(left, points[index][0]);
          right = Math.max(right, points[index][0]);
          top = Math.min(top, points[index][1]);
          bottom = Math.max(bottom, points[index][1]);
        }
        if (!Double.isFinite(left) || !Double.isFinite(top) || !Double.isFinite(right) || !Double.isFinite(bottom)) return;
        glyphs.add(new PageGlyph(unicode,
            points[0][0], points[0][1],
            points[1][0] - points[0][0], points[1][1] - points[0][1],
            points[2][0] - points[0][0], points[2][1] - points[0][1],
            new double[] {left, top, right, bottom}));
      }
    };
    stripper.setStartPage(pageIndex + 1);
    stripper.setEndPage(pageIndex + 1);
    stripper.getText(document);
    return glyphs;
  }

  /** Writes the kept characters as invisible text (render mode 3) with their original position, size and direction. */
  private static void writeInvisibleText(
      PDDocument document,
      PDPageContentStream content,
      float pageHeight,
      List<PageGlyph> glyphs) throws IOException {
    if (glyphs == null || glyphs.isEmpty()) return;
    PDFont base = new PDType1Font(Standard14Fonts.FontName.HELVETICA);
    content.beginText();
    content.setRenderingMode(org.apache.pdfbox.pdmodel.graphics.state.RenderingMode.NEITHER);
    for (PageGlyph glyph : glyphs) {
      if (glyph.text().isBlank()) continue;
      for (FontRun run : fontRuns(document, base, glyph.text())) {
        double natural = run.font().getStringWidth(run.text()) / 1000.0;
        if (!(natural > 0)) continue;
        // Display coordinates have y pointing down; the new page's user space has it pointing up.
        content.setFont(run.font(), 1);
        content.setTextMatrix(new Matrix(
            (float) (glyph.advanceX() / natural), (float) (-glyph.advanceY() / natural),
            (float) glyph.upX(), (float) -glyph.upY(),
            (float) glyph.originX(), (float) (pageHeight - glyph.originY())));
        content.showText(run.text());
        break;
      }
    }
    content.endText();
  }

  /**
   * Form fields whose widgets were all on redacted pages are removed (their
   * values would otherwise survive in the form data); a field that also shows
   * elsewhere only loses its redacted widgets. XFA data is a second copy of the
   * values, so it is dropped as well.
   */
  private static void removeRedactedFields(PDDocument document, Set<COSBase> redactedWidgets) throws IOException {
    PDAcroForm acroForm = document.getDocumentCatalog().getAcroForm(null);
    if (acroForm == null) return;
    acroForm.getCOSObject().removeItem(COSName.XFA);
    if (redactedWidgets.isEmpty()) return;
    List<PDField> terminals = new ArrayList<>();
    for (PDField field : acroForm.getFieldTree()) {
      if (field instanceof PDTerminalField) terminals.add(field);
    }
    for (PDField field : terminals) {
      List<PDAnnotationWidget> widgets = ((PDTerminalField) field).getWidgets();
      long redacted = widgets.stream().filter((widget) -> redactedWidgets.contains(widget.getCOSObject())).count();
      if (redacted == 0) continue;
      if (redacted == widgets.size()) {
        COSDictionary dictionary = field.getCOSObject();
        COSArray siblings = field.getParent() == null
            ? acroForm.getCOSObject().getCOSArray(COSName.FIELDS)
            : field.getParent().getCOSObject().getCOSArray(COSName.KIDS);
        if (siblings != null) siblings.removeObject(dictionary);
        dictionary.removeItem(COSName.V);
        dictionary.removeItem(COSName.DV);
      } else {
        COSArray kids = field.getCOSObject().getCOSArray(COSName.KIDS);
        if (kids == null) continue;
        for (PDAnnotationWidget widget : widgets) {
          if (redactedWidgets.contains(widget.getCOSObject())) kids.removeObject(widget.getCOSObject());
        }
      }
    }
  }

  private static void applyPageCrops(PDDocument document, List<AnnotationStroke> crops) {
    Map<Integer, AnnotationStroke> cropByPage = new LinkedHashMap<>();
    for (AnnotationStroke crop : crops) {
      if (crop.page >= 0 && crop.page < document.getNumberOfPages()) cropByPage.put(crop.page, crop);
    }
    for (Map.Entry<Integer, AnnotationStroke> entry : cropByPage.entrySet()) {
      PDPage page = document.getPage(entry.getKey());
      AnnotationStroke crop = entry.getValue();
      PdfPoint topLeft = shapePoint(page, crop, 0, 0);
      PdfPoint topRight = shapePoint(page, crop, 1, 0);
      PdfPoint bottomLeft = shapePoint(page, crop, 0, 1);
      PdfPoint bottomRight = shapePoint(page, crop, 1, 1);
      float left = Math.min(Math.min(topLeft.x, topRight.x), Math.min(bottomLeft.x, bottomRight.x));
      float right = Math.max(Math.max(topLeft.x, topRight.x), Math.max(bottomLeft.x, bottomRight.x));
      float bottom = Math.min(Math.min(topLeft.y, topRight.y), Math.min(bottomLeft.y, bottomRight.y));
      float top = Math.max(Math.max(topLeft.y, topRight.y), Math.max(bottomLeft.y, bottomRight.y));
      if (right - left < 1 || top - bottom < 1) continue;
      page.setCropBox(new PDRectangle(left, bottom, right - left, top - bottom));
    }
  }

  private static void applyFormFields(PDDocument document, List<AnnotationStroke> formAnnotations) throws IOException {
    PDAcroForm acroForm = document.getDocumentCatalog().getAcroForm();
    if (acroForm == null) {
      acroForm = new PDAcroForm(document);
      document.getDocumentCatalog().setAcroForm(acroForm);
    }
    PDResources resources = acroForm.getDefaultResources();
    if (resources == null) {
      resources = new PDResources();
      acroForm.setDefaultResources(resources);
    }
    if (resources.getFont(COSName.getPDFName("Helv")) == null) {
      resources.put(COSName.getPDFName("Helv"), new PDType1Font(Standard14Fonts.FontName.HELVETICA));
    }
    if (acroForm.getDefaultAppearance() == null || acroForm.getDefaultAppearance().isBlank()) {
      acroForm.setDefaultAppearance("/Helv 0 Tf 0 g");
    }
    acroForm.setNeedAppearances(false);

    int generatedIndex = 1;
    for (AnnotationStroke annotation : formAnnotations) {
      if (annotation.page < 0 || annotation.page >= document.getNumberOfPages()) continue;
      String requestedName = annotation.fieldName == null ? "" : annotation.fieldName.trim();
      PDField existing = requestedName.isEmpty() ? null : acroForm.getField(requestedName);
      if (annotation.existingField && existing != null) {
        PDPage page = document.getPage(annotation.page);
        PDRectangle rectangle = formFieldRectangle(page, annotation);
        for (PDAnnotationWidget widget : existing.getWidgets()) {
          widget.setRectangle(rectangle);
          widget.setPage(page);
        }
        if ("checkbox".equals(annotation.type) && existing instanceof PDCheckBox checkbox) {
          ensureCheckboxStates(document, checkbox);
          if (annotation.fieldChecked) checkbox.check();
          else checkbox.unCheck();
        } else if ("input".equals(annotation.type) && existing instanceof PDTextField textField) {
          String value = annotation.fieldValue == null ? "" : annotation.fieldValue;
          try {
            textField.setValue(value);
          } catch (IOException fontError) {
            // Some existing fields carry their own /DA string pointing at a font
            // that isn't actually declared in the PDF's resources (a common,
            // malformed-but-real-world case), so PDFBox can't rebuild the
            // appearance stream. Fall back to the same safe default already
            // guaranteed to resolve for fields Docuflex creates itself.
            textField.setDefaultAppearance("/Helv 0 Tf 0 g");
            textField.setValue(value);
          }
        }
        continue;
      }

      String fieldName = requestedName.isEmpty() ? "DocuflexField" + generatedIndex : requestedName;
      while (acroForm.getField(fieldName) != null) fieldName = "DocuflexField" + (++generatedIndex);
      generatedIndex += 1;
      PDPage page = document.getPage(annotation.page);
      PDRectangle rectangle = formFieldRectangle(page, annotation);
      if (rectangle.getWidth() < 1 || rectangle.getHeight() < 1) continue;

      if ("input".equals(annotation.type)) {
        PDTextField textField = new PDTextField(acroForm);
        textField.setPartialName(fieldName);
        textField.setDefaultAppearance("/Helv 0 Tf 0 g");
        PDAnnotationWidget widget = textField.getWidgets().get(0);
        configureFormWidget(widget, page, rectangle);
        acroForm.getFields().add(textField);
        page.getAnnotations().add(widget);
        textField.setValue(annotation.fieldValue == null ? "" : annotation.fieldValue);
      } else if ("checkbox".equals(annotation.type)) {
        PDCheckBox checkbox = new PDCheckBox(acroForm);
        checkbox.setPartialName(fieldName);
        PDAnnotationWidget widget = checkbox.getWidgets().get(0);
        configureFormWidget(widget, page, rectangle);
        setCheckboxAppearance(document, widget, rectangle.getWidth(), rectangle.getHeight());
        acroForm.getFields().add(checkbox);
        page.getAnnotations().add(widget);
        if (annotation.fieldChecked) checkbox.check();
        else checkbox.unCheck();
      }
    }
  }

  private static PDRectangle formFieldRectangle(PDPage page, AnnotationStroke shape) {
    PdfPoint topLeft = shapePoint(page, shape, 0, 0);
    PdfPoint topRight = shapePoint(page, shape, 1, 0);
    PdfPoint bottomLeft = shapePoint(page, shape, 0, 1);
    PdfPoint bottomRight = shapePoint(page, shape, 1, 1);
    float left = Math.min(Math.min(topLeft.x, topRight.x), Math.min(bottomLeft.x, bottomRight.x));
    float right = Math.max(Math.max(topLeft.x, topRight.x), Math.max(bottomLeft.x, bottomRight.x));
    float bottom = Math.min(Math.min(topLeft.y, topRight.y), Math.min(bottomLeft.y, bottomRight.y));
    float top = Math.max(Math.max(topLeft.y, topRight.y), Math.max(bottomLeft.y, bottomRight.y));
    return new PDRectangle(left, bottom, right - left, top - bottom);
  }

  private static void configureFormWidget(PDAnnotationWidget widget, PDPage page, PDRectangle rectangle) {
    widget.setRectangle(rectangle);
    widget.setPage(page);
    widget.setPrinted(true);
    PDAppearanceCharacteristicsDictionary appearance =
        new PDAppearanceCharacteristicsDictionary(new org.apache.pdfbox.cos.COSDictionary());
    appearance.setBorderColour(new PDColor(new float[] {0.45f, 0.45f, 0.45f}, PDDeviceRGB.INSTANCE));
    appearance.setBackground(new PDColor(new float[] {1f, 1f, 1f}, PDDeviceRGB.INSTANCE));
    widget.setAppearanceCharacteristics(appearance);
    COSArray border = new COSArray();
    border.add(COSInteger.ZERO);
    border.add(COSInteger.ZERO);
    border.add(COSInteger.ONE);
    widget.setBorder(border);
  }

  private static void setCheckboxAppearance(
      PDDocument document,
      PDAnnotationWidget widget,
      float width,
      float height) throws IOException {
    PDAppearanceStream off = checkboxAppearanceStream(document, width, height, false);
    PDAppearanceStream on = checkboxAppearanceStream(document, width, height, true);
    org.apache.pdfbox.cos.COSDictionary normal = new org.apache.pdfbox.cos.COSDictionary();
    normal.setItem(COSName.Off, off);
    normal.setItem(COSName.getPDFName("Yes"), on);
    PDAppearanceDictionary dictionary = new PDAppearanceDictionary();
    dictionary.setNormalAppearance(new PDAppearanceEntry(normal));
    widget.setAppearance(dictionary);
    widget.setAppearanceState("Off");
  }

  private static boolean pageHasFormWidgets(PDPage page) throws IOException {
    for (PDAnnotation annotation : page.getAnnotations()) {
      if (annotation instanceof PDAnnotationWidget) return true;
    }
    return false;
  }

  /** Page-space bounding box of one addition, slightly padded for its stroke. */
  private static PDRectangle overlayRectangle(PDPage page, AnnotationStroke overlay) {
    List<PdfPoint> points = new ArrayList<>();
    if (overlay.points() != null && !overlay.points().isEmpty()) {
      for (NormalizedPoint point : overlay.points()) points.add(normalizedToPdfPoint(page, point));
    } else {
      points.add(shapePoint(page, overlay, 0, 0));
      points.add(shapePoint(page, overlay, 1, 0));
      points.add(shapePoint(page, overlay, 0, 1));
      points.add(shapePoint(page, overlay, 1, 1));
    }
    float left = Float.MAX_VALUE;
    float bottom = Float.MAX_VALUE;
    float right = -Float.MAX_VALUE;
    float top = -Float.MAX_VALUE;
    for (PdfPoint point : points) {
      left = Math.min(left, point.x());
      bottom = Math.min(bottom, point.y());
      right = Math.max(right, point.x());
      top = Math.max(top, point.y());
    }
    float padding = overlay.points() != null && !overlay.points().isEmpty() ? 6 : 1;
    return new PDRectangle(left - padding, bottom - padding, right - left + 2 * padding, top - bottom + 2 * padding);
  }

  /** Fields covered by this share or less are only grazed by an addition and stay interactive. */
  private static final double FIELD_COVER_THRESHOLD = 0.10;

  /**
   * Fraction of a field's area under the additions, sampled on a grid so that
   * additions overlapping each other are not counted twice.
   */
  private static double coveredFraction(PDRectangle field, List<PDRectangle> covered) {
    int samples = 32;
    int hits = 0;
    for (int row = 0; row < samples; row += 1) {
      float y = field.getLowerLeftY() + (row + 0.5f) / samples * field.getHeight();
      for (int column = 0; column < samples; column += 1) {
        float x = field.getLowerLeftX() + (column + 0.5f) / samples * field.getWidth();
        for (PDRectangle area : covered) {
          if (x >= area.getLowerLeftX() && x <= area.getUpperRightX() && y >= area.getLowerLeftY() && y <= area.getUpperRightY()) {
            hits += 1;
            break;
          }
        }
      }
    }
    return hits / (double) (samples * samples);
  }

  /** Bakes every original form field on this page that the additions cover by more than 10% into the page content. */
  private static void flattenCoveredFields(
      PDDocument document,
      PDPage page,
      List<AnnotationStroke> overlays,
      Set<String> flattenedFieldNames) throws IOException {
    if (overlays.isEmpty()) return;
    PDAcroForm acroForm = document.getDocumentCatalog().getAcroForm();
    if (acroForm == null) return;
    List<PDRectangle> covered = new ArrayList<>();
    for (AnnotationStroke overlay : overlays) covered.add(overlayRectangle(page, overlay));

    List<PDField> fields = new ArrayList<>();
    for (PDField field : acroForm.getFieldTree()) {
      if (!(field instanceof PDTerminalField terminal)) continue;
      for (PDAnnotationWidget widget : terminal.getWidgets()) {
        PDRectangle rectangle = widget.getRectangle();
        boolean onPage = widget.getPage() == null
            ? page.getAnnotations().stream().anyMatch((annotation) -> annotation.getCOSObject() == widget.getCOSObject())
            : widget.getPage().getCOSObject() == page.getCOSObject();
        if (rectangle == null || !onPage) continue;
        if (coveredFraction(rectangle, covered) > FIELD_COVER_THRESHOLD) {
          fields.add(field);
          break;
        }
      }
    }
    if (fields.isEmpty()) return;
    for (PDField field : fields) flattenedFieldNames.add(field.getFullyQualifiedName());
    acroForm.flatten(fields, false);
  }

  private static boolean isEditRestricted(PDDocument document) {
    if (!document.isEncrypted()) return false;
    AccessPermission access = document.getCurrentAccessPermission();
    return !access.isOwnerPermission() && (!access.canModify() || !access.canModifyAnnotations());
  }

  private static void assertEditable(PDDocument document) {
    if (isEditRestricted(document)) {
      throw new IllegalArgumentException("This PDF is edit protected. Remove the protection to change its pages.");
    }
  }

  /**
   * Form filling on an edit-protected file, saved the way Preview and Acrobat
   * do it: only the changed fields are appended as an incremental update, so
   * the original bytes, encryption and permissions stay untouched.
   */
  private static byte[] applyAllowedChangesIncremental(
      byte[] pdfBytes,
      List<Object> formValues,
      List<PageCommentData> comments,
      List<PdfReplyData> pdfReplies) throws IOException {
    try (PDDocument document = loadPdf(pdfBytes)) {
      AccessPermission access = document.getCurrentAccessPermission();
      if (!formValues.isEmpty() && !access.isOwnerPermission() && !access.canFillInForm() && !access.canModifyAnnotations()) {
        throw new IllegalArgumentException("This PDF's owner disabled filling in its form fields.");
      }
      if ((!comments.isEmpty() || !pdfReplies.isEmpty()) && !access.isOwnerPermission() && !access.canModifyAnnotations()) {
        throw new IllegalArgumentException("This PDF's owner disabled adding comments.");
      }
      Set<org.apache.pdfbox.cos.COSDictionary> changed = new java.util.HashSet<>();
      changed.add(document.getDocumentCatalog().getCOSObject());
      for (PDAnnotation annotation : addComments(document, comments)) {
        changed.add(annotation.getCOSObject());
        if (annotation.getAppearance() != null) changed.add(annotation.getAppearance().getCOSObject());
      }
      for (PDAnnotation reply : addPdfReplies(document, pdfReplies)) changed.add(reply.getCOSObject());
      int pages = document.getNumberOfPages();
      for (PageCommentData comment : comments) {
        if (comment.page() >= 0 && comment.page() < pages) changed.add(document.getPage(comment.page()).getCOSObject());
      }
      for (PdfReplyData reply : pdfReplies) {
        if (reply.page() >= 0 && reply.page() < pages) changed.add(document.getPage(reply.page()).getCOSObject());
      }
      PDAcroForm acroForm = formValues.isEmpty() ? null : document.getDocumentCatalog().getAcroForm();
      if (!formValues.isEmpty() && acroForm == null) throw new IllegalArgumentException("This PDF has no form fields.");
      if (acroForm != null) {
        acroForm.setNeedAppearances(false);
        changed.add(acroForm.getCOSObject());
      }
      for (Object entry : formValues) {
        Map<String, Object> formValue = asObject(entry);
        PDField field = acroForm.getField(asString(formValue.get("fieldName")));
        if (field == null) continue;
        Object value = formValue.get("value");
        if (field instanceof PDCheckBox checkbox) {
          ensureCheckboxStates(document, checkbox);
          if (Boolean.TRUE.equals(value)) checkbox.check();
          else checkbox.unCheck();
        } else if (field instanceof PDTextField textField) {
          String text = value instanceof String string ? string : "";
          try {
            textField.setValue(text);
          } catch (IOException fontError) {
            textField.setDefaultAppearance("/Helv 0 Tf 0 g");
            textField.setValue(text);
          }
        } else {
          continue;
        }
        changed.add(field.getCOSObject());
        for (PDAnnotationWidget widget : field.getWidgets()) {
          changed.add(widget.getCOSObject());
          if (widget.getAppearance() != null) changed.add(widget.getAppearance().getCOSObject());
        }
      }
      ByteArrayOutputStream output = new ByteArrayOutputStream();
      document.saveIncremental(output, changed);
      byte[] appended = output.toByteArray();
      // saveIncremental writes original bytes plus the update section.
      return appended.length >= pdfBytes.length ? appended : concat(pdfBytes, appended);
    }
  }

  private record CommentReplyData(String author, String text) {}

  private record PageCommentData(int page, double x, double y, String text, String author, List<double[]> rects, List<CommentReplyData> replies) {}

  /** A reply to a comment already in the PDF; ref is pdf.js's object id such as "15R". */
  private record PdfReplyData(int page, String ref, String author, String text) {}

  private static List<CommentReplyData> parseReplies(Object raw) {
    if (!(raw instanceof List<?>)) return List.of();
    List<CommentReplyData> replies = new ArrayList<>();
    for (Object entry : asArray(raw)) {
      Map<String, Object> reply = asObject(entry);
      String text = optionalString(reply.get("text"));
      if (text.isBlank()) continue;
      if (text.length() > 20_000) throw new IllegalArgumentException("Reply is too long.");
      replies.add(new CommentReplyData(optionalString(reply.get("author")), text));
    }
    return replies;
  }

  private static List<PdfReplyData> parsePdfReplies(Object raw) {
    if (!(raw instanceof List<?>)) return List.of();
    List<Object> entries = asArray(raw);
    if (entries.size() > 5_000) throw new IllegalArgumentException("Too many replies.");
    List<PdfReplyData> replies = new ArrayList<>();
    for (Object entry : entries) {
      Map<String, Object> reply = asObject(entry);
      String text = optionalString(reply.get("text"));
      if (text.isBlank()) continue;
      if (text.length() > 20_000) throw new IllegalArgumentException("Reply is too long.");
      replies.add(new PdfReplyData((int) asDouble(reply.get("page")), optionalString(reply.get("ref")), optionalString(reply.get("author")), text));
    }
    return replies;
  }

  private static List<PageCommentData> parseComments(Object raw) {
    if (!(raw instanceof List<?>)) return List.of();
    List<Object> entries = asArray(raw);
    if (entries.size() > 5_000) throw new IllegalArgumentException("Too many comments.");
    List<PageCommentData> result = new ArrayList<>();
    for (Object entry : entries) {
      Map<String, Object> comment = asObject(entry);
      String text = optionalString(comment.get("text"));
      if (text.isBlank()) continue;
      if (text.length() > 20_000) throw new IllegalArgumentException("Comment is too long.");
      List<double[]> rects = new ArrayList<>();
      if (comment.get("rects") instanceof List<?>) {
        for (Object rawRect : asArray(comment.get("rects"))) {
          Map<String, Object> rect = asObject(rawRect);
          rects.add(new double[] {
              clamp(optionalDouble(rect.get("x")), 0, 1), clamp(optionalDouble(rect.get("y")), 0, 1),
              clamp(optionalDouble(rect.get("width")), 0, 1), clamp(optionalDouble(rect.get("height")), 0, 1)
          });
        }
      }
      result.add(new PageCommentData(
          (int) asDouble(comment.get("page")),
          clamp(optionalDouble(comment.get("x")), 0, 1),
          clamp(optionalDouble(comment.get("y")), 0, 1),
          text,
          optionalString(comment.get("author")),
          rects,
          parseReplies(comment.get("replies"))));
    }
    return result;
  }

  /**
   * Writes comments as standard PDF markup annotations, so Acrobat, Preview
   * and Chrome list them: a highlight carrying the comment when text was
   * selected, otherwise a sticky note at the clicked spot.
   */
  private static List<PDAnnotation> addComments(PDDocument document, List<PageCommentData> comments) throws IOException {
    List<PDAnnotation> added = new ArrayList<>();
    java.util.Calendar now = java.util.Calendar.getInstance();
    for (PageCommentData comment : comments) {
      if (comment.page() < 0 || comment.page() >= document.getNumberOfPages()) continue;
      PDPage page = document.getPage(comment.page());
      PDAnnotationMarkup annotation;
      if (!comment.rects().isEmpty()) {
        PDAnnotationHighlight highlight = new PDAnnotationHighlight();
        float[] quads = new float[comment.rects().size() * 8];
        float left = Float.MAX_VALUE, bottom = Float.MAX_VALUE, right = -Float.MAX_VALUE, top = -Float.MAX_VALUE;
        int offset = 0;
        for (double[] rect : comment.rects()) {
          // QuadPoints order: upper-left, upper-right, lower-left, lower-right.
          PdfPoint[] corners = {
              normalizedToPdfPoint(page, new NormalizedPoint(rect[0], rect[1])),
              normalizedToPdfPoint(page, new NormalizedPoint(rect[0] + rect[2], rect[1])),
              normalizedToPdfPoint(page, new NormalizedPoint(rect[0], rect[1] + rect[3])),
              normalizedToPdfPoint(page, new NormalizedPoint(rect[0] + rect[2], rect[1] + rect[3]))
          };
          for (PdfPoint corner : corners) {
            quads[offset++] = corner.x();
            quads[offset++] = corner.y();
            left = Math.min(left, corner.x());
            right = Math.max(right, corner.x());
            bottom = Math.min(bottom, corner.y());
            top = Math.max(top, corner.y());
          }
        }
        highlight.setQuadPoints(quads);
        highlight.setRectangle(new PDRectangle(left, bottom, right - left, top - bottom));
        highlight.setColor(new PDColor(new float[] { 1f, 0.84f, 0.04f }, PDDeviceRGB.INSTANCE));
        annotation = highlight;
      } else {
        PDAnnotationText note = new PDAnnotationText();
        PdfPoint anchor = normalizedToPdfPoint(page, new NormalizedPoint(comment.x(), comment.y()));
        note.setRectangle(new PDRectangle(anchor.x(), anchor.y() - 20, 20, 20));
        note.setName(PDAnnotationText.NAME_COMMENT);
        note.setColor(new PDColor(new float[] { 1f, 0.84f, 0.04f }, PDDeviceRGB.INSTANCE));
        annotation = note;
      }
      annotation.setContents(comment.text());
      annotation.setTitlePopup(comment.author().isBlank() ? "Docuflex" : comment.author());
      annotation.setCreationDate(now);
      annotation.setModifiedDate(now);
      annotation.setAnnotationName(UUID.randomUUID().toString());
      annotation.setPrinted(true);
      annotation.setPage(page);
      annotation.constructAppearances(document);
      List<PDAnnotation> pageAnnotations = page.getAnnotations();
      pageAnnotations.add(annotation);
      page.setAnnotations(pageAnnotations);
      added.add(annotation);
      for (CommentReplyData reply : comment.replies()) {
        added.add(addReply(document, page, annotation, reply.author(), reply.text(), now));
      }
    }
    return added;
  }

  /**
   * A reply the way Acrobat writes one: a note annotation with In Reply To
   * pointing at the parent and sharing its position. Viewers fold it into the
   * parent's thread (it must not be hidden, or pdf.js skips it entirely).
   */
  private static PDAnnotation addReply(
      PDDocument document,
      PDPage page,
      PDAnnotation parent,
      String author,
      String text,
      java.util.Calendar when) throws IOException {
    PDAnnotationText reply = new PDAnnotationText();
    PDRectangle parentRect = parent.getRectangle();
    reply.setRectangle(parentRect == null ? new PDRectangle(0, 0, 20, 20) : parentRect);
    reply.setInReplyTo(parent);
    reply.setContents(text);
    reply.setTitlePopup(author.isBlank() ? "Docuflex" : author);
    reply.setCreationDate(when);
    reply.setModifiedDate(when);
    reply.setAnnotationName(UUID.randomUUID().toString());
    reply.setPage(page);
    List<PDAnnotation> pageAnnotations = page.getAnnotations();
    pageAnnotations.add(reply);
    page.setAnnotations(pageAnnotations);
    return reply;
  }

  /** Finds a page's annotation by the "15R" / "15R2" object id pdf.js reports. */
  private static PDAnnotation findAnnotationByRef(PDPage page, String ref) throws IOException {
    java.util.regex.Matcher match = java.util.regex.Pattern.compile("^(\\d+)R(\\d*)$").matcher(ref == null ? "" : ref.trim());
    if (!match.matches()) return null;
    long number = Long.parseLong(match.group(1));
    int generation = match.group(2).isEmpty() ? 0 : Integer.parseInt(match.group(2));
    COSArray annots = page.getCOSObject().getCOSArray(COSName.ANNOTS);
    if (annots == null) return null;
    for (int index = 0; index < annots.size(); index += 1) {
      if (annots.get(index) instanceof org.apache.pdfbox.cos.COSObject object
          && object.getKey() != null
          && object.getKey().getNumber() == number
          && object.getKey().getGeneration() == generation
          && object.getObject() instanceof org.apache.pdfbox.cos.COSDictionary dictionary) {
        return PDAnnotation.createAnnotation(dictionary);
      }
    }
    return null;
  }

  private static List<PDAnnotation> addPdfReplies(PDDocument document, List<PdfReplyData> replies) throws IOException {
    List<PDAnnotation> added = new ArrayList<>();
    java.util.Calendar now = java.util.Calendar.getInstance();
    for (PdfReplyData reply : replies) {
      if (reply.page() < 0 || reply.page() >= document.getNumberOfPages()) continue;
      PDPage page = document.getPage(reply.page());
      PDAnnotation parent = findAnnotationByRef(page, reply.ref());
      if (parent == null) continue;
      added.add(addReply(document, page, parent, reply.author(), reply.text(), now));
    }
    return added;
  }

  private static byte[] concat(byte[] first, byte[] second) {
    byte[] result = Arrays.copyOf(first, first.length + second.length);
    System.arraycopy(second, 0, result, first.length, second.length);
    return result;
  }

  /**
   * check()/unCheck() need every widget's normal appearance to be an on/off
   * state dictionary. Some real-world forms store a single stream instead,
   * which makes PDFBox throw "This entry is not an appearance subdictionary";
   * give those widgets a regular two-state appearance first.
   */
  private static void ensureCheckboxStates(PDDocument document, PDCheckBox checkbox) throws IOException {
    for (PDAnnotationWidget widget : checkbox.getWidgets()) {
      PDAppearanceDictionary appearance = widget.getAppearance();
      PDAppearanceEntry normal = appearance == null ? null : appearance.getNormalAppearance();
      if (normal != null && normal.isSubDictionary()) continue;
      PDRectangle rectangle = widget.getRectangle();
      if (rectangle == null) continue;
      setCheckboxAppearance(document, widget, rectangle.getWidth(), rectangle.getHeight());
    }
  }

  private static PDAppearanceStream checkboxAppearanceStream(
      PDDocument document,
      float width,
      float height,
      boolean checked) throws IOException {
    PDAppearanceStream stream = new PDAppearanceStream(document);
    stream.setBBox(new PDRectangle(width, height));
    stream.setResources(new PDResources());
    try (PDPageContentStream content = new PDPageContentStream(document, stream)) {
      content.setNonStrokingColor(1f, 1f, 1f);
      content.addRect(0, 0, width, height);
      content.fill();
      content.setStrokingColor(0.42f, 0.42f, 0.42f);
      content.setLineWidth(Math.max(0.75f, Math.min(width, height) * 0.055f));
      content.addRect(0.6f, 0.6f, Math.max(0, width - 1.2f), Math.max(0, height - 1.2f));
      content.stroke();
      if (checked) {
        content.setStrokingColor(0.04f, 0.47f, 0.98f);
        content.setLineWidth(Math.max(1.2f, Math.min(width, height) * 0.12f));
        content.setLineCapStyle(1);
        content.moveTo(width * 0.2f, height * 0.5f);
        content.lineTo(width * 0.42f, height * 0.25f);
        content.lineTo(width * 0.82f, height * 0.76f);
        content.stroke();
      }
    }
    return stream;
  }

  private static void drawShapeLayer(
      PDDocument document,
      int pageIndex,
      PDPage page,
      List<AnnotationStroke> shapes) throws IOException {
    BufferedImage blurSource = shapes.stream().anyMatch(shape -> styleFlag(shape, 18, false) && styleFlag(shape, 19, false))
        ? new PDFRenderer(document).renderImageWithDPI(pageIndex, 144, ImageType.RGB)
        : null;
    try (PDPageContentStream content = new PDPageContentStream(
        document, page, PDPageContentStream.AppendMode.APPEND, true, true)) {
      content.setNonStrokingColor(1f, 0.302f, 0.333f);
      content.setStrokingColor(0.871f, 0.208f, 0.259f);
      content.setLineWidth(1f);
      content.setLineJoinStyle(1);

      for (AnnotationStroke shape : shapes) {
        if (shape.width <= 0 || shape.height <= 0) continue;
        if (blurSource != null && styleFlag(shape, 18, false) && styleFlag(shape, 19, false)) {
          drawBackgroundBlur(document, content, page, shape, blurSource);
        }
        drawObjectShadow(content, page, shape);
        applyObjectStyle(content, shape);
        if ("watermark".equals(shape.type)) {
          drawWatermark(content, page, shape);
          continue;
        } else if ("signature".equals(shape.type) || "image".equals(shape.type)) {
          drawPlacedImage(document, content, page, shape);
          if ("image".equals(shape.type) && styleFlag(shape, 10, true) && styleFlag(shape, 11, true)) {
            appendRoundedRectangle(content, page, shape);
            content.stroke();
          }
          continue;
        } else if ("textfield".equals(shape.type)) {
          drawTextField(document, content, page, shape);
          continue;
        } else if ("check".equals(shape.type)) {
          if (!styleFlag(shape, 10, true) || !styleFlag(shape, 11, true)) continue;
          PdfPoint start = shapePoint(page, shape, 0.08, 0.54);
          PdfPoint middle = shapePoint(page, shape, 0.38, 0.82);
          PdfPoint end = shapePoint(page, shape, 0.92, 0.16);
          content.moveTo(start.x, start.y);
          content.lineTo(middle.x, middle.y);
          content.lineTo(end.x, end.y);
          content.stroke();
          continue;
        } else if ("cross".equals(shape.type)) {
          if (!styleFlag(shape, 10, true) || !styleFlag(shape, 11, true)) continue;
          PdfPoint firstStart = shapePoint(page, shape, 0.14, 0.14);
          PdfPoint firstEnd = shapePoint(page, shape, 0.86, 0.86);
          PdfPoint secondStart = shapePoint(page, shape, 0.86, 0.14);
          PdfPoint secondEnd = shapePoint(page, shape, 0.14, 0.86);
          content.moveTo(firstStart.x, firstStart.y);
          content.lineTo(firstEnd.x, firstEnd.y);
          content.moveTo(secondStart.x, secondStart.y);
          content.lineTo(secondEnd.x, secondEnd.y);
          content.stroke();
          continue;
        } else if ("line".equals(shape.type) || "arrow".equals(shape.type)) {
          if (!styleFlag(shape, 10, true) || !styleFlag(shape, 11, true)) continue;
          PdfPoint start = shapePoint(page, shape, 0, 0.5);
          PdfPoint end = shapePoint(page, shape, 1, 0.5);
          content.moveTo(start.x, start.y);
          content.lineTo(end.x, end.y);
          content.stroke();
          if ("arrow".equals(shape.type)) {
            appendArrowHead(content, start, end);
            content.stroke();
          }
          continue;
        }

        boolean fill = styleFlag(shape, 8, true) && styleFlag(shape, 9, true);
        boolean stroke = styleFlag(shape, 10, true) && styleFlag(shape, 11, true);
        if (!fill && !stroke) continue;
        if ("triangle".equals(shape.type)) {
          appendRoundedTriangle(content, page, shape);
        } else if ("circle".equals(shape.type)) {
          appendEllipse(content, page, shape);
        } else if ("rectangle".equals(shape.type)) {
          appendRoundedRectangle(content, page, shape);
        } else {
          continue;
        }
        if (fill && stroke) content.fillAndStroke();
        else if (fill) content.fill();
        else content.stroke();
      }
    }
  }

  private static double styleValue(AnnotationStroke shape, int index, double fallback) {
    if (shape.color == null || index < 0 || index >= shape.color.size()) return fallback;
    double value = shape.color.get(index);
    return Double.isFinite(value) ? value : fallback;
  }

  private static void drawBackgroundBlur(
      PDDocument document,
      PDPageContentStream content,
      PDPage page,
      AnnotationStroke shape,
      BufferedImage source) throws IOException {
    int left = Math.max(0, Math.min(source.getWidth() - 1, (int) Math.floor(shape.x * source.getWidth())));
    int top = Math.max(0, Math.min(source.getHeight() - 1, (int) Math.floor(shape.y * source.getHeight())));
    int right = Math.max(left + 1, Math.min(source.getWidth(), (int) Math.ceil((shape.x + shape.width) * source.getWidth())));
    int bottom = Math.max(top + 1, Math.min(source.getHeight(), (int) Math.ceil((shape.y + shape.height) * source.getHeight())));
    BufferedImage crop = new BufferedImage(right - left, bottom - top, BufferedImage.TYPE_INT_RGB);
    crop.getGraphics().drawImage(source, -left, -top, null);
    int radius = Math.max(1, Math.min(15, (int) Math.round(styleValue(shape, 20, 8) * 0.75)));
    int size = radius * 2 + 1;
    float[] weights = new float[size * size];
    Arrays.fill(weights, 1f / weights.length);
    BufferedImage blurred = new ConvolveOp(new Kernel(size, size, weights), ConvolveOp.EDGE_NO_OP, null).filter(crop, null);
    PDImageXObject image = LosslessFactory.createFromImage(document, blurred);
    content.saveGraphicsState();
    float opacity = (float) Math.max(0, Math.min(1, styleValue(shape, 6, 1)));
    PDExtendedGraphicsState graphicsState = new PDExtendedGraphicsState();
    graphicsState.setNonStrokingAlphaConstant(opacity);
    graphicsState.setStrokingAlphaConstant(opacity);
    content.setGraphicsStateParameters(graphicsState);
    appendClosedObjectPath(content, page, shape);
    content.clip();
    PdfPoint bottomLeft = shapePoint(page, shape, 0, 1);
    PdfPoint bottomRight = shapePoint(page, shape, 1, 1);
    PdfPoint topLeft = shapePoint(page, shape, 0, 0);
    content.drawImage(image, new Matrix(
        bottomRight.x - bottomLeft.x,
        bottomRight.y - bottomLeft.y,
        topLeft.x - bottomLeft.x,
        topLeft.y - bottomLeft.y,
        bottomLeft.x,
        bottomLeft.y));
    content.restoreGraphicsState();
  }

  private static void appendClosedObjectPath(
      PDPageContentStream content,
      PDPage page,
      AnnotationStroke shape) throws IOException {
    if ("circle".equals(shape.type)) {
      appendEllipse(content, page, shape);
    } else if ("triangle".equals(shape.type)) {
      appendRoundedTriangle(content, page, shape);
    } else {
      appendRoundedRectangle(content, page, shape);
    }
  }

  private static void drawObjectShadow(
      PDPageContentStream content,
      PDPage page,
      AnnotationStroke shape) throws IOException {
    if (!styleFlag(shape, 12, false) || !styleFlag(shape, 13, false) ||
        "watermark".equals(shape.type) || "textfield".equals(shape.type)) return;
    double opacity = Math.max(0, Math.min(1, styleValue(shape, 14, 0.25)));
    if (opacity <= 0) return;
    double blur = Math.max(0, styleValue(shape, 15, 6)) / EDITOR_PAGE_SCALE;
    double baseX = styleValue(shape, 16, 0) / EDITOR_PAGE_SCALE;
    double baseY = -styleValue(shape, 17, 3) / EDITOR_PAGE_SCALE;
    int samples = blur > 0.25 ? 9 : 1;
    for (int sample = 0; sample < samples; sample += 1) {
      double angle = samples == 1 ? 0 : Math.PI * 2 * sample / (samples - 1);
      double radius = samples == 1 || sample == samples - 1 ? 0 : blur * 0.55;
      content.saveGraphicsState();
      content.transform(Matrix.getTranslateInstance(
          (float) (baseX + Math.cos(angle) * radius),
          (float) (baseY + Math.sin(angle) * radius)));
      content.setNonStrokingColor(0f, 0f, 0f);
      content.setStrokingColor(0f, 0f, 0f);
      content.setLineWidth((float) Math.max(0.05, styleValue(shape, 7, 1.35) / EDITOR_PAGE_SCALE));
      PDExtendedGraphicsState graphicsState = new PDExtendedGraphicsState();
      float sampleOpacity = (float) (opacity / (samples == 1 ? 1 : 3.2));
      graphicsState.setNonStrokingAlphaConstant(sampleOpacity);
      graphicsState.setStrokingAlphaConstant(sampleOpacity);
      content.setGraphicsStateParameters(graphicsState);
      if ("line".equals(shape.type) || "arrow".equals(shape.type)) {
        PdfPoint start = shapePoint(page, shape, 0, 0.5);
        PdfPoint end = shapePoint(page, shape, 1, 0.5);
        content.moveTo(start.x, start.y);
        content.lineTo(end.x, end.y);
        content.stroke();
      } else if ("check".equals(shape.type)) {
        PdfPoint start = shapePoint(page, shape, 0.08, 0.54);
        PdfPoint middle = shapePoint(page, shape, 0.38, 0.82);
        PdfPoint end = shapePoint(page, shape, 0.92, 0.16);
        content.moveTo(start.x, start.y);
        content.lineTo(middle.x, middle.y);
        content.lineTo(end.x, end.y);
        content.stroke();
      } else if ("cross".equals(shape.type)) {
        PdfPoint a = shapePoint(page, shape, 0.14, 0.14);
        PdfPoint b = shapePoint(page, shape, 0.86, 0.86);
        PdfPoint c = shapePoint(page, shape, 0.86, 0.14);
        PdfPoint d = shapePoint(page, shape, 0.14, 0.86);
        content.moveTo(a.x, a.y);
        content.lineTo(b.x, b.y);
        content.moveTo(c.x, c.y);
        content.lineTo(d.x, d.y);
        content.stroke();
      } else {
        appendClosedObjectPath(content, page, shape);
        content.fill();
      }
      content.restoreGraphicsState();
    }
  }

  private static boolean styleFlag(AnnotationStroke shape, int index, boolean fallback) {
    return styleValue(shape, index, fallback ? 1 : 0) >= 0.5;
  }

  private static float styleChannel(AnnotationStroke shape, int index, float fallback) {
    return (float) Math.max(0, Math.min(1, styleValue(shape, index, fallback)));
  }

  private static void applyObjectStyle(PDPageContentStream content, AnnotationStroke shape) throws IOException {
    boolean hasObjectStyle = shape.color != null && shape.color.size() >= 12;
    if (!hasObjectStyle) {
      content.setNonStrokingColor(1f, 0.302f, 0.333f);
      content.setStrokingColor(0.871f, 0.208f, 0.259f);
      content.setLineWidth(("check".equals(shape.type) || "cross".equals(shape.type)) ? 1.25f :
          (("line".equals(shape.type) || "arrow".equals(shape.type)) ? 1.05f : 1f));
      PDExtendedGraphicsState graphicsState = new PDExtendedGraphicsState();
      graphicsState.setNonStrokingAlphaConstant(1f);
      graphicsState.setStrokingAlphaConstant(1f);
      content.setGraphicsStateParameters(graphicsState);
      return;
    }
    content.setNonStrokingColor(styleChannel(shape, 0, 1f), styleChannel(shape, 1, 0.302f), styleChannel(shape, 2, 0.333f));
    content.setStrokingColor(styleChannel(shape, 3, 0.871f), styleChannel(shape, 4, 0.208f), styleChannel(shape, 5, 0.259f));
    content.setLineWidth((float) Math.max(0.05, styleValue(shape, 7, 1.35) / EDITOR_PAGE_SCALE));
    float opacity = (float) Math.max(0, Math.min(1, styleValue(shape, 6, 1)));
    float fillOpacity = (float) Math.max(0, Math.min(1, opacity * styleValue(shape, 21, 1)));
    float strokeOpacity = (float) Math.max(0, Math.min(1, opacity * styleValue(shape, 22, 1)));
    PDExtendedGraphicsState graphicsState = new PDExtendedGraphicsState();
    graphicsState.setNonStrokingAlphaConstant(fillOpacity);
    graphicsState.setStrokingAlphaConstant(strokeOpacity);
    content.setGraphicsStateParameters(graphicsState);
  }

  private static void drawWatermark(
      PDPageContentStream content,
      PDPage page,
      AnnotationStroke shape) throws IOException {
    PDFont font = new PDType1Font(Standard14Fonts.FontName.HELVETICA_BOLD);
    String text = standardFontText(font, shape.text == null ? "" : shape.text.trim(), 80);
    if (text.isBlank()) return;

    PdfPoint leftCenter = shapePoint(page, shape, 0, 0.5);
    PdfPoint rightCenter = shapePoint(page, shape, 1, 0.5);
    PdfPoint topCenter = shapePoint(page, shape, 0.5, 0);
    PdfPoint bottomCenter = shapePoint(page, shape, 0.5, 1);
    PdfPoint center = shapePoint(page, shape, 0.5, 0.5);
    double directionX = rightCenter.x - leftCenter.x;
    double directionY = rightCenter.y - leftCenter.y;
    double availableWidth = Math.hypot(directionX, directionY);
    double availableHeight = Math.hypot(bottomCenter.x - topCenter.x, bottomCenter.y - topCenter.y);
    if (availableWidth < 1 || availableHeight < 1) return;

    double unitX = directionX / availableWidth;
    double unitY = directionY / availableWidth;
    double textWidth = font.getStringWidth(text) / 1000.0;
    float fontSize = (float) Math.max(8, Math.min(availableHeight * 0.45, availableWidth / Math.max(0.001, textWidth)));
    double renderedWidth = textWidth * fontSize;
    double normalX = -unitY;
    double normalY = unitX;
    float startX = (float) (center.x - unitX * renderedWidth / 2 - normalX * fontSize * 0.35);
    float startY = (float) (center.y - unitY * renderedWidth / 2 - normalY * fontSize * 0.35);

    PDExtendedGraphicsState graphicsState = new PDExtendedGraphicsState();
    graphicsState.setNonStrokingAlphaConstant(0.17f);
    graphicsState.setBlendMode(BlendMode.MULTIPLY);
    content.saveGraphicsState();
    content.setGraphicsStateParameters(graphicsState);
    content.setNonStrokingColor(0.31f, 0.34f, 0.38f);
    content.beginText();
    content.setFont(font, fontSize);
    content.setTextMatrix(new Matrix(
        (float) unitX,
        (float) unitY,
        (float) -unitY,
        (float) unitX,
        startX,
        startY));
    content.showText(text);
    content.endText();
    content.restoreGraphicsState();
  }

  private static String standardFontText(PDFont font, String value, int maximumCharacters) {
    StringBuilder result = new StringBuilder();
    int characters = 0;
    for (int offset = 0; offset < value.length() && characters < maximumCharacters;) {
      int codePoint = value.codePointAt(offset);
      offset += Character.charCount(codePoint);
      String character = new String(Character.toChars(codePoint));
      try {
        font.encode(character);
        result.append(character);
      } catch (Exception ignored) {
        result.append('?');
      }
      characters += 1;
    }
    return result.toString();
  }

  private static void drawPlacedImage(
      PDDocument document,
      PDPageContentStream content,
      PDPage page,
      AnnotationStroke shape) throws IOException {
    if (shape.imageData == null || shape.imageData.isBlank()) return;
    int comma = shape.imageData.indexOf(',');
    String encoded = comma >= 0 ? shape.imageData.substring(comma + 1) : shape.imageData;
    byte[] imageBytes;
    try {
      imageBytes = Base64.getDecoder().decode(encoded);
    } catch (IllegalArgumentException error) {
      throw new IOException("Invalid placed image data.", error);
    }
    if (imageBytes.length > 12 * 1024 * 1024) {
      throw new IOException("Placed image is too large.");
    }
    PDImageXObject image = PDImageXObject.createFromByteArray(document, imageBytes, "placed-image.png");
    PdfPoint bottomLeft = shapePoint(page, shape, 0, 1);
    PdfPoint bottomRight = shapePoint(page, shape, 1, 1);
    PdfPoint topLeft = shapePoint(page, shape, 0, 0);
    content.drawImage(image, new Matrix(
        bottomRight.x - bottomLeft.x,
        bottomRight.y - bottomLeft.y,
        topLeft.x - bottomLeft.x,
        topLeft.y - bottomLeft.y,
        bottomLeft.x,
        bottomLeft.y));
  }

  private static void drawTextField(
      PDDocument document,
      PDPageContentStream content,
      PDPage page,
      AnnotationStroke shape) throws IOException {
    String text = sanitizeWinAnsi(shape.text == null ? "" : shape.text)
        .replace("\r\n", "\n")
        .replace('\r', '\n')
        .replace('\t', ' ');
    if (text.isBlank()) return;

    String fontFamily = textStyleString(shape, "fontFamily", "Helvetica");
    int fontWeight = (int) textStyleNumber(shape, "fontWeight", 400);
    boolean italic = textStyleBoolean(shape, "italic", false);
    boolean underline = textStyleBoolean(shape, "underline", false);
    boolean strikethrough = textStyleBoolean(shape, "strikethrough", false);
    PDFont font = textFieldFont(document, fontFamily, fontWeight, italic);
    PdfPoint topLeft = shapePoint(page, shape, 0, 0);
    PdfPoint bottomLeft = shapePoint(page, shape, 0, 1);
    PdfPoint leftCenter = shapePoint(page, shape, 0, 0.5);
    PdfPoint rightCenter = shapePoint(page, shape, 1, 0.5);
    double physicalHeight = Math.hypot(bottomLeft.x - topLeft.x, bottomLeft.y - topLeft.y);
    double physicalWidth = Math.hypot(rightCenter.x - leftCenter.x, rightCenter.y - leftCenter.y);
    // PDF.js renders page coordinates at 1.35 CSS units per PDF point. Convert
    // every text metric back to PDF points so export matches the SVG editor.
    float fontSize = (float) Math.max(6, textStyleNumber(shape, "fontSize", 16)) / EDITOR_PAGE_SCALE;
    float letterSpacing = (float) textStyleNumber(shape, "letterSpacing", 0) / EDITOR_PAGE_SCALE;
    float horizontalPadding = 6f / EDITOR_PAGE_SCALE;
    float availableWidth = (float) Math.max(1, physicalWidth - horizontalPadding * 2);
    List<String> lines = wrapTextFieldLines(document, font, fontSize, letterSpacing, availableWidth, text);

    double angle = Math.atan2(rightCenter.y - leftCenter.y, rightCenter.x - leftCenter.x);
    float cosine = (float) Math.cos(angle);
    float sine = (float) Math.sin(angle);
    float[] textColor = parseTextColor(textStyleString(shape, "color", "#171717"));
    content.setNonStrokingColor(textColor[0], textColor[1], textColor[2]);
    content.setStrokingColor(textColor[0], textColor[1], textColor[2]);
    float lineHeight = (float) Math.max(fontSize * EDITOR_PAGE_SCALE, textStyleNumber(shape, "lineHeight", 19.2)) / EDITOR_PAGE_SCALE;
    String verticalAlignment = textStyleString(shape, "verticalAlign", "top");
    double contentHeight = lines.size() * lineHeight;
    double firstBaseline = fontSize * 0.95;
    if ("middle".equals(verticalAlignment)) firstBaseline += Math.max(0, (physicalHeight - contentHeight) / 2);
    else if ("bottom".equals(verticalAlignment)) firstBaseline += Math.max(0, physicalHeight - contentHeight - 3f / EDITOR_PAGE_SCALE);
    int sourceCursor = 0;
    for (int lineIndex = 0; lineIndex < lines.size(); lineIndex += 1) {
      String line = lines.get(lineIndex);
      int sourceStart = line.isEmpty() ? sourceCursor : text.indexOf(line, sourceCursor);
      if (sourceStart < 0) sourceStart = sourceCursor;
      int sourceEnd = Math.min(text.length(), sourceStart + line.length());
      sourceCursor = sourceEnd;
      while (sourceCursor < text.length() && (text.charAt(sourceCursor) == ' ' || text.charAt(sourceCursor) == '\n')) sourceCursor += 1;
      List<PdfTextSegment> segments = pdfTextSegments(document, shape, text, sourceStart, sourceEnd);
      String horizontalAlignment = resolvedPdfTextAlignment(shape, sourceStart);
      float lineWidth = 0;
      for (PdfTextSegment segment : segments) {
        lineWidth += textWidth(document, segment.style.font, segment.style.fontSize, segment.style.letterSpacing, segment.text);
      }
      double startDistance = horizontalPadding;
      if ("center".equals(horizontalAlignment)) startDistance = (physicalWidth - lineWidth) / 2;
      else if ("right".equals(horizontalAlignment)) startDistance = physicalWidth - horizontalPadding - lineWidth;
      startDistance = Math.max(0, startDistance);
      double baselineDistance = firstBaseline + lineIndex * lineHeight;
      double advance = 0;
      for (PdfTextSegment segment : segments) {
        float segmentWidth = textWidth(document, segment.style.font, segment.style.fontSize, segment.style.letterSpacing, segment.text);
        content.setNonStrokingColor(segment.style.color[0], segment.style.color[1], segment.style.color[2]);
        content.setStrokingColor(segment.style.color[0], segment.style.color[1], segment.style.color[2]);
        // Characters the PDF font can't encode (arrows, math, other scripts)
        // are drawn in an embedded fallback font instead of failing the export.
        double runAdvance = 0;
        for (FontRun run : fontRuns(document, segment.style.font, segment.text)) {
          double localX = (startDistance + advance + runAdvance) / Math.max(1, physicalWidth);
          PdfPoint baseline = shapePoint(page, shape, localX, baselineDistance / Math.max(1, physicalHeight));
          content.beginText();
          content.setFont(run.font(), segment.style.fontSize);
          content.setCharacterSpacing(segment.style.letterSpacing);
          content.setTextMatrix(new Matrix(cosine, sine, -sine, cosine, baseline.x, baseline.y));
          content.showText(run.text());
          content.endText();
          runAdvance += run.font().getStringWidth(run.text()) / 1000f * segment.style.fontSize
              + run.text().codePointCount(0, run.text().length()) * segment.style.letterSpacing;
        }
        if (!segment.text.isEmpty() && (segment.style.underline || segment.style.strikethrough)) {
          double segmentEnd = startDistance + advance + segmentWidth;
          if (segment.style.underline) {
            double decorationY = baselineDistance + 1.8 / EDITOR_PAGE_SCALE;
            drawTextDecoration(content, page, shape, startDistance + advance, segmentEnd, physicalWidth, physicalHeight, decorationY, segment.style.fontSize);
          }
          if (segment.style.strikethrough) {
            double decorationY = baselineDistance - segment.style.fontSize * 0.32;
            drawTextDecoration(content, page, shape, startDistance + advance, segmentEnd, physicalWidth, physicalHeight, decorationY, segment.style.fontSize);
          }
        }
        advance += segmentWidth;
      }
    }
    content.setCharacterSpacing(0);
    content.setNonStrokingColor(1f, 0.302f, 0.333f);
    content.setStrokingColor(0.871f, 0.208f, 0.259f);
  }

  private static void drawTextDecoration(
      PDPageContentStream content,
      PDPage page,
      AnnotationStroke shape,
      double startDistance,
      double endDistance,
      double physicalWidth,
      double physicalHeight,
      double localY,
      float fontSize) throws IOException {
    PdfPoint start = shapePoint(page, shape, startDistance / Math.max(1, physicalWidth), localY / Math.max(1, physicalHeight));
    PdfPoint end = shapePoint(page, shape, endDistance / Math.max(1, physicalWidth), localY / Math.max(1, physicalHeight));
    content.setLineWidth(Math.max(0.55f, fontSize * 0.065f));
    content.moveTo(start.x, start.y);
    content.lineTo(end.x, end.y);
    content.stroke();
  }

  private static List<PdfTextSegment> pdfTextSegments(
      PDDocument document,
      AnnotationStroke shape,
      String text,
      int start,
      int end) {
    if (end <= start) return List.of(new PdfTextSegment("", resolvedPdfTextStyle(document, shape, start)));
    List<Integer> boundaries = new ArrayList<>();
    boundaries.add(start);
    boundaries.add(end);
    for (Map<String, Object> range : shape.textStyleRanges) {
      int rangeStart = (int) optionalDouble(range.get("start"));
      int rangeEnd = (int) optionalDouble(range.get("end"));
      if (rangeStart > start && rangeStart < end) boundaries.add(rangeStart);
      if (rangeEnd > start && rangeEnd < end) boundaries.add(rangeEnd);
    }
    Collections.sort(boundaries);
    List<PdfTextSegment> segments = new ArrayList<>();
    for (int index = 0; index + 1 < boundaries.size(); index += 1) {
      int segmentStart = boundaries.get(index);
      int segmentEnd = boundaries.get(index + 1);
      if (segmentEnd <= segmentStart) continue;
      segments.add(new PdfTextSegment(text.substring(segmentStart, segmentEnd), resolvedPdfTextStyle(document, shape, segmentStart)));
    }
    return segments;
  }

  private static PdfTextStyle resolvedPdfTextStyle(PDDocument document, AnnotationStroke shape, int index) {
    Map<String, Object> base = shape.textStyle == null ? Map.of() : shape.textStyle;
    String color = mapString(base, "color", "#171717");
    String family = mapString(base, "fontFamily", "Helvetica");
    int weight = (int) mapNumber(base, "fontWeight", 400);
    double size = mapNumber(base, "fontSize", 16);
    double spacing = mapNumber(base, "letterSpacing", 0);
    boolean italic = mapBoolean(base, "italic", false);
    boolean underline = mapBoolean(base, "underline", false);
    boolean strikethrough = mapBoolean(base, "strikethrough", false);
    for (Map<String, Object> range : shape.textStyleRanges) {
      int start = (int) optionalDouble(range.get("start"));
      int end = (int) optionalDouble(range.get("end"));
      if (index < start || index >= end) continue;
      color = mapString(range, "color", color);
      family = mapString(range, "fontFamily", family);
      weight = (int) mapNumber(range, "fontWeight", weight);
      size = mapNumber(range, "fontSize", size);
      spacing = mapNumber(range, "letterSpacing", spacing);
      italic = mapBoolean(range, "italic", italic);
      underline = mapBoolean(range, "underline", underline);
      strikethrough = mapBoolean(range, "strikethrough", strikethrough);
    }
    return new PdfTextStyle(
        textFieldFont(document, family, weight, italic),
        (float) Math.max(6, size) / EDITOR_PAGE_SCALE,
        (float) spacing / EDITOR_PAGE_SCALE,
        parseTextColor(color),
        underline,
        strikethrough);
  }

  private static String resolvedPdfTextAlignment(AnnotationStroke shape, int index) {
    String alignment = mapString(shape.textStyle == null ? Map.of() : shape.textStyle, "textAlign", "left");
    for (Map<String, Object> range : shape.textStyleRanges) {
      int start = (int) optionalDouble(range.get("start"));
      int end = (int) optionalDouble(range.get("end"));
      if (index >= start && index < end) alignment = mapString(range, "textAlign", alignment);
    }
    return alignment;
  }

  private static String mapString(Map<String, Object> map, String key, String fallback) {
    Object value = map.get(key);
    return value instanceof String string && !string.isBlank() ? string : fallback;
  }

  private static double mapNumber(Map<String, Object> map, String key, double fallback) {
    Object value = map.get(key);
    return value instanceof Number number && Double.isFinite(number.doubleValue()) ? number.doubleValue() : fallback;
  }

  private static boolean mapBoolean(Map<String, Object> map, String key, boolean fallback) {
    Object value = map.get(key);
    return value instanceof Boolean bool ? bool : fallback;
  }

  private static String textStyleString(AnnotationStroke shape, String key, String fallback) {
    Object value = shape.textStyle == null ? null : shape.textStyle.get(key);
    return value instanceof String string && !string.isBlank() ? string : fallback;
  }

  private static double textStyleNumber(AnnotationStroke shape, String key, double fallback) {
    Object value = shape.textStyle == null ? null : shape.textStyle.get(key);
    return value instanceof Number number && Double.isFinite(number.doubleValue()) ? number.doubleValue() : fallback;
  }

  private static boolean textStyleBoolean(AnnotationStroke shape, String key, boolean fallback) {
    Object value = shape.textStyle == null ? null : shape.textStyle.get(key);
    return value instanceof Boolean bool ? bool : fallback;
  }

  /**
   * Static TrueType files for the text box fonts the editor offers beyond the
   * built-in PDF fonts, by family: regular, bold, italic, bold italic. The
   * first file that exists on this computer is embedded; otherwise the text
   * falls back to the closest built-in PDF font.
   */
  private static final Map<String, String[][]> TEXT_FONT_FILES = Map.of(
      "arial", new String[][] {
          {"/System/Library/Fonts/Supplemental/Arial.ttf", "C:\\Windows\\Fonts\\arial.ttf", "/usr/share/fonts/truetype/msttcorefonts/Arial.ttf"},
          {"/System/Library/Fonts/Supplemental/Arial Bold.ttf", "C:\\Windows\\Fonts\\arialbd.ttf", "/usr/share/fonts/truetype/msttcorefonts/Arial_Bold.ttf"},
          {"/System/Library/Fonts/Supplemental/Arial Italic.ttf", "C:\\Windows\\Fonts\\ariali.ttf", "/usr/share/fonts/truetype/msttcorefonts/Arial_Italic.ttf"},
          {"/System/Library/Fonts/Supplemental/Arial Bold Italic.ttf", "C:\\Windows\\Fonts\\arialbi.ttf", "/usr/share/fonts/truetype/msttcorefonts/Arial_Bold_Italic.ttf"}},
      "georgia", new String[][] {
          {"/System/Library/Fonts/Supplemental/Georgia.ttf", "C:\\Windows\\Fonts\\georgia.ttf"},
          {"/System/Library/Fonts/Supplemental/Georgia Bold.ttf", "C:\\Windows\\Fonts\\georgiab.ttf"},
          {"/System/Library/Fonts/Supplemental/Georgia Italic.ttf", "C:\\Windows\\Fonts\\georgiai.ttf"},
          {"/System/Library/Fonts/Supplemental/Georgia Bold Italic.ttf", "C:\\Windows\\Fonts\\georgiaz.ttf"}},
      "verdana", new String[][] {
          {"/System/Library/Fonts/Supplemental/Verdana.ttf", "C:\\Windows\\Fonts\\verdana.ttf"},
          {"/System/Library/Fonts/Supplemental/Verdana Bold.ttf", "C:\\Windows\\Fonts\\verdanab.ttf"},
          {"/System/Library/Fonts/Supplemental/Verdana Italic.ttf", "C:\\Windows\\Fonts\\verdanai.ttf"},
          {"/System/Library/Fonts/Supplemental/Verdana Bold Italic.ttf", "C:\\Windows\\Fonts\\verdanaz.ttf"}},
      "trebuchetms", new String[][] {
          {"/System/Library/Fonts/Supplemental/Trebuchet MS.ttf", "C:\\Windows\\Fonts\\trebuc.ttf"},
          {"/System/Library/Fonts/Supplemental/Trebuchet MS Bold.ttf", "C:\\Windows\\Fonts\\trebucbd.ttf"},
          {"/System/Library/Fonts/Supplemental/Trebuchet MS Italic.ttf", "C:\\Windows\\Fonts\\trebucit.ttf"},
          {"/System/Library/Fonts/Supplemental/Trebuchet MS Bold Italic.ttf", "C:\\Windows\\Fonts\\trebucbi.ttf"}},
      "timesnewroman", new String[][] {
          {"/System/Library/Fonts/Supplemental/Times New Roman.ttf", "C:\\Windows\\Fonts\\times.ttf"},
          {"/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf", "C:\\Windows\\Fonts\\timesbd.ttf"},
          {"/System/Library/Fonts/Supplemental/Times New Roman Italic.ttf", "C:\\Windows\\Fonts\\timesi.ttf"},
          {"/System/Library/Fonts/Supplemental/Times New Roman Bold Italic.ttf", "C:\\Windows\\Fonts\\timesbi.ttf"}},
      "couriernew", new String[][] {
          {"/System/Library/Fonts/Supplemental/Courier New.ttf", "C:\\Windows\\Fonts\\cour.ttf"},
          {"/System/Library/Fonts/Supplemental/Courier New Bold.ttf", "C:\\Windows\\Fonts\\courbd.ttf"},
          {"/System/Library/Fonts/Supplemental/Courier New Italic.ttf", "C:\\Windows\\Fonts\\couri.ttf"},
          {"/System/Library/Fonts/Supplemental/Courier New Bold Italic.ttf", "C:\\Windows\\Fonts\\courbi.ttf"}});

  private static PDFont textFieldFont(PDDocument document, String family, int weight, boolean italic) {
    String[][] variants = TEXT_FONT_FILES.get(normalizeFontName(family));
    if (variants != null) {
      boolean bold = weight >= 600;
      for (String path : variants[(bold ? 1 : 0) + (italic ? 2 : 0)]) {
        PDFont embedded = embeddedFontFile(document, path);
        if (embedded != null) return embedded;
      }
    }
    return standardTextFieldFont(family, weight, italic);
  }

  /** Loads a TrueType file into the output document once and reuses it. */
  private static PDFont embeddedFontFile(PDDocument document, String path) {
    File file = new File(path);
    if (!file.isFile()) return null;
    FontFallbacks cache = FONT_FALLBACKS.computeIfAbsent(document, ignored -> new FontFallbacks());
    synchronized (cache) {
      if (cache.files.containsKey(path)) return cache.files.get(path);
      PDFont font = null;
      try {
        font = PDType0Font.load(document, file);
      } catch (IOException | RuntimeException ignored) {
        // Not embeddable: use the built-in font instead.
      }
      cache.files.put(path, font);
      return font;
    }
  }

  private static PDFont standardTextFieldFont(String family, int weight, boolean italic) {
    boolean bold = weight >= 600;
    String normalized = family.toLowerCase(Locale.ROOT);
    Standard14Fonts.FontName name;
    if (normalized.contains("times") || normalized.contains("georgia")) {
      name = bold && italic ? Standard14Fonts.FontName.TIMES_BOLD_ITALIC
          : bold ? Standard14Fonts.FontName.TIMES_BOLD
          : italic ? Standard14Fonts.FontName.TIMES_ITALIC
          : Standard14Fonts.FontName.TIMES_ROMAN;
    } else if (normalized.contains("courier")) {
      name = bold && italic ? Standard14Fonts.FontName.COURIER_BOLD_OBLIQUE
          : bold ? Standard14Fonts.FontName.COURIER_BOLD
          : italic ? Standard14Fonts.FontName.COURIER_OBLIQUE
          : Standard14Fonts.FontName.COURIER;
    } else {
      name = bold && italic ? Standard14Fonts.FontName.HELVETICA_BOLD_OBLIQUE
          : bold ? Standard14Fonts.FontName.HELVETICA_BOLD
          : italic ? Standard14Fonts.FontName.HELVETICA_OBLIQUE
          : Standard14Fonts.FontName.HELVETICA;
    }
    return new PDType1Font(name);
  }

  private static float[] parseTextColor(String color) {
    if (color != null && color.matches("#[0-9A-Fa-f]{6}")) {
      return new float[] {
          Integer.parseInt(color.substring(1, 3), 16) / 255f,
          Integer.parseInt(color.substring(3, 5), 16) / 255f,
          Integer.parseInt(color.substring(5, 7), 16) / 255f
      };
    }
    return new float[] {0.09f, 0.09f, 0.09f};
  }

  private static float textWidth(PDDocument document, PDFont font, float fontSize, float letterSpacing, String text) throws IOException {
    if (text.isEmpty()) return 0;
    float width = 0;
    for (FontRun run : fontRuns(document, font, text)) width += run.font().getStringWidth(run.text()) / 1000f * fontSize;
    return width + Math.max(0, text.codePointCount(0, text.length()) - 1) * letterSpacing;
  }

  /**
   * TrueType fonts embedded for characters the standard PDF fonts can't
   * encode. The first one that has the glyph is used; when none has it the
   * character becomes "?" so the export still succeeds.
   */
  private static final String[] FALLBACK_FONT_FILES = {
      "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
      "/Library/Fonts/Arial Unicode.ttf",
      "/System/Library/Fonts/Apple Symbols.ttf",
      "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
      "/usr/share/fonts/dejavu/DejaVuSans.ttf",
      "/usr/share/fonts/TTF/DejaVuSans.ttf",
      "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
      "/usr/share/fonts/noto/NotoSans-Regular.ttf",
      "/usr/share/fonts/truetype/noto/NotoSansMath-Regular.ttf",
      "/usr/share/fonts/truetype/noto/NotoSansSymbols2-Regular.ttf",
      "C:\\Windows\\Fonts\\segoeui.ttf",
      "C:\\Windows\\Fonts\\seguisym.ttf",
      "C:\\Windows\\Fonts\\arial.ttf"
  };

  private record FontRun(String text, PDFont font) {}

  /** Fallback fonts are loaded once per output document, and only when a text needs them. */
  private static final class FontFallbacks {
    List<PDFont> fonts;
    final Map<String, PDFont> files = new HashMap<>();
    final Map<PDFont, Map<Integer, PDFont>> choices = new IdentityHashMap<>();
  }

  private static final Map<PDDocument, FontFallbacks> FONT_FALLBACKS = Collections.synchronizedMap(new WeakHashMap<>());

  private static List<FontRun> fontRuns(PDDocument document, PDFont primary, String text) {
    List<FontRun> runs = new ArrayList<>();
    StringBuilder current = new StringBuilder();
    PDFont currentFont = primary;
    for (int offset = 0; offset < text.length();) {
      int codePoint = text.codePointAt(offset);
      offset += Character.charCount(codePoint);
      PDFont font = glyphFont(document, primary, codePoint);
      String character = font == null ? "?" : new String(Character.toChars(codePoint));
      if (font == null) font = primary;
      if (font != currentFont && current.length() > 0) {
        runs.add(new FontRun(current.toString(), currentFont));
        current.setLength(0);
      }
      currentFont = font;
      current.append(character);
    }
    if (current.length() > 0) runs.add(new FontRun(current.toString(), currentFont));
    return runs;
  }

  /** The font that draws this character: the requested one when it can, else the first fallback with the glyph. */
  private static PDFont glyphFont(PDDocument document, PDFont primary, int codePoint) {
    if (canEncode(primary, codePoint)) return primary;
    FontFallbacks fallbacks = FONT_FALLBACKS.computeIfAbsent(document, ignored -> new FontFallbacks());
    synchronized (fallbacks) {
      Map<Integer, PDFont> choices = fallbacks.choices.computeIfAbsent(primary, ignored -> new HashMap<>());
      if (choices.containsKey(codePoint)) return choices.get(codePoint);
      if (fallbacks.fonts == null) {
        fallbacks.fonts = new ArrayList<>();
        for (String path : FALLBACK_FONT_FILES) {
          PDFont font = embeddedFontFile(document, path);
          if (font != null) fallbacks.fonts.add(font);
        }
      }
      PDFont chosen = null;
      for (PDFont font : fallbacks.fonts) {
        if (canEncode(font, codePoint)) {
          chosen = font;
          break;
        }
      }
      choices.put(codePoint, chosen);
      return chosen;
    }
  }

  private static boolean canEncode(PDFont font, int codePoint) {
    try {
      return font.encode(new String(Character.toChars(codePoint))).length > 0;
    } catch (IOException | RuntimeException error) {
      return false;
    }
  }

  private static List<String> wrapTextFieldLines(
      PDDocument document,
      PDFont font,
      float fontSize,
      float letterSpacing,
      float availableWidth,
      String text) throws IOException {
    List<String> lines = new ArrayList<>();
    for (String paragraph : text.split("\n", -1)) {
      if (paragraph.isEmpty()) {
        lines.add("");
        continue;
      }
      String remaining = paragraph;
      while (!remaining.isEmpty()) {
        int fittingLength = 0;
        for (int index = 1; index <= remaining.length(); index += 1) {
          if (textWidth(document, font, fontSize, letterSpacing, remaining.substring(0, index)) > availableWidth) break;
          fittingLength = index;
        }
        if (fittingLength == 0) fittingLength = 1;
        if (fittingLength >= remaining.length()) {
          lines.add(remaining.stripTrailing());
          break;
        }
        int breakAt = remaining.lastIndexOf(' ', fittingLength - 1);
        if (breakAt <= 0) breakAt = fittingLength;
        lines.add(remaining.substring(0, breakAt).stripTrailing());
        remaining = remaining.substring(breakAt).stripLeading();
      }
    }
    return lines;
  }

  private static void appendArrowHead(
      PDPageContentStream content,
      PdfPoint start,
      PdfPoint end) throws IOException {
    double deltaX = end.x - start.x;
    double deltaY = end.y - start.y;
    double length = Math.max(0.001, Math.hypot(deltaX, deltaY));
    double directionX = deltaX / length;
    double directionY = deltaY / length;
    double arrowLength = Math.min(12, Math.max(7, length * 0.16));
    double halfWidth = Math.min(5.5, Math.max(3.5, length * 0.07));
    float baseX = (float) (end.x - directionX * arrowLength);
    float baseY = (float) (end.y - directionY * arrowLength);
    float leftX = (float) (baseX - directionY * halfWidth);
    float leftY = (float) (baseY + directionX * halfWidth);
    float rightX = (float) (baseX + directionY * halfWidth);
    float rightY = (float) (baseY - directionX * halfWidth);
    content.moveTo(leftX, leftY);
    content.lineTo(end.x, end.y);
    content.lineTo(rightX, rightY);
  }

  private static void appendEllipse(
      PDPageContentStream content,
      PDPage page,
      AnnotationStroke shape) throws IOException {
    double kappa = 0.5522847498307936;
    PdfPoint start = shapePoint(page, shape, 0.5, 0);
    content.moveTo(start.x, start.y);
    shapeCurve(content, page, shape, 0.5 + 0.5 * kappa, 0, 1, 0.5 - 0.5 * kappa, 1, 0.5);
    shapeCurve(content, page, shape, 1, 0.5 + 0.5 * kappa, 0.5 + 0.5 * kappa, 1, 0.5, 1);
    shapeCurve(content, page, shape, 0.5 - 0.5 * kappa, 1, 0, 0.5 + 0.5 * kappa, 0, 0.5);
    shapeCurve(content, page, shape, 0, 0.5 - 0.5 * kappa, 0.5 - 0.5 * kappa, 0, 0.5, 0);
    content.closePath();
  }

  private static void appendRoundedTriangle(
      PDPageContentStream content,
      PDPage page,
      AnnotationStroke shape) throws IOException {
    NormalizedPoint[] vertices = {
        new NormalizedPoint(0.5, 0),
        new NormalizedPoint(1, 1),
        new NormalizedPoint(0, 1)
    };
    double radius = Math.max(0, Math.min(0.42,
        Math.min(shape.radiusX / Math.max(0.0001, shape.width), shape.radiusY / Math.max(0.0001, shape.height))));
    if (radius <= 0.0001) {
      PdfPoint top = shapePoint(page, shape, 0.5, 0);
      PdfPoint bottomRight = shapePoint(page, shape, 1, 1);
      PdfPoint bottomLeft = shapePoint(page, shape, 0, 1);
      content.moveTo(top.x, top.y);
      content.lineTo(bottomRight.x, bottomRight.y);
      content.lineTo(bottomLeft.x, bottomLeft.y);
      content.closePath();
      return;
    }
    NormalizedPoint[] incoming = new NormalizedPoint[3];
    NormalizedPoint[] outgoing = new NormalizedPoint[3];
    for (int index = 0; index < vertices.length; index += 1) {
      incoming[index] = localPointToward(vertices[index], vertices[(index + 2) % 3], radius);
      outgoing[index] = localPointToward(vertices[index], vertices[(index + 1) % 3], radius);
    }
    PdfPoint start = shapePoint(page, shape, outgoing[0].x, outgoing[0].y);
    content.moveTo(start.x, start.y);
    for (int index = 1; index <= 3; index += 1) {
      int vertexIndex = index % 3;
      PdfPoint before = shapePoint(page, shape, incoming[vertexIndex].x, incoming[vertexIndex].y);
      PdfPoint vertex = shapePoint(page, shape, vertices[vertexIndex].x, vertices[vertexIndex].y);
      PdfPoint after = shapePoint(page, shape, outgoing[vertexIndex].x, outgoing[vertexIndex].y);
      content.lineTo(before.x, before.y);
      content.curveTo(
          (float) (before.x + (vertex.x - before.x) * 2 / 3),
          (float) (before.y + (vertex.y - before.y) * 2 / 3),
          (float) (after.x + (vertex.x - after.x) * 2 / 3),
          (float) (after.y + (vertex.y - after.y) * 2 / 3),
          after.x,
          after.y);
    }
    content.closePath();
  }

  private static NormalizedPoint localPointToward(NormalizedPoint from, NormalizedPoint to, double distance) {
    double length = Math.max(0.0001, Math.hypot(to.x - from.x, to.y - from.y));
    double amount = Math.min(distance, length * 0.42) / length;
    return new NormalizedPoint(from.x + (to.x - from.x) * amount, from.y + (to.y - from.y) * amount);
  }

  private static void appendRoundedRectangle(
      PDPageContentStream content,
      PDPage page,
      AnnotationStroke shape) throws IOException {
    double rx = Math.min(shape.radiusX, shape.width / 2);
    double ry = Math.min(shape.radiusY, shape.height / 2);
    if (rx <= 0 || ry <= 0) {
      PdfPoint topLeft = shapePoint(page, shape, 0, 0);
      PdfPoint topRight = shapePoint(page, shape, 1, 0);
      PdfPoint bottomRight = shapePoint(page, shape, 1, 1);
      PdfPoint bottomLeft = shapePoint(page, shape, 0, 1);
      content.moveTo(topLeft.x, topLeft.y);
      content.lineTo(topRight.x, topRight.y);
      content.lineTo(bottomRight.x, bottomRight.y);
      content.lineTo(bottomLeft.x, bottomLeft.y);
      content.closePath();
      return;
    }

    double localRx = rx / shape.width;
    double localRy = ry / shape.height;
    double kappa = 0.5522847498307936;
    PdfPoint start = shapePoint(page, shape, localRx, 0);
    content.moveTo(start.x, start.y);
    PdfPoint topRightStart = shapePoint(page, shape, 1 - localRx, 0);
    content.lineTo(topRightStart.x, topRightStart.y);
    shapeCurve(content, page, shape, 1 - localRx + localRx * kappa, 0, 1, localRy - localRy * kappa, 1, localRy);
    PdfPoint rightBottomStart = shapePoint(page, shape, 1, 1 - localRy);
    content.lineTo(rightBottomStart.x, rightBottomStart.y);
    shapeCurve(content, page, shape, 1, 1 - localRy + localRy * kappa, 1 - localRx + localRx * kappa, 1, 1 - localRx, 1);
    PdfPoint bottomLeftStart = shapePoint(page, shape, localRx, 1);
    content.lineTo(bottomLeftStart.x, bottomLeftStart.y);
    shapeCurve(content, page, shape, localRx - localRx * kappa, 1, 0, 1 - localRy + localRy * kappa, 0, 1 - localRy);
    PdfPoint leftTopStart = shapePoint(page, shape, 0, localRy);
    content.lineTo(leftTopStart.x, leftTopStart.y);
    shapeCurve(content, page, shape, 0, localRy - localRy * kappa, localRx - localRx * kappa, 0, localRx, 0);
    content.closePath();
  }

  private static void shapeCurve(
      PDPageContentStream content,
      PDPage page,
      AnnotationStroke shape,
      double control1X,
      double control1Y,
      double control2X,
      double control2Y,
      double endX,
      double endY) throws IOException {
    PdfPoint control1 = shapePoint(page, shape, control1X, control1Y);
    PdfPoint control2 = shapePoint(page, shape, control2X, control2Y);
    PdfPoint end = shapePoint(page, shape, endX, endY);
    content.curveTo(control1.x, control1.y, control2.x, control2.y, end.x, end.y);
  }

  private static PdfPoint shapePoint(
      PDPage page,
      AnnotationStroke shape,
      double localX,
      double localY) {
    double centerX = shape.x + shape.width / 2;
    double centerY = shape.y + shape.height / 2;
    double pointX = shape.x + localX * shape.width;
    double pointY = shape.y + localY * shape.height;
    double radians = Math.toRadians(shape.rotation);
    double cosine = Math.cos(radians);
    double sine = Math.sin(radians);
    PDRectangle box = page.getCropBox();
    int pageRotation = ((page.getRotation() % 360) + 360) % 360;
    double displayWidth = pageRotation == 90 || pageRotation == 270 ? box.getHeight() : box.getWidth();
    double displayHeight = pageRotation == 90 || pageRotation == 270 ? box.getWidth() : box.getHeight();
    // Shape rotation happens in the rendered page's pixel coordinate system.
    // Rotating normalized values directly distorts non-square pages because one
    // normalized X unit and one normalized Y unit represent different lengths.
    double deltaX = (pointX - centerX) * displayWidth;
    double deltaY = (pointY - centerY) * displayHeight;
    double rotatedX = deltaX * cosine - deltaY * sine;
    double rotatedY = deltaX * sine + deltaY * cosine;
    return normalizedToPdfPoint(page, new NormalizedPoint(
        centerX + rotatedX / displayWidth,
        centerY + rotatedY / displayHeight));
  }

  private static void drawAnnotationLayer(
      PDDocument document,
      PDPage page,
      List<AnnotationStroke> strokes,
      boolean markerLayer) throws IOException {
    // Marker strokes are appended with Multiply blending. This keeps black text
    // visually above the ink while avoiding disappearance behind PDFs that draw
    // an explicit white page background.
    try (PDPageContentStream content = new PDPageContentStream(
        document, page, PDPageContentStream.AppendMode.APPEND, true, true)) {
      content.setLineCapStyle(1);
      content.setLineJoinStyle(1);

      for (AnnotationStroke stroke : strokes) {
        float red = (float) listValue(stroke.color, 0, markerLayer ? 1 : 0.886);
        float green = (float) listValue(stroke.color, 1, markerLayer ? 0.894 : 0.114);
        float blue = (float) listValue(stroke.color, 2, markerLayer ? 0.231 : 0.196);
        float opacity = (float) Math.max(0.01, Math.min(1, listValue(stroke.color, 3, markerLayer ? 0.34 : 0.94)));
        float editorWidth = (float) Math.max(0.25, listValue(stroke.color, 4, markerLayer ? 16 : 2.05));
        float lineWidth = editorWidth * 0.740625f;
        float falloff = (float) Math.max(0, Math.min(1, listValue(stroke.color, 5, 0)));
        content.setStrokingColor(red, green, blue);
        if (markerLayer && falloff > 0.001f) {
          setStrokeGraphicsState(content, opacity * falloff * 0.72f, true);
          content.setLineWidth(lineWidth * (1 + falloff * 0.4f));
          appendAnnotationStrokePath(content, page, stroke);
          content.stroke();
        }
        setStrokeGraphicsState(content, opacity, markerLayer);
        content.setLineWidth(lineWidth);
        appendAnnotationStrokePath(content, page, stroke);
        content.stroke();
      }
    }
  }

  private static double listValue(List<Double> values, int index, double fallback) {
    return values != null && values.size() > index && Double.isFinite(values.get(index)) ? values.get(index) : fallback;
  }

  private static void setStrokeGraphicsState(PDPageContentStream content, float opacity, boolean multiply) throws IOException {
    PDExtendedGraphicsState graphicsState = new PDExtendedGraphicsState();
    graphicsState.setStrokingAlphaConstant(Math.max(0.01f, Math.min(1f, opacity)));
    graphicsState.setBlendMode(multiply ? BlendMode.MULTIPLY : BlendMode.NORMAL);
    content.setGraphicsStateParameters(graphicsState);
  }

  private static void appendAnnotationStrokePath(PDPageContentStream content, PDPage page, AnnotationStroke stroke) throws IOException {
    PdfPoint first = normalizedToPdfPoint(page, stroke.points.get(0));
    content.moveTo(first.x, first.y);
    if (stroke.points.size() == 1) {
      content.lineTo(first.x + 0.01f, first.y + 0.01f);
      return;
    }
    for (int index = 1; index < stroke.points.size(); index += 1) {
      PdfPoint point = normalizedToPdfPoint(page, stroke.points.get(index));
      content.lineTo(point.x, point.y);
    }
  }

  private static PdfPoint normalizedToPdfPoint(PDPage page, NormalizedPoint point) {
    PDRectangle box = page.getCropBox();
    float x = (float) clamp(point.x, 0, 1);
    float y = (float) clamp(point.y, 0, 1);
    float left = box.getLowerLeftX();
    float bottom = box.getLowerLeftY();
    float width = box.getWidth();
    float height = box.getHeight();
    int rotation = ((page.getRotation() % 360) + 360) % 360;

    return switch (rotation) {
      case 90 -> new PdfPoint(left + y * width, bottom + x * height);
      case 180 -> new PdfPoint(left + (1 - x) * width, bottom + y * height);
      case 270 -> new PdfPoint(left + (1 - y) * width, bottom + (1 - x) * height);
      default -> new PdfPoint(left + x * width, bottom + (1 - y) * height);
    };
  }

  private static FontExtractResult extractFonts(byte[] pdfBytes) throws IOException {
    FontExtractResult result = new FontExtractResult();
    Set<COSBase> seenFonts = Collections.newSetFromMap(new IdentityHashMap<>());
    Set<COSBase> seenForms = Collections.newSetFromMap(new IdentityHashMap<>());

    try (PDDocument document = loadPdf(pdfBytes)) {
      for (int pageIndex = 0; pageIndex < document.getNumberOfPages(); pageIndex += 1) {
        collectEmbeddedFonts(document.getPage(pageIndex).getResources(), result, seenFonts, seenForms);
      }
      // What each font draws lets the editor find it among pdf2htmlEX's font classes.
      Map<COSBase, FontCodec> codecs = learnDocumentFontCodecs(document);
      for (int index = 0; index < result.fonts.size(); index += 1) {
        EmbeddedFont font = result.fonts.get(index);
        FontCodec codec = codecs.get(font.cos());
        result.fonts.set(index, font.withCharacters(codec == null ? "" : codec.characters()));
      }
    }

    return result;
  }

  private static void collectEmbeddedFonts(
      PDResources resources,
      FontExtractResult result,
      Set<COSBase> seenFonts,
      Set<COSBase> seenForms) throws IOException {
    if (resources == null) {
      return;
    }

    List<COSName> fontNames = new ArrayList<>();
    for (COSName fontName : resources.getFontNames()) {
      fontNames.add(fontName);
    }
    fontNames.sort((left, right) -> left.getName().compareTo(right.getName()));

    for (COSName fontName : fontNames) {
      PDFont font = resources.getFont(fontName);
      if (font == null || !seenFonts.add(font.getCOSObject())) {
        continue;
      }
      EmbeddedFont embedded = embeddedFont(font, result.fonts.size() + 1);
      if (embedded != null) {
        result.fonts.add(embedded);
      }
    }

    for (COSName xObjectName : resources.getXObjectNames()) {
      PDXObject xObject = resources.getXObject(xObjectName);
      if (xObject instanceof PDFormXObject form && seenForms.add(form.getCOSObject())) {
        collectEmbeddedFonts(form.getResources(), result, seenFonts, seenForms);
      }
    }
  }

  private static EmbeddedFont embeddedFont(PDFont font, int index) throws IOException {
    PDFontDescriptor descriptor = font.getFontDescriptor();
    if (descriptor == null) {
      return null;
    }

    PDStream stream = descriptor.getFontFile2();
    String format = "truetype";
    String mime = "font/ttf";
    if (stream == null) {
      stream = descriptor.getFontFile();
      format = "type1";
      mime = "application/octet-stream";
    }
    if (stream == null) {
      stream = descriptor.getFontFile3();
      format = "opentype";
      mime = "font/otf";
    }
    if (stream == null) {
      return null;
    }

    String pdfJsName = "g_d0_f" + index;
    String family = "DocuflexPdfFont_" + pdfJsName;
    String baseName = descriptor.getFontName() != null ? descriptor.getFontName() : font.toString();
    String cleanName = cleanFontName(baseName);
    String css = "@font-face{font-family:'" + family + "';src:url(data:" + mime + ";base64,"
        + Base64.getEncoder().encodeToString(stream.toByteArray()) + ") format('" + format
        + "');font-style:" + (descriptor.isItalic() ? "italic" : "normal")
        + ";font-weight:400"
        + ";font-display:block;}";
    return new EmbeddedFont(pdfJsName, family, cleanName, css, fallbackFace(font).stem(), installedFallbackName(font), sameDesignFallback(font), font.getCOSObject(), "");
  }

  private static String cleanFontName(String value) {
    int subset = value.indexOf('+');
    return subset >= 0 && subset + 1 < value.length() ? value.substring(subset + 1) : value;
  }

  /**
   * The document whose text is being rewritten. The token rewriting below only
   * sees page resources, but stand-in fonts must be embedded into this document.
   */
  private static final ThreadLocal<PDDocument> EDIT_DOCUMENT = new ThreadLocal<>();

  private static EditResult applyEdits(
      byte[] pdfBytes,
      List<TextEdit> edits,
      List<ImageEdit> imageEdits) throws IOException {
    try (PDDocument document = loadPdf(pdfBytes)) {
      EDIT_DOCUMENT.set(document);
      DOCUMENT_CODECS.set(learnDocumentFontCodecs(document));
      return applyEdits(document, edits, imageEdits);
    } finally {
      EDIT_DOCUMENT.remove();
      DOCUMENT_CODECS.remove();
    }
  }

  /**
   * What each font draws anywhere in the original document, by font dictionary.
   * A character counts as the PDF font's own only when the document draws it
   * with that font somewhere; the editor learns the same set from the HTML, so
   * both send every other character to the same fallback.
   */
  private static final ThreadLocal<Map<COSBase, FontCodec>> DOCUMENT_CODECS = new ThreadLocal<>();

  private static Map<COSBase, FontCodec> learnDocumentFontCodecs(PDDocument document) {
    Map<COSBase, FontCodec> learned = new HashMap<>();
    Set<COSBase> visited = Collections.newSetFromMap(new IdentityHashMap<>());
    for (PDPage page : document.getPages()) {
      try {
        learnStreamFontCodecs(page.getResources(), new PDFStreamParser(page).parse(), learned, visited);
      } catch (IOException | RuntimeException ignored) {
        // A page that cannot be parsed simply teaches nothing.
      }
    }
    return learned;
  }

  private static void learnStreamFontCodecs(
      PDResources resources,
      List<Object> tokens,
      Map<COSBase, FontCodec> learned,
      Set<COSBase> visited) throws IOException {
    if (resources == null) return;
    learnFontCodecs(resources, tokens, false).forEach((font, codec) ->
        learned.computeIfAbsent(font.getCOSObject(), (key) -> new FontCodec(font)).learnFrom(codec));
    for (int index = 1; index < tokens.size(); index += 1) {
      if (!(tokens.get(index) instanceof Operator operator) || !"Do".equals(operator.getName())) continue;
      if (!(tokens.get(index - 1) instanceof COSName name)) continue;
      if (resources.getXObject(name) instanceof PDFormXObject form && visited.add(form.getCOSObject())) {
        PDResources formResources = form.getResources() != null ? form.getResources() : resources;
        learnStreamFontCodecs(formResources, new PDFStreamParser(form).parse(), learned, visited);
      }
    }
  }

  private static EditResult applyEdits(
      PDDocument document,
      List<TextEdit> edits,
      List<ImageEdit> imageEdits) throws IOException {
    EditResult result = new EditResult();
    if (isEditRestricted(document)) {
      throw new IllegalArgumentException("This PDF is edit protected. Remove the protection to edit its text.");
    }
    document.setAllSecurityToBeRemoved(true);
    for (int editIndex = 0; editIndex < edits.size(); editIndex++) {
      TextEdit edit = edits.get(editIndex);
      if (edit.newText.equals(edit.oldText) && !edit.moved && !edit.overlay) {
        continue;
      }
      if (edit.page < 0 || edit.page >= document.getNumberOfPages()) {
        result.misses.add("Page " + (edit.page + 1) + " is outside the document.");
        result.missedEditIndices.add(editIndex);
        continue;
      }
      PDPage page = document.getPage(edit.page);
      if (edit.overlay) {
        if (overlayEditFallback(document, page, edit)) {
          result.applied += 1;
        } else {
          result.misses.add("Could not place aligned text on page " + (edit.page + 1) + ": " + edit.oldText);
          result.missedEditIndices.add(editIndex);
        }
        continue;
      }
      if (edit.moved) {
        boolean textOnlyMove = edit.oldText.equals(edit.newText);
        if ((textOnlyMove && movePageTextWithCandidates(document, page, edit))
            || (!textOnlyMove && moveAndRewritePageText(document, page, edit))) {
          result.applied += 1;
        } else {
          result.misses.add("Could not move text while preserving original styling on page " + (edit.page + 1) + ": " + edit.oldText);
          result.missedEditIndices.add(editIndex);
        }
        continue;
      }
      TextEdit effectiveEdit = withoutLeadingListMarker(edit);
      if (rewritePageWithCandidates(document, page, effectiveEdit)) {
        result.applied += 1;
      } else {
        result.misses.add("Could not find editable text on page " + (edit.page + 1) + ": " + edit.oldText);
        result.missedEditIndices.add(editIndex);
      }
    }
    for (ImageEdit edit : imageEdits) {
      if (edit.page < 0 || edit.page >= document.getNumberOfPages()) {
        result.misses.add("Image page " + (edit.page + 1) + " is outside the document.");
        continue;
      }
      if (rewritePageImage(document, document.getPage(edit.page), edit)) {
        result.applied += 1;
      } else {
        result.misses.add("Could not match the moved image on page " + (edit.page + 1) + ".");
      }
    }

    ByteArrayOutputStream output = new ByteArrayOutputStream();
    document.save(output);
    result.pdfBytes = output.toByteArray();
    return result;
  }

  private static TextEdit withoutLeadingListMarker(TextEdit edit) {
    String oldText = stripLeadingListMarker(edit.oldText);
    String newText = stripLeadingListMarker(edit.newText);
    if (oldText.equals(edit.oldText) || oldText.isBlank() || newText.isBlank()) {
      return edit;
    }
    return new TextEdit(
        edit.page,
        oldText,
        newText,
        stripLeadingListMarkerCandidates(edit.oldTextCandidates),
        edit.occurrence,
        edit.rect,
        edit.alignRect,
        edit.visualRect,
        edit.originalRect,
        edit.pageSize,
        edit.color,
        edit.fontName,
        edit.fontSize,
        edit.bold,
        edit.moved,
        edit.overlay,
        edit.alignment,
        edit.fontChanged,
        edit.boldChanged,
        edit.italic,
        edit.italicChanged,
        edit.underline,
        edit.strikethrough,
        edit.letterSpacing, -1);
  }

  private static boolean rewritePageImage(
      PDDocument document,
      PDPage page,
      ImageEdit edit) throws IOException {
    if (edit.rect.size() < 4 || edit.originalRect.size() < 4 || page.getResources() == null) {
      return false;
    }
    PDFStreamParser parser = new PDFStreamParser(page);
    List<Object> tokens = parser.parse();
    float pageWidth = page.getMediaBox().getWidth();
    float pageHeight = page.getMediaBox().getHeight();
    double originalLeft = coordinate(edit.originalRect.get(0), pageWidth);
    double originalBottom = coordinate(edit.originalRect.get(1), pageHeight);
    double originalRight = coordinate(edit.originalRect.get(2), pageWidth);
    double originalTop = coordinate(edit.originalRect.get(3), pageHeight);
    double targetLeft = coordinate(edit.rect.get(0), pageWidth);
    double targetBottom = coordinate(edit.rect.get(1), pageHeight);
    double targetRight = coordinate(edit.rect.get(2), pageWidth);
    double targetTop = coordinate(edit.rect.get(3), pageHeight);
    double originalWidth = Math.max(0.01, originalRight - originalLeft);
    double originalHeight = Math.max(0.01, originalTop - originalBottom);
    double scaleX = Math.max(0.01, targetRight - targetLeft) / originalWidth;
    double scaleY = Math.max(0.01, targetTop - targetBottom) / originalHeight;

    if (edit.group) {
      return rewritePageGraphicsGroup(
          document,
          page,
          tokens,
          scaleX,
          scaleY,
          targetLeft - originalLeft * scaleX,
          targetBottom - originalBottom * scaleY);
    }

    List<ImageMatrixCandidate> candidates = new ArrayList<>();
    PDResources resources = page.getResources();
    Set<COSBase> visitedForms = Collections.newSetFromMap(new IdentityHashMap<>());
    collectImageMatrixCandidates(
        resources,
        tokens,
        new Matrix(),
        null,
        candidates,
        visitedForms);
    if (candidates.isEmpty()) return false;

    ImageMatrixCandidate best = null;
    double bestScore = Double.POSITIVE_INFINITY;
    for (ImageMatrixCandidate candidate : candidates) {
      double[] bounds = candidate.bounds;
      double score = Math.abs(bounds[0] - originalLeft) / Math.max(1, pageWidth)
          + Math.abs(bounds[1] - originalBottom) / Math.max(1, pageHeight)
          + Math.abs(bounds[2] - originalRight) / Math.max(1, pageWidth)
          + Math.abs(bounds[3] - originalTop) / Math.max(1, pageHeight);
      if (score < bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    if ((best == null || bestScore > 0.24) && edit.occurrence >= 0 && edit.occurrence < candidates.size()) {
      best = candidates.get(edit.occurrence);
    }
    if (best == null) return false;

    double[] global = best.globalMatrix.clone();
    global[0] *= scaleX;
    global[1] *= scaleX;
    global[2] *= scaleY;
    global[3] *= scaleY;
    double[] scaledBounds = imageMatrixBounds(global);
    global[4] += targetLeft - scaledBounds[0];
    global[5] += targetBottom - scaledBounds[1];
    if (!setImageCandidateMatrix(best, global)) return false;

    if (best.form != null) {
      try (OutputStream out = best.form.getContentStream().createOutputStream()) {
        new ContentStreamWriter(out).writeTokens(best.tokens);
      }
    } else {
      writePageTokens(document, page, best.tokens);
    }
    return true;
  }

  private static boolean rewritePageGraphicsGroup(
      PDDocument document,
      PDPage page,
      List<Object> tokens,
      double scaleX,
      double scaleY,
      double translateX,
      double translateY) throws IOException {
    if (!Double.isFinite(scaleX)
        || !Double.isFinite(scaleY)
        || !Double.isFinite(translateX)
        || !Double.isFinite(translateY)
        || scaleX <= 0.0
        || scaleY <= 0.0) {
      return false;
    }

    // pdf2htmlEX exposes a single full-page background box even when that
    // background is made from a mixture of paths, shadings, forms, and images.
    // Move every page graphic as one group, while cancelling the transform
    // inside text objects so searchable/editable PDF text stays in place.
    List<Object> transformed = new ArrayList<>(tokens.size() + 24);
    transformed.add(Operator.getOperator("q"));
    appendMatrix(transformed, scaleX, 0.0, 0.0, scaleY, translateX, translateY);

    boolean inTextObject = false;
    for (Object token : tokens) {
      if (token instanceof Operator operator && "BT".equals(operator.getName()) && !inTextObject) {
        appendMatrix(
            transformed,
            1.0 / scaleX,
            0.0,
            0.0,
            1.0 / scaleY,
            -translateX / scaleX,
            -translateY / scaleY);
        inTextObject = true;
      }
      transformed.add(token);
      if (token instanceof Operator operator && "ET".equals(operator.getName()) && inTextObject) {
        appendMatrix(transformed, scaleX, 0.0, 0.0, scaleY, translateX, translateY);
        inTextObject = false;
      }
    }
    transformed.add(Operator.getOperator("Q"));
    writePageTokens(document, page, transformed);
    return true;
  }

  private static void appendMatrix(
      List<Object> tokens,
      double a,
      double b,
      double c,
      double d,
      double e,
      double f) {
    tokens.add(new COSFloat((float) a));
    tokens.add(new COSFloat((float) b));
    tokens.add(new COSFloat((float) c));
    tokens.add(new COSFloat((float) d));
    tokens.add(new COSFloat((float) e));
    tokens.add(new COSFloat((float) f));
    tokens.add(Operator.getOperator("cm"));
  }

  private static boolean setImageCandidateMatrix(
      ImageMatrixCandidate candidate,
      double[] global) {
    try {
      AffineTransform localTransform = candidate.parentMatrix.createAffineTransform().createInverse();
      localTransform.concatenate(new AffineTransform(
          global[0], global[1], global[2], global[3], global[4], global[5]));
      double[] local = new double[6];
      localTransform.getMatrix(local);
      for (int operand = 0; operand < 6; operand += 1) {
        candidate.tokens.set(candidate.operatorIndex - 6 + operand, new COSFloat((float) local[operand]));
      }
      return true;
    } catch (NoninvertibleTransformException error) {
      return false;
    }
  }

  private static void writePageTokens(
      PDDocument document,
      PDPage page,
      List<Object> tokens) throws IOException {
    PDStream newContents = new PDStream(document);
    try (OutputStream out = newContents.createOutputStream()) {
      new ContentStreamWriter(out).writeTokens(tokens);
    }
    page.setContents(newContents);
  }

  private static void collectImageMatrixCandidates(
      PDResources resources,
      List<Object> tokens,
      Matrix initialMatrix,
      PDFormXObject ownerForm,
      List<ImageMatrixCandidate> candidates,
      Set<COSBase> visitedForms) throws IOException {
    if (resources == null) return;
    Matrix current = initialMatrix.clone();
    Deque<Matrix> stack = new ArrayDeque<>();
    int lastMatrixOperator = -1;
    Matrix matrixParent = null;

    for (int index = 0; index < tokens.size(); index += 1) {
      Object token = tokens.get(index);
      if (!(token instanceof Operator operator)) continue;
      String name = operator.getName();
      if ("q".equals(name)) {
        stack.push(current.clone());
        lastMatrixOperator = -1;
        matrixParent = null;
      } else if ("Q".equals(name)) {
        if (!stack.isEmpty()) current = stack.pop();
        lastMatrixOperator = -1;
        matrixParent = null;
      } else if ("cm".equals(name)) {
        double[] values = matrixOperands(tokens, index);
        if (values == null) continue;
        matrixParent = current.clone();
        current.concatenate(new Matrix(
            (float) values[0],
            (float) values[1],
            (float) values[2],
            (float) values[3],
            (float) values[4],
            (float) values[5]));
        lastMatrixOperator = index;
      } else if ("Do".equals(name) && index >= 1 && tokens.get(index - 1) instanceof COSName objectName) {
        PDXObject object = resources.getXObject(objectName);
        if (object instanceof PDImageXObject && lastMatrixOperator >= 6 && matrixParent != null) {
          double[] global = matrixValues(current);
          candidates.add(new ImageMatrixCandidate(
              lastMatrixOperator,
              tokens,
              ownerForm,
              matrixParent.clone(),
              global,
              imageMatrixBounds(global)));
        } else if (object instanceof PDFormXObject form && visitedForms.add(form.getCOSObject())) {
          PDResources formResources = form.getResources() != null ? form.getResources() : resources;
          PDFStreamParser formParser = new PDFStreamParser(form);
          List<Object> formTokens = formParser.parse();
          Matrix formMatrix = current.clone();
          if (form.getMatrix() != null) formMatrix.concatenate(form.getMatrix());
          collectImageMatrixCandidates(
              formResources,
              formTokens,
              formMatrix,
              form,
              candidates,
              visitedForms);
        }
      }
    }
  }

  private static double[] matrixValues(Matrix matrix) {
    return new double[] {
        matrix.getScaleX(),
        matrix.getShearY(),
        matrix.getShearX(),
        matrix.getScaleY(),
        matrix.getTranslateX(),
        matrix.getTranslateY()
    };
  }

  private static double[] matrixOperands(List<Object> tokens, int operatorIndex) {
    if (operatorIndex < 6) return null;
    double[] values = new double[6];
    for (int index = 0; index < 6; index += 1) {
      Object token = tokens.get(operatorIndex - 6 + index);
      if (!(token instanceof COSNumber number)) return null;
      values[index] = number.floatValue();
    }
    return values;
  }

  private static double[] imageMatrixBounds(double[] matrix) {
    double[] xs = {
        matrix[4],
        matrix[0] + matrix[4],
        matrix[2] + matrix[4],
        matrix[0] + matrix[2] + matrix[4]
    };
    double[] ys = {
        matrix[5],
        matrix[1] + matrix[5],
        matrix[3] + matrix[5],
        matrix[1] + matrix[3] + matrix[5]
    };
    return new double[] {
        Arrays.stream(xs).min().orElse(matrix[4]),
        Arrays.stream(ys).min().orElse(matrix[5]),
        Arrays.stream(xs).max().orElse(matrix[4]),
        Arrays.stream(ys).max().orElse(matrix[5])
    };
  }

  private static List<String> stripLeadingListMarkerCandidates(List<String> candidates) {
    List<String> stripped = new ArrayList<>();
    for (String candidate : candidates) {
      String value = stripLeadingListMarker(candidate);
      if (value != null && !value.isBlank() && !stripped.contains(value)) {
        stripped.add(value);
      }
    }
    return stripped;
  }

  private static String stripLeadingListMarker(String value) {
    if (value == null || value.isBlank()) {
      return value;
    }
    int start = 0;
    while (start < value.length()) {
      int codePoint = value.codePointAt(start);
      if (!Character.isWhitespace(codePoint)) {
        break;
      }
      start += Character.charCount(codePoint);
    }
    if (start >= value.length()) {
      return value;
    }
    int marker = value.codePointAt(start);
    if (!isLeadingListSymbol(marker)) {
      return value;
    }
    int textStart = start + Character.charCount(marker);
    while (textStart < value.length()) {
      int codePoint = value.codePointAt(textStart);
      if (!Character.isWhitespace(codePoint)) {
        break;
      }
      textStart += Character.charCount(codePoint);
    }
    return value.substring(textStart);
  }

  private static boolean isLeadingListSymbol(int codePoint) {
    return codePoint == 0x2022
        || codePoint == 0x2023
        || codePoint == 0x25E6
        || codePoint == 0x2043
        || codePoint == 0x2219
        || codePoint == 0x00B7
        || codePoint == '-'
        || codePoint == 0x2013
        || codePoint == 0x2014;
  }

  private static boolean overlayEditFallback(PDDocument document, PDPage page, TextEdit edit) throws IOException {
    if (edit.rect.size() < 4) {
      return false;
    }
    OverlayStyle originalStyle = findOverlayStyle(page, edit);

    boolean removedOriginal = rewritePageWithCandidates(document, page, new TextEdit(
        edit.page,
        edit.oldText,
        "",
        edit.oldTextCandidates,
        edit.occurrence,
        List.of(),
        List.of(),
        List.of(),
        List.of(),
        List.of(),
        List.of(),
        edit.fontName,
        0,
        false,
        false,
        false,
        "",
        false,
        false,
        false,
        false,
        false,
        false,
        0, -1));
    if (!removedOriginal) {
      return false;
    }

    float pageWidth = page.getMediaBox().getWidth();
    float pageHeight = page.getMediaBox().getHeight();
    float left = coordinate(edit.rect.get(0), pageWidth);
    float bottom = coordinate(edit.rect.get(1), pageHeight);
    float right = coordinate(edit.rect.get(2), pageWidth);
    float top = coordinate(edit.rect.get(3), pageHeight);
    float width = Math.max(1f, right - left);
    float height = Math.max(1f, top - bottom);
    float fontSize = overlayFontSize(edit, pageHeight, height);
    String text = edit.newText.isBlank() ? " " : edit.newText;

    Standard14Fonts.FontName fontName = edit.bold
        ? (edit.italic ? Standard14Fonts.FontName.HELVETICA_BOLD_OBLIQUE : Standard14Fonts.FontName.HELVETICA_BOLD)
        : (edit.italic ? Standard14Fonts.FontName.HELVETICA_OBLIQUE : Standard14Fonts.FontName.HELVETICA);
    List<FontRun> runs;
    if (!edit.fontChanged && originalStyle.font != null) {
      // Keep the original font and draw only the characters it lacks with the
      // stand-in, exactly as the editor shows them.
      runs = fallbackRuns(originalStyle.font, text);
    } else {
      PDFont pageFont = findPageFont(page, edit.fontName, text, edit.bold, edit.italic);
      if (!edit.fontChanged && pageFont != null) {
        // The same PDF font found by name: same fallbacks as above, never Helvetica.
        runs = fallbackRuns(pageFont, text);
      } else {
        PDFont font = pageFont != null ? pageFont : overlayFont(document, edit, fontName);
        String encodable = canEncodeWithFont(text, font) ? text : sanitizeWinAnsi(text);
        runs = List.of(new FontRun(encodable, font));
      }
    }
    PDFont font = runs.stream().map(FontRun::font).filter(java.util.Objects::nonNull).findFirst()
        .orElse(originalStyle.font != null ? originalStyle.font : runs.get(0).font());
    left = overlayAlignedLeft(edit, runsWidth(runs, fontSize), fontSize, pageWidth, left, right);
    // The baseline the editor showed (a fraction of the page from the top),
    // so the saved line sits exactly where it was edited.
    float baseline = edit.baseline() >= 0 && edit.baseline() <= 1
        ? (float) (pageHeight * (1 - edit.baseline()))
        : bottom + Math.max(1f, (height - fontSize) * 0.5f);
    float characterSpacing = edit.pageSize.size() >= 2 && edit.pageSize.get(1) > 0
        ? (float) (edit.letterSpacing * pageHeight / edit.pageSize.get(1))
        : (float) edit.letterSpacing;

    try (PDPageContentStream stream = new PDPageContentStream(
        document, page, PDPageContentStream.AppendMode.APPEND, true, true)) {
      stream.beginText();
      setOverlayColor(stream, edit.color);
      stream.setFont(font, fontSize);
      stream.setCharacterSpacing(characterSpacing);
      if (edit.bold && !fontTraits(font).bold()) {
        // Bold on a regular font: thicken the same glyphs, as the editor's
        // synthetic bold does, instead of switching to another typeface.
        setOverlayStrokeColor(stream, edit.color);
        stream.setRenderingMode(org.apache.pdfbox.pdmodel.graphics.state.RenderingMode.FILL_STROKE);
        stream.setLineWidth(syntheticBoldStroke(fontSize));
      }
      if (edit.italic && !fontIsItalic(font)) {
        stream.setTextMatrix(new Matrix(1, 0, 0.22f, 1, left, baseline));
      } else {
        stream.newLineAtOffset(left, baseline);
      }
      for (FontRun run : runs) {
        if (run.font() == null) {
          stream.showTextWithPositioning(new Object[] {-1000f * SPACE_GAP_EM * run.text().length()});
          continue;
        }
        stream.setFont(run.font(), fontSize);
        stream.showText(run.text());
      }
      stream.endText();
      if (edit.underline || edit.strikethrough) {
        setOverlayStrokeColor(stream, edit.color);
        stream.setLineWidth(Math.max(0.6f, fontSize * 0.055f));
        float textWidth = runsWidth(runs, fontSize)
            + Math.max(0, text.length() - 1) * characterSpacing;
        if (edit.underline) {
          stream.moveTo(left, baseline - fontSize * 0.12f);
          stream.lineTo(left + textWidth, baseline - fontSize * 0.12f);
          stream.stroke();
        }
        if (edit.strikethrough) {
          stream.moveTo(left, baseline + fontSize * 0.3f);
          stream.lineTo(left + textWidth, baseline + fontSize * 0.3f);
          stream.stroke();
        }
      }
    }
    return true;
  }

  /** Splits text into runs of the original font and its stand-in for the characters it lacks. */
  private static List<FontRun> fallbackRuns(PDFont original, String text) {
    boolean whole = !sameDesignFallback(original) && needsWholeFallback(text, (glyph) -> ownGlyph(original, glyph));
    if (!whole && canEncodeWithFont(text, original) && text.codePoints().allMatch((codePoint) -> ownGlyph(original, new String(Character.toChars(codePoint))))) {
      return List.of(new FontRun(text, original));
    }
    List<FontRun> runs = new ArrayList<>();
    StringBuilder current = new StringBuilder();
    PDFont currentFont = null;
    for (int offset = 0; offset < text.length();) {
      int codePoint = text.codePointAt(offset);
      offset += Character.charCount(codePoint);
      String glyph = new String(Character.toChars(codePoint));
      boolean own = ownGlyph(original, glyph) && canEncodeWithFont(glyph, original)
          && (!whole || !drawnByFallback(original, glyph));
      // A space the font lacks becomes a plain gap (a null-font run).
      boolean gap = !own && !whole && isSpace(glyph);
      PDFont font = own ? original : gap ? null : glyphFallbackFont(original, glyph);
      String drawn = own ? glyph : gap ? " " : fallbackGlyph(glyph, font);
      if (drawn.isEmpty()) continue;
      if (current.length() > 0 && font != currentFont) {
        runs.add(new FontRun(current.toString(), currentFont));
        current.setLength(0);
      }
      current.append(drawn);
      currentFont = font;
    }
    if (current.length() > 0) runs.add(new FontRun(current.toString(), currentFont));
    return runs.isEmpty() ? List.of(new FontRun(" ", original)) : runs;
  }

  /**
   * Whether the PDF draws this character with this font anywhere in the
   * document (what the editor treats as the font's own); fonts the document
   * never draws with fall back to whether the font can encode it.
   */
  private static boolean ownGlyph(PDFont font, String glyph) {
    Map<COSBase, FontCodec> document = DOCUMENT_CODECS.get();
    FontCodec learned = document == null || font == null ? null : document.get(font.getCOSObject());
    return learned != null ? learned.encode(glyph) != null : canEncodeWithFont(glyph, font);
  }

  /** Whether the fallback for this font has the character (else the font's own glyph stays). */
  private static boolean drawnByFallback(PDFont original, String glyph) {
    return canEncodeWithFont(glyph, glyphFallbackFont(original, glyph));
  }

  /**
   * A line that needs a character its font lacks is drawn in the fallback as a
   * whole, so it reads as one typeface instead of a few odd letters. A space
   * counts too (TeX fonts have none), exactly as in the editor.
   */
  /**
   * Whether the stand-in is the same typeface: the font itself installed, or a
   * bundled cut of its design (Latin Modern for TeX, metric twins). Then only
   * the missing letters use it and every other letter keeps the PDF's glyph,
   * like a browser does; a different typeface takes over the whole line.
   */
  private static boolean sameDesignFallback(PDFont font) {
    if (font == null) return false;
    return SAME_DESIGN.computeIfAbsent(font.getCOSObject(), (key) ->
        installedTrueType(cleanFontName(fontPostScriptName(font))) != null || fontTraits(font).knownFamily() != null);
  }

  private static final Map<COSBase, Boolean> SAME_DESIGN = Collections.synchronizedMap(new java.util.WeakHashMap<>());

  private static boolean needsWholeFallback(String text, java.util.function.Predicate<String> own) {
    return text.codePoints()
        .mapToObj((codePoint) -> new String(Character.toChars(codePoint)))
        .anyMatch((glyph) -> !isSpace(glyph) && !own.test(glyph));
  }

  /**
   * A space the font has no glyph for (TeX fonts have none) is drawn as a gap
   * of a third of an em, TeX's own word space; the editor shows the same.
   */
  private static final float SPACE_GAP_EM = 1f / 3f;

  private static boolean isSpace(String glyph) {
    return " ".equals(glyph) || "\u00a0".equals(glyph);
  }

  private static List<Object> spaceGapTokens(int count) {
    COSArray positioning = new COSArray();
    positioning.add(new COSFloat(-1000f * SPACE_GAP_EM * count));
    return List.of(positioning, Operator.getOperator("TJ"));
  }

  /**
   * Text written straight into content-stream tokens bypasses setFont and
   * showText, which normally queue a subset font for embedding and tell it
   * which glyphs to keep. Without this the font would not be embedded at all.
   */
  private static void registerSubsetGlyphs(PDFont font, String text) {
    if (!(font instanceof PDType0Font type0) || !type0.willBeSubset()) return;
    PDDocument document = EDIT_DOCUMENT.get();
    if (document != null) {
      // setFont is the public way to queue a font for subsetting; this
      // appearance stream is never attached to anything, so it is not saved.
      PDAppearanceStream scratch = new PDAppearanceStream(document);
      scratch.setResources(new PDResources());
      try (PDPageContentStream queue = new PDPageContentStream(document, scratch)) {
        queue.setFont(type0, 1);
      } catch (IOException | RuntimeException ignored) {
        // The font then stays unembedded; the text still exports.
      }
    }
    text.codePoints().forEach(type0::addToSubset);
  }

  /** Chrome's (Skia's) fake-bold outline growth: 1/24 of the size at 9 and below, 1/32 from 36. */
  private static float syntheticBoldStroke(float fontSize) {
    float t = Math.max(0f, Math.min(1f, (fontSize - 9f) / 27f));
    return fontSize * (1f / 24f + (1f / 32f - 1f / 24f) * t);
  }

  private static float runsWidth(List<FontRun> runs, float fontSize) {
    float width = 0;
    for (FontRun run : runs) {
      width += run.font() == null
          ? fontSize * SPACE_GAP_EM * run.text().length()
          : pdfTextWidth(run.font(), run.text(), fontSize);
    }
    return width;
  }

  private static float overlayAlignedLeft(
      TextEdit edit,
      float measuredWidth,
      float fontSize,
      float pageWidth,
      float fallbackLeft,
      float fallbackRight) throws IOException {
    String alignment = edit.alignment == null ? "" : edit.alignment.toLowerCase();
    if (!edit.overlay || edit.alignRect.size() < 4 || (!"center".equals(alignment) && !"right".equals(alignment))) {
      return fallbackLeft;
    }
    if (edit.visualRect.size() >= 2) {
      float visualLeft = coordinate(edit.visualRect.get(0), pageWidth);
      if (visualLeft >= 0f) {
        return visualLeft;
      }
    }

    float containerLeft = coordinate(edit.alignRect.get(0), pageWidth);
    float containerRight = coordinate(edit.alignRect.get(2), pageWidth);
    if (containerRight <= containerLeft) {
      return fallbackLeft;
    }

    float textWidth = measuredWidth;
    if (textWidth <= 0) {
      textWidth = Math.max(1f, fallbackRight - fallbackLeft);
    }

    float alignedLeft = "right".equals(alignment)
        ? containerRight - textWidth
        : containerLeft + (containerRight - containerLeft - textWidth) * 0.5f;
    return Math.max(0f, alignedLeft);
  }

  private static float pdfTextWidth(PDFont font, String text, float fontSize) {
    if (font == null || text == null || text.isEmpty() || fontSize <= 0) {
      return 0f;
    }
    try {
      return font.getStringWidth(text) * fontSize / 1000f;
    } catch (IOException | IllegalArgumentException ignored) {
      return 0f;
    }
  }

  private static OverlayStyle findOverlayStyle(PDPage page, TextEdit edit) throws IOException {
    PDResources resources = page.getResources();
    PDFStreamParser parser = new PDFStreamParser(page);
    List<Object> tokens = parser.parse();
    List<TextUnit> units = collectTextUnits(resources, tokens);
    if (units.isEmpty()) {
      return OverlayStyle.empty();
    }

    StringBuilder pageText = new StringBuilder();
    for (TextUnit unit : units) {
      unit.start = pageText.length();
      pageText.append(unit.text);
      unit.end = pageText.length();
    }

    TextRange range = findBestTextRange(pageText.toString(), units, edit);
    if (range == null) {
      return OverlayStyle.empty();
    }

    for (TextUnit unit : units) {
      if (unit.end > range.start && unit.start < range.end && unit.font != null && unit.fontSize > 0) {
        return new OverlayStyle(unit.font, unit.fontSize);
      }
    }
    return OverlayStyle.empty();
  }

  private static void setOverlayColor(PDPageContentStream stream, List<Double> color) throws IOException {
    if (color.size() >= 3) {
      if (isNearWhite(color)) {
        stream.setNonStrokingColor(0f);
        return;
      }
      stream.setNonStrokingColor(
          clampColor(color.get(0)),
          clampColor(color.get(1)),
          clampColor(color.get(2)));
      return;
    }
    stream.setNonStrokingColor(0f);
  }

  private static void setOverlayStrokeColor(PDPageContentStream stream, List<Double> color) throws IOException {
    if (color.size() >= 3) {
      if (isNearWhite(color)) {
        stream.setStrokingColor(0f);
        return;
      }
      stream.setStrokingColor(
          clampColor(color.get(0)),
          clampColor(color.get(1)),
          clampColor(color.get(2)));
      return;
    }
    stream.setStrokingColor(0f);
  }

  private static boolean isNearWhite(List<Double> color) {
    return color.get(0) > 0.92 && color.get(1) > 0.92 && color.get(2) > 0.92;
  }

  private static float clampColor(double value) {
    return (float) Math.max(0, Math.min(1, value));
  }

  private static PDFont overlayFont(
      PDDocument document,
      TextEdit edit,
      Standard14Fonts.FontName fallback) throws IOException {
    File fontFile = findSystemFont(edit.fontName, edit.bold, edit.italic);
    if (fontFile != null) {
      try {
        return PDType0Font.load(document, fontFile);
      } catch (IOException | IllegalArgumentException ignored) {
        // Fall through to the built-in PDF font when the local font cannot be embedded.
      }
    }
    // Any other family the user picked, as installed on this computer.
    org.apache.fontbox.ttf.TrueTypeFont installed = installedTrueType(installedFamilyFont(edit.fontName, edit.bold, edit.italic));
    if (installed != null) {
      try {
        return PDType0Font.load(document, installed, true);
      } catch (IOException | IllegalArgumentException ignored) {
        // Fall through to the built-in PDF font.
      }
    }
    return new PDType1Font(fallback);
  }

  private static PDFont findPageFont(
      PDPage page,
      String requestedName,
      String text,
      boolean bold,
      boolean italic) throws IOException {
    String requested = normalizeFontName(requestedName);
    if (requested.isEmpty() || requested.startsWith("docuflexpdffont")) {
      return null;
    }
    PDFont best = null;
    int bestScore = Integer.MIN_VALUE;
    PDResources resources = page.getResources();
    if (resources == null) {
      return null;
    }
    for (COSName resourceName : resources.getFontNames()) {
      PDFont candidate = resources.getFont(resourceName);
      if (candidate == null || !canEncodeWithFont(text, candidate)) {
        continue;
      }
      String candidateName = normalizeFontName(candidate.getName());
      if (!candidateName.contains(requested) && !requested.contains(candidateName)) {
        continue;
      }
      boolean candidateBold = looksLikeBoldName(candidate.getName());
      boolean candidateItalic = fontIsItalic(candidate);
      int score = 10 + (candidateBold == bold ? 2 : 0) + (candidateItalic == italic ? 2 : 0);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    return best;
  }

  private static boolean fontIsItalic(PDFont font) {
    if (font == null) {
      return false;
    }
    PDFontDescriptor descriptor = font.getFontDescriptor();
    return descriptor != null && descriptor.isItalic()
        || font.getName() != null && font.getName().toLowerCase(Locale.ROOT).matches(".*(italic|oblique).*");
  }

  private static File findSystemFont(String requestedName, boolean bold, boolean italic) {
    String normalized = normalizeFontName(requestedName);
    if (normalized.isEmpty()) {
      return null;
    }

    List<String> candidates = new ArrayList<>();
    if (normalized.contains("inter")) {
      candidates.add(italic
          ? "backend/fonts/inter-variable-italic.ttf"
          : "backend/fonts/inter-variable-normal.ttf");
    }
    if (normalized.contains("geist")) {
      candidates.add(italic
          ? "backend/fonts/geist-variable-italic.ttf"
          : "backend/fonts/geist-variable-normal.ttf");
    }
    if (normalized.contains("arial")) {
      candidates.add(bold && italic
          ? "/System/Library/Fonts/Supplemental/Arial Bold Italic.ttf"
          : bold
              ? "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
              : italic
                  ? "/System/Library/Fonts/Supplemental/Arial Italic.ttf"
                  : "/System/Library/Fonts/Supplemental/Arial.ttf");
      candidates.add("/Library/Fonts/Arial Unicode.ttf");
    }
    if (normalized.contains("helvetica")) {
      candidates.add("/System/Library/Fonts/Helvetica.ttc");
      candidates.add("/System/Library/Fonts/Supplemental/Arial.ttf");
    }
    if (normalized.contains("times")) {
      candidates.add(bold && italic
          ? "/System/Library/Fonts/Supplemental/Times New Roman Bold Italic.ttf"
          : bold
              ? "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf"
              : italic
                  ? "/System/Library/Fonts/Supplemental/Times New Roman Italic.ttf"
                  : "/System/Library/Fonts/Supplemental/Times New Roman.ttf");
      candidates.add("/System/Library/Fonts/Times.ttc");
    }

    for (String candidate : candidates) {
      File file = new File(candidate);
      if (file.isFile()) {
        return file;
      }
    }
    return null;
  }

  private static String normalizeFontName(String value) {
    String clean = cleanFontName(value == null ? "" : value);
    return clean
        .replace("-", "")
        .replace("_", "")
        .replace(" ", "")
        .toLowerCase();
  }

  private static float coordinate(double value, float extent) {
    if (value >= -0.05 && value <= 1.05) {
      return (float) value * extent;
    }
    return (float) value;
  }

  private static float overlayFontSize(TextEdit edit, float pageHeight, float rectHeight) {
    if (edit.fontSize > 0) {
      if (edit.pageSize.size() >= 2 && edit.pageSize.get(1) > 0) {
        return Math.max(4f, (float) (edit.fontSize * pageHeight / edit.pageSize.get(1)));
      }
      return Math.max(4f, (float) edit.fontSize);
    }
    return Math.max(4f, rectHeight * 0.72f);
  }

  private static String sanitizeWinAnsi(String value) {
    return value
        .replace("\uFB00", "ff")
        .replace("\uFB01", "fi")
        .replace("\uFB02", "fl")
        .replace("\uFB03", "ffi")
        .replace("\uFB04", "ffl")
        .replace("\u2013", "-")
        .replace("\u2014", "-")
        .replace("\u2018", "'")
        .replace("\u2019", "'")
        .replace("\u201C", "\"")
        .replace("\u201D", "\"");
  }

  private static boolean rewritePageWithCandidates(PDDocument document, PDPage page, TextEdit edit) throws IOException {
    if (rewritePage(document, page, edit)) {
      return true;
    }
    for (String candidate : edit.oldTextCandidates) {
      if (candidate == null || candidate.isBlank() || candidate.equals(edit.oldText) || candidate.equals(edit.newText)) {
        continue;
      }
      if (rewritePage(document, page, new TextEdit(
          edit.page,
          candidate,
          edit.newText,
          List.of(),
          edit.occurrence,
          edit.rect,
          edit.alignRect,
          edit.visualRect,
          edit.originalRect,
          edit.pageSize,
          edit.color,
          edit.fontName,
          edit.fontSize,
          edit.bold,
          edit.moved,
          edit.overlay,
          edit.alignment,
          edit.fontChanged,
          edit.boldChanged,
          edit.italic,
          edit.italicChanged,
          edit.underline,
          edit.strikethrough,
          edit.letterSpacing, -1))) {
        return true;
      }
    }
    return false;
  }

  private static boolean moveAndRewritePageText(PDDocument document, PDPage page, TextEdit edit) throws IOException {
    TextEdit moveOnlyEdit = new TextEdit(
        edit.page,
        edit.oldText,
        edit.oldText,
        edit.oldTextCandidates,
        edit.occurrence,
        edit.rect,
        edit.alignRect,
        edit.visualRect,
        edit.originalRect,
        edit.pageSize,
        edit.color,
        edit.fontName,
        edit.fontSize,
        edit.bold,
        true,
        false,
        "",
        edit.fontChanged,
        edit.boldChanged,
        edit.italic,
        edit.italicChanged,
        edit.underline,
        edit.strikethrough,
        edit.letterSpacing, -1);
    if (!movePageTextWithCandidates(document, page, moveOnlyEdit)) {
      return false;
    }

    TextEdit rewriteOnlyEdit = new TextEdit(
        edit.page,
        edit.oldText,
        edit.newText,
        edit.oldTextCandidates,
        edit.occurrence,
        edit.rect,
        edit.alignRect,
        edit.visualRect,
        edit.originalRect,
        edit.pageSize,
        edit.color,
        edit.fontName,
        edit.fontSize,
        edit.bold,
        false,
        false,
        "",
        edit.fontChanged,
        edit.boldChanged,
        edit.italic,
        edit.italicChanged,
        edit.underline,
        edit.strikethrough,
        edit.letterSpacing, -1);
    return rewritePageWithCandidates(document, page, rewriteOnlyEdit);
  }

  private static boolean movePageTextWithCandidates(PDDocument document, PDPage page, TextEdit edit) throws IOException {
    if (movePageText(document, page, edit)) {
      return true;
    }
    for (String candidate : edit.oldTextCandidates) {
      if (candidate == null || candidate.isBlank() || candidate.equals(edit.oldText)) {
        continue;
      }
      if (movePageText(document, page, new TextEdit(
          edit.page,
          candidate,
          edit.newText,
          List.of(),
          edit.occurrence,
          edit.rect,
          edit.alignRect,
          edit.visualRect,
          edit.originalRect,
          edit.pageSize,
          edit.color,
          edit.fontName,
          edit.fontSize,
          edit.bold,
          edit.moved,
          edit.overlay,
          edit.alignment,
          edit.fontChanged,
          edit.boldChanged,
          edit.italic,
          edit.italicChanged,
          edit.underline,
          edit.strikethrough,
          edit.letterSpacing, -1))) {
        return true;
      }
    }
    return false;
  }

  private static boolean movePageText(PDDocument document, PDPage page, TextEdit edit) throws IOException {
    if (edit.rect.size() < 4 || edit.originalRect.size() < 4) {
      return false;
    }
    PDResources resources = page.getResources();
    PDFStreamParser parser = new PDFStreamParser(page);
    List<Object> tokens = parser.parse();
    boolean changed = moveInTokens(resources, tokens, edit, page.getMediaBox().getWidth(), page.getMediaBox().getHeight());
    if (!changed) {
      return false;
    }
    PDStream newContents = new PDStream(document);
    try (OutputStream out = newContents.createOutputStream()) {
      new ContentStreamWriter(out).writeTokens(tokens);
    }
    page.setContents(newContents);
    return true;
  }

  private static boolean moveInTokens(
      PDResources resources,
      List<Object> tokens,
      TextEdit edit,
      float pageWidth,
      float pageHeight) throws IOException {
    List<TextUnit> units = collectTextUnits(resources, tokens);
    if (units.isEmpty()) {
      return false;
    }

    StringBuilder pageText = new StringBuilder();
    for (TextUnit unit : units) {
      unit.start = pageText.length();
      pageText.append(unit.text);
      unit.end = pageText.length();
    }

    TextRange range = findBestTextRange(pageText.toString(), units, edit);
    if (range == null) {
      return false;
    }

    List<TextUnit> affected = new ArrayList<>();
    for (TextUnit unit : units) {
      if (unit.end > range.start && unit.start < range.end) {
        affected.add(unit);
      }
    }
    if (affected.isEmpty()) {
      return false;
    }

    float dx = coordinate(edit.rect.get(0), pageWidth) - coordinate(edit.originalRect.get(0), pageWidth);
    float dy = coordinate(edit.rect.get(1), pageHeight) - coordinate(edit.originalRect.get(1), pageHeight);
    if (Math.abs(dx) < 0.01f && Math.abs(dy) < 0.01f) {
      return true;
    }

    List<Integer> operatorIndexes = new ArrayList<>();
    for (TextUnit unit : affected) {
      if (unit.operatorIndex < 1 || unit.operatorIndex >= tokens.size()) {
        return false;
      }
      if (!operatorIndexes.contains(unit.operatorIndex)) {
        operatorIndexes.add(unit.operatorIndex);
      }
    }

    // Shift each run of moved text on its own: "dx dy Td" after the operator
    // that positions it and "-dx -dy Td" after it. Lines are often placed
    // relative to the previous line (TeX does this), so changing the
    // positioning operator itself would drag every following line along.
    Collections.sort(operatorIndexes);
    List<int[]> runs = new ArrayList<>();
    for (int operatorIndex : operatorIndexes) {
      int[] last = runs.isEmpty() ? null : runs.get(runs.size() - 1);
      if (last != null && onlyTextStateBetween(tokens, last[1], operatorIndex, operatorIndexes)) {
        last[1] = operatorIndex;
      } else {
        runs.add(new int[] {operatorIndex, operatorIndex});
      }
    }
    Map<Integer, List<Object>> insertions = new java.util.TreeMap<>(Collections.reverseOrder());
    for (int[] run : runs) {
      int positionOperator = findNearestTextPositionOperator(tokens, run[0], operatorIndexes);
      if (positionOperator < 0) {
        return false;
      }
      float[] scale = textMatrixScale(tokens, positionOperator);
      float tdx = dx / scale[0];
      float tdy = dy / scale[1];
      insertions.computeIfAbsent(positionOperator + 1, (key) -> new ArrayList<>())
          .addAll(List.of(new COSFloat(tdx), new COSFloat(tdy), Operator.getOperator("Td")));
      insertions.computeIfAbsent(run[1] + 1, (key) -> new ArrayList<>())
          .addAll(0, List.of(new COSFloat(-tdx), new COSFloat(-tdy), Operator.getOperator("Td")));
    }
    List<Integer> shifted = new ArrayList<>();
    for (TextUnit unit : affected) {
      int offset = 0;
      for (Map.Entry<Integer, List<Object>> insertion : insertions.entrySet()) {
        if (insertion.getKey() <= unit.operatorIndex) offset += insertion.getValue().size();
      }
      shifted.add(unit.operatorIndex + offset);
    }
    insertions.forEach((index, inserted) -> tokens.addAll(index, inserted));
    promoteTextBlocksToFront(tokens, affected, shifted, edit);
    return !runs.isEmpty();
  }

  /** Whether only text-state operators (font, spacing, …) lie between two moved text operators. */
  private static boolean onlyTextStateBetween(List<Object> tokens, int from, int to, List<Integer> movedOperators) {
    for (int index = from + 1; index < to; index += 1) {
      if (!(tokens.get(index) instanceof Operator operator)) continue;
      String name = operator.getName();
      boolean shows = "Tj".equals(name) || "TJ".equals(name);
      if (shows && movedOperators.contains(index)) continue;
      if (shows || "'".equals(name) || "\"".equals(name) || "T*".equals(name) || "Td".equals(name)
          || "TD".equals(name) || "Tm".equals(name) || "BT".equals(name) || "ET".equals(name)) {
        return false;
      }
    }
    return true;
  }

  /** The text matrix's horizontal and vertical scale at a positioning operator (Td moves in text space). */
  private static float[] textMatrixScale(List<Object> tokens, int positionOperator) {
    for (int index = positionOperator; index >= 0; index -= 1) {
      if (!(tokens.get(index) instanceof Operator operator)) continue;
      if ("BT".equals(operator.getName())) break;
      if ("Tm".equals(operator.getName()) && index >= 6
          && tokens.get(index - 6) instanceof COSNumber a && tokens.get(index - 3) instanceof COSNumber d
          && Math.abs(a.floatValue()) > 1e-4f && Math.abs(d.floatValue()) > 1e-4f) {
        return new float[] {a.floatValue(), d.floatValue()};
      }
    }
    return new float[] {1f, 1f};
  }

  private static void promoteTextBlocksToFront(List<Object> tokens, List<TextUnit> units, List<Integer> operatorIndexes, TextEdit edit) {
    List<TextBlockMove> moves = new ArrayList<>();
    for (int unitIndex = 0; unitIndex < units.size(); unitIndex += 1) {
      TextUnit unit = units.get(unitIndex);
      TextBlockRange range = findTextBlockRange(tokens, operatorIndexes.get(unitIndex));
      if (range != null) {
        moves.add(new TextBlockMove(range, unit.fontName, unit.fontSize, unit.renderingMode));
      }
    }
    if (moves.isEmpty()) {
      return;
    }

    moves.sort((a, b) -> Integer.compare(a.range.start, b.range.start));
    List<TextBlockMove> merged = new ArrayList<>();
    for (TextBlockMove move : moves) {
      if (merged.isEmpty()) {
        merged.add(move);
        continue;
      }
      TextBlockMove previous = merged.get(merged.size() - 1);
      if (move.range.start <= previous.range.end + 1) {
        merged.set(merged.size() - 1, new TextBlockMove(
            new TextBlockRange(previous.range.start, Math.max(previous.range.end, move.range.end)),
            previous.fontName,
            previous.fontSize,
            previous.renderingMode));
      } else {
        merged.add(move);
      }
    }

    List<Object> promoted = new ArrayList<>();
    for (TextBlockMove move : merged) {
      List<Object> block = new ArrayList<>(tokens.subList(move.range.start, move.range.end + 1));
      ensureTextBlockTextState(block, move.fontName, move.fontSize, move.renderingMode);
      promoted.addAll(block);
    }
    for (int i = merged.size() - 1; i >= 0; i -= 1) {
      TextBlockMove move = merged.get(i);
      TextBlockRange range = move.range;
      stabilizeFollowingInheritedTextState(tokens, range.end, move.fontName, move.fontSize, move.renderingMode);
      tokens.subList(range.start, range.end + 1).clear();
    }

    tokens.add(Operator.getOperator("q"));
    appendNonStrokingColorTokens(tokens, edit.color);
    tokens.addAll(promoted);
    tokens.add(Operator.getOperator("Q"));
  }

  private static void stabilizeFollowingInheritedTextState(
      List<Object> tokens,
      int afterIndex,
      COSName fontName,
      float fontSize,
      int renderingMode) {
    if (fontName == null || fontSize <= 0) {
      return;
    }

    int stop = tokens.size();
    for (int index = afterIndex + 1; index < tokens.size(); index += 1) {
      Object token = tokens.get(index);
      if (token instanceof Operator operator && "Tf".equals(operator.getName())) {
        stop = index;
        break;
      }
    }

    for (int index = afterIndex + 1; index < stop; index += 1) {
      Object token = tokens.get(index);
      if (!(token instanceof Operator operator) || !"BT".equals(operator.getName())) {
        continue;
      }

      int end = findEndTextIndex(tokens, index + 1);
      if (end < 0 || end > stop) {
        break;
      }
      if (!textBlockHasText(tokens, index + 1, end) || textBlockHasFontBeforeText(tokens, index + 1, end)) {
        index = end;
        continue;
      }

      int before = tokens.size();
      ensureTextBlockTextState(tokens.subList(index, end + 1), fontName, fontSize, renderingMode);
      int added = tokens.size() - before;
      stop += added;
      index = end + added;
    }
  }

  private static int findEndTextIndex(List<Object> tokens, int start) {
    for (int index = start; index < tokens.size(); index += 1) {
      Object token = tokens.get(index);
      if (token instanceof Operator operator && "ET".equals(operator.getName())) {
        return index;
      }
    }
    return -1;
  }

  private static boolean textBlockHasText(List<Object> tokens, int start, int end) {
    for (int index = start; index <= end; index += 1) {
      Object token = tokens.get(index);
      if (token instanceof Operator operator
          && ("Tj".equals(operator.getName()) || "TJ".equals(operator.getName()) || "'".equals(operator.getName()) || "\"".equals(operator.getName()))) {
        return true;
      }
    }
    return false;
  }

  private static boolean textBlockHasFontBeforeText(List<Object> tokens, int start, int end) {
    for (int index = start; index <= end; index += 1) {
      Object token = tokens.get(index);
      if (!(token instanceof Operator operator)) {
        continue;
      }
      String name = operator.getName();
      if ("Tf".equals(name)) {
        return true;
      }
      if ("Tj".equals(name) || "TJ".equals(name) || "'".equals(name) || "\"".equals(name)) {
        return false;
      }
    }
    return false;
  }

  private static void ensureTextBlockTextState(List<Object> block, COSName fontName, float fontSize, int renderingMode) {
    int beginText = -1;
    int firstText = -1;
    boolean hasFont = false;
    boolean hasRenderingMode = false;
    for (int index = 0; index < block.size(); index += 1) {
      Object token = block.get(index);
      if (!(token instanceof Operator operator)) {
        continue;
      }
      String name = operator.getName();
      if ("BT".equals(name) && beginText < 0) {
        beginText = index;
      } else if (beginText >= 0 && "Tf".equals(name)) {
        hasFont = true;
      } else if (beginText >= 0 && "Tr".equals(name)) {
        hasRenderingMode = true;
      } else if (beginText >= 0 && ("Tj".equals(name) || "TJ".equals(name) || "'".equals(name) || "\"".equals(name))) {
        firstText = index;
        break;
      } else if (beginText >= 0 && "ET".equals(name)) {
        break;
      }
    }
    if (beginText < 0 || hasFont || firstText < 0) {
      if (beginText < 0 || firstText < 0 || hasRenderingMode) {
        return;
      }
      block.add(beginText + 1, COSInteger.get(renderingMode));
      block.add(beginText + 2, Operator.getOperator("Tr"));
      return;
    }

    int insertAt = beginText + 1;
    if (!hasRenderingMode) {
      block.add(insertAt, COSInteger.get(renderingMode));
      block.add(insertAt + 1, Operator.getOperator("Tr"));
      insertAt += 2;
    }
    if (!hasFont && fontName != null && fontSize > 0) {
      block.add(insertAt, fontName);
      block.add(insertAt + 1, new COSFloat(fontSize));
      block.add(insertAt + 2, Operator.getOperator("Tf"));
    }
  }

  private static TextBlockRange findTextBlockRange(List<Object> tokens, int textOperatorIndex) {
    int start = -1;
    for (int index = textOperatorIndex; index >= 0; index -= 1) {
      Object token = tokens.get(index);
      if (!(token instanceof Operator operator)) {
        continue;
      }
      String name = operator.getName();
      if ("BT".equals(name)) {
        start = index;
        break;
      }
      if ("ET".equals(name)) {
        return null;
      }
    }
    if (start < 0) {
      return null;
    }

    int end = -1;
    for (int index = textOperatorIndex; index < tokens.size(); index += 1) {
      Object token = tokens.get(index);
      if (!(token instanceof Operator operator)) {
        continue;
      }
      String name = operator.getName();
      if ("ET".equals(name)) {
        end = index;
        break;
      }
      if ("BT".equals(name) && index != start) {
        return null;
      }
    }
    if (end < 0) {
      return null;
    }

    return new TextBlockRange(start, end);
  }

  private static void appendNonStrokingColorTokens(List<Object> tokens, List<Double> color) {
    if (color.size() < 3 || isNearWhite(color)) {
      return;
    }
    tokens.add(new COSFloat(clampColor(color.get(0))));
    tokens.add(new COSFloat(clampColor(color.get(1))));
    tokens.add(new COSFloat(clampColor(color.get(2))));
    tokens.add(Operator.getOperator("rg"));
  }

  /**
   * The position operator that places a text operator. Runs of the moved text
   * itself may sit in between (an edited line is drawn as one run per font),
   * since they share that position; any other text stops the search.
   */
  private static int findNearestTextPositionOperator(List<Object> tokens, int textOperatorIndex, List<Integer> movedOperators) {
    for (int index = textOperatorIndex - 1; index >= 0; index -= 1) {
      Object token = tokens.get(index);
      if (!(token instanceof Operator operator)) {
        continue;
      }

      String name = operator.getName();
      if ("Tm".equals(name) || "Td".equals(name) || "TD".equals(name)) {
        return index;
      }
      boolean shows = "Tj".equals(name) || "TJ".equals(name);
      if (shows && movedOperators.contains(index)) {
        continue;
      }
      if (shows || "'".equals(name) || "\"".equals(name) || "BT".equals(name) || "ET".equals(name)) {
        break;
      }
    }
    return -1;
  }

  private static boolean rewritePage(PDDocument document, PDPage page, TextEdit edit) throws IOException {
    PDResources resources = page.getResources();
    PDFStreamParser parser = new PDFStreamParser(page);
    List<Object> tokens = parser.parse();
    Map<PDFont, FontCodec> codecs = learnFontCodecs(resources, tokens);
    boolean changed = replaceInTokens(resources, tokens, edit, codecs);

    if (changed) {
      PDStream newContents = new PDStream(document);
      try (OutputStream out = newContents.createOutputStream()) {
        new ContentStreamWriter(out).writeTokens(tokens);
      }
      page.setContents(newContents);
      return true;
    }

    Set<COSBase> visitedStreams = Collections.newSetFromMap(new IdentityHashMap<>());
    return rewriteNestedForms(resources, tokens, edit, visitedStreams);
  }

  private static boolean rewriteForm(
      PDFormXObject form,
      PDResources parentResources,
      TextEdit edit,
      Set<COSBase> visitedStreams) throws IOException {
    if (!visitedStreams.add(form.getCOSObject())) {
      return false;
    }

    PDResources resources = form.getResources() != null ? form.getResources() : parentResources;
    PDFStreamParser parser = new PDFStreamParser(form);
    List<Object> tokens = parser.parse();
    Map<PDFont, FontCodec> codecs = learnFontCodecs(resources, tokens);
    boolean changed = replaceInTokens(resources, tokens, edit, codecs);

    if (changed) {
      try (OutputStream out = form.getContentStream().createOutputStream()) {
        new ContentStreamWriter(out).writeTokens(tokens);
      }
      return true;
    }

    return rewriteNestedForms(resources, tokens, edit, visitedStreams);
  }

  private static boolean replaceInTokens(
      PDResources resources,
      List<Object> tokens,
      TextEdit edit,
      Map<PDFont, FontCodec> codecs) throws IOException {
    boolean changed = false;
    PDFont currentFont = null;
    COSName currentFontName = null;
    float currentFontSize = 0f;
    MatchCounter counter = new MatchCounter(edit.occurrence);

    for (int index = 0; index < tokens.size(); index += 1) {
      Object token = tokens.get(index);
      if (!(token instanceof Operator operator)) {
        continue;
      }

      String name = operator.getName();
      if ("Tf".equals(name)) {
        currentFontName = findFontName(tokens, index);
        currentFontSize = findFontSize(tokens, index);
        currentFont = findFont(resources, tokens, index);
      } else if ("Tj".equals(name) || "'".equals(name)) {
        changed |= replacePreviousString(
            resources,
            tokens,
            index,
            edit,
            currentFont,
            currentFontName,
            currentFontSize,
            codecs.get(currentFont),
            counter,
            "Tj".equals(name));
      } else if ("TJ".equals(name)) {
        changed |= replacePreviousArray(
            resources,
            tokens,
            index,
            edit,
            currentFont,
            currentFontName,
            currentFontSize,
            codecs.get(currentFont),
            counter);
      } else if ("\"".equals(name)) {
        changed |= replaceDoubleQuoteString(
            resources,
            tokens,
            index,
            edit,
            currentFont,
            currentFontName,
            currentFontSize,
            codecs.get(currentFont),
            counter);
      }
    }

    if (!changed) {
      changed = replaceAcrossTextUnits(resources, tokens, edit, codecs);
    }

    return changed;
  }

  private static boolean rewriteNestedForms(
      PDResources resources,
      List<Object> tokens,
      TextEdit edit,
      Set<COSBase> visitedStreams) throws IOException {
    if (resources == null) {
      return false;
    }

    for (int index = 0; index < tokens.size(); index += 1) {
      Object token = tokens.get(index);
      if (!(token instanceof Operator operator) || !"Do".equals(operator.getName())) {
        continue;
      }
      if (index < 1 || !(tokens.get(index - 1) instanceof COSName xObjectName)) {
        continue;
      }

      PDXObject xObject = resources.getXObject(xObjectName);
      if (xObject instanceof PDFormXObject form && rewriteForm(form, resources, edit, visitedStreams)) {
        return true;
      }
    }

    return false;
  }

  private static boolean replaceAcrossTextUnits(
      PDResources resources,
      List<Object> tokens,
      TextEdit edit,
      Map<PDFont, FontCodec> codecs) throws IOException {
    List<TextUnit> units = collectTextUnits(resources, tokens);
    if (units.isEmpty()) {
      return false;
    }

    StringBuilder pageText = new StringBuilder();
    for (TextUnit unit : units) {
      unit.start = pageText.length();
      pageText.append(unit.text);
      unit.end = pageText.length();
    }

    TextRange range = findBestTextRange(pageText.toString(), units, edit);
    if (range == null) {
      return false;
    }

    List<TextUnit> affected = new ArrayList<>();
    for (TextUnit unit : units) {
      if (unit.end > range.start && unit.start < range.end) {
        affected.add(unit);
      }
    }
    if (affected.isEmpty()) {
      return false;
    }

    TextUnit first = affected.get(0);
    TextUnit last = affected.get(affected.size() - 1);
    int firstLocalStart = Math.max(0, range.start - first.start);
    int lastLocalEnd = Math.min(last.text.length(), range.end - last.start);
    String mixedReplacement = first.text.substring(0, firstLocalStart) + edit.newText + last.text.substring(lastLocalEnd);

    if (usesMixedTextStyle(affected)) {
      boolean mixed = replaceAcrossWithMixedFonts(resources, affected, mixedReplacement, edit, codecs);
      if (mixed) {
        return true;
      }
    }

    List<UnitReplacement> replacements = new ArrayList<>();
    boolean needsMixedFallback = false;
    for (TextUnit unit : affected) {
      int localStart = Math.max(0, range.start - unit.start);
      int localEnd = Math.min(unit.text.length(), range.end - unit.start);
      String nextText;
      if (unit == first && unit == last) {
        nextText = unit.text.substring(0, localStart) + edit.newText + unit.text.substring(localEnd);
      } else if (unit == first) {
        nextText = unit.text.substring(0, localStart) + edit.newText;
      } else if (unit == last) {
        nextText = unit.text.substring(localEnd);
      } else {
        nextText = "";
      }

      EncodedText encoded = encodeString(nextText, unit.font, codecs.get(unit.font));
      if (encoded == null) {
        needsMixedFallback = true;
        break;
      }
      replacements.add(new UnitReplacement(unit, encoded));
    }

    if (needsMixedFallback) {
      return replaceAcrossWithMixedFonts(resources, affected, mixedReplacement, edit, codecs);
    }

    for (UnitReplacement replacement : replacements) {
      replacement.unit.value.setValue(replacement.encoded.bytes);
    }
    return true;
  }

  private static boolean usesMixedTextStyle(List<TextUnit> units) {
    if (units.size() < 2) {
      return false;
    }
    TextUnit first = units.get(0);
    for (int i = 1; i < units.size(); i += 1) {
      TextUnit next = units.get(i);
      if (next.font != first.font) {
        return true;
      }
      if (first.fontName == null ? next.fontName != null : !first.fontName.equals(next.fontName)) {
        return true;
      }
      if (Math.abs(next.fontSize - first.fontSize) > 0.01f) {
        return true;
      }
    }
    return false;
  }

  private static List<TextUnit> collectTextUnits(PDResources resources, List<Object> tokens) throws IOException {
    List<TextUnit> units = new ArrayList<>();
    PDFont currentFont = null;
    COSName currentFontName = null;
    float currentFontSize = 0f;
    int currentRenderingMode = 0;

    for (int index = 0; index < tokens.size(); index += 1) {
      Object token = tokens.get(index);
      if (!(token instanceof Operator operator)) {
        continue;
      }

      String name = operator.getName();
      if ("Tf".equals(name)) {
        currentFontName = findFontName(tokens, index);
        currentFontSize = findFontSize(tokens, index);
        currentFont = findFont(resources, tokens, index);
      } else if ("Tr".equals(name)) {
        currentRenderingMode = findRenderingMode(tokens, index, currentRenderingMode);
      } else if (("Tj".equals(name) || "'".equals(name) || "\"".equals(name))
          && index >= 1
          && tokens.get(index - 1) instanceof COSString value) {
        units.add(new TextUnit(
            value,
            currentFont,
            currentFontName,
            currentFontSize,
            currentRenderingMode,
            tokens,
            index,
            name,
            decodeString(value, currentFont)));
      } else if ("TJ".equals(name) && index >= 1 && tokens.get(index - 1) instanceof COSArray array) {
        for (int i = 0; i < array.size(); i += 1) {
          if (array.getObject(i) instanceof COSString value) {
            units.add(new TextUnit(
                value,
                currentFont,
                currentFontName,
                currentFontSize,
                currentRenderingMode,
                tokens,
                index,
                name,
                decodeString(value, currentFont)));
          }
        }
      }
    }

    return units;
  }

  private static TextRange findTextRange(String pageText, String oldText) {
    int exactStart = pageText.indexOf(oldText);
    if (exactStart >= 0) {
      return new TextRange(exactStart, exactStart + oldText.length());
    }
    return findCompactTextRange(pageText, oldText);
  }

  private static TextRange findBestTextRange(String pageText, List<TextUnit> units, TextEdit edit) {
    List<TextRange> ranges = findTextRanges(pageText, edit.oldText);
    if (ranges.isEmpty()) {
      return null;
    }
    if (edit.occurrence >= 0 && edit.occurrence < ranges.size()) {
      return ranges.get(edit.occurrence);
    }
    if (edit.fontSize <= 0 || ranges.size() == 1) {
      return ranges.get(0);
    }

    TextRange bestRange = ranges.get(0);
    double bestScore = Double.MAX_VALUE;
    for (TextRange range : ranges) {
      float fontSize = averageFontSizeForRange(units, range);
      double score = fontSizeScore(edit.fontSize, fontSize);
      if (score < bestScore) {
        bestScore = score;
        bestRange = range;
      }
    }
    return bestRange;
  }

  private static List<TextRange> findTextRanges(String pageText, String oldText) {
    List<TextRange> ranges = new ArrayList<>();
    if (!oldText.isEmpty()) {
      int start = pageText.indexOf(oldText);
      while (start >= 0) {
        ranges.add(new TextRange(start, start + oldText.length()));
        start = pageText.indexOf(oldText, start + Math.max(1, oldText.length()));
      }
    }
    if (!ranges.isEmpty()) {
      return ranges;
    }
    return findCompactTextRanges(pageText, oldText);
  }

  private static TextRange findCompactTextRange(String pageText, String oldText) {
    List<TextRange> ranges = findCompactTextRanges(pageText, oldText);
    return ranges.isEmpty() ? null : ranges.get(0);
  }

  private static List<TextRange> findCompactTextRanges(String pageText, String oldText) {
    List<TextRange> ranges = new ArrayList<>();
    CompactText compactPage = compactText(pageText);
    String compactNeedle = compactText(oldText).text;
    if (compactNeedle.isEmpty()) {
      return ranges;
    }

    int compactStart = compactPage.text.indexOf(compactNeedle);
    while (compactStart >= 0) {
      int compactEnd = compactStart + compactNeedle.length() - 1;
      ranges.add(new TextRange(
          compactPage.sourceIndexes.get(compactStart),
          compactPage.sourceIndexes.get(compactEnd) + 1));
      compactStart = compactPage.text.indexOf(compactNeedle, compactStart + Math.max(1, compactNeedle.length()));
    }
    return ranges;
  }

  private static float averageFontSizeForRange(List<TextUnit> units, TextRange range) {
    double weighted = 0;
    double weight = 0;
    for (TextUnit unit : units) {
      int overlap = Math.max(0, Math.min(unit.end, range.end) - Math.max(unit.start, range.start));
      if (overlap > 0 && unit.fontSize > 0) {
        weighted += unit.fontSize * overlap;
        weight += overlap;
      }
    }
    return weight > 0 ? (float) (weighted / weight) : 0f;
  }

  private static double fontSizeScore(double target, double actual) {
    if (target <= 0 || actual <= 0) {
      return 0;
    }
    double ratio = Math.min(target, actual) / Math.max(target, actual);
    return 1 - ratio;
  }

  private static CompactText compactText(String value) {
    StringBuilder text = new StringBuilder();
    List<Integer> sourceIndexes = new ArrayList<>();
    for (int offset = 0; offset < value.length();) {
      int codePoint = value.codePointAt(offset);
      String normalized = normalizedCodePoint(codePoint);
      if (!normalized.isEmpty()) {
        text.append(normalized);
        sourceIndexes.add(offset);
      }
      offset += Character.charCount(codePoint);
    }
    return new CompactText(text.toString(), sourceIndexes);
  }

  private static String normalizedCodePoint(int codePoint) {
    if (Character.isWhitespace(codePoint) || codePoint == 0x00AD) {
      return "";
    }
    return switch (codePoint) {
      case 0xFB00 -> "ff";
      case 0xFB01 -> "fi";
      case 0xFB02 -> "fl";
      case 0xFB03 -> "ffi";
      case 0xFB04 -> "ffl";
      default -> new String(Character.toChars(Character.toLowerCase(codePoint)));
    };
  }

  private static PDFont findFont(PDResources resources, List<Object> tokens, int operatorIndex) throws IOException {
    COSName fontName = findFontName(tokens, operatorIndex);
    if (resources == null || fontName == null) {
      return null;
    }
    return resources.getFont(fontName);
  }

  private static COSName findFontName(List<Object> tokens, int operatorIndex) {
    if (operatorIndex < 2 || !(tokens.get(operatorIndex - 2) instanceof COSName fontName)) {
      return null;
    }
    return fontName;
  }

  private static float findFontSize(List<Object> tokens, int operatorIndex) {
    if (operatorIndex < 1 || !(tokens.get(operatorIndex - 1) instanceof COSNumber number)) {
      return 0f;
    }
    return number.floatValue();
  }

  private static int findRenderingMode(List<Object> tokens, int operatorIndex, int fallback) {
    if (operatorIndex < 1 || !(tokens.get(operatorIndex - 1) instanceof COSNumber number)) {
      return fallback;
    }
    return number.intValue();
  }

  private static Map<PDFont, FontCodec> learnFontCodecs(PDResources resources, List<Object> tokens) throws IOException {
    return learnFontCodecs(resources, tokens, true);
  }

  private static Map<PDFont, FontCodec> learnFontCodecs(PDResources resources, List<Object> tokens, boolean wholeDocument) throws IOException {
    Map<PDFont, FontCodec> codecs = new IdentityHashMap<>();
    PDFont currentFont = null;

    for (int index = 0; index < tokens.size(); index += 1) {
      Object token = tokens.get(index);
      if (!(token instanceof Operator operator)) {
        continue;
      }

      String name = operator.getName();
      if ("Tf".equals(name)) {
        currentFont = findFont(resources, tokens, index);
        if (currentFont != null) {
          codecs.computeIfAbsent(currentFont, FontCodec::new);
        }
        continue;
      }

      FontCodec codec = codecs.get(currentFont);
      if (codec == null) {
        continue;
      }
      if (("Tj".equals(name) || "'".equals(name) || "\"".equals(name))
          && index >= 1
          && tokens.get(index - 1) instanceof COSString value) {
        codec.learn(value);
      } else if ("TJ".equals(name) && index >= 1 && tokens.get(index - 1) instanceof COSArray array) {
        for (int i = 0; i < array.size(); i += 1) {
          if (array.getObject(i) instanceof COSString value) {
            codec.learn(value);
          }
        }
      }
    }

    Map<COSBase, FontCodec> document = wholeDocument ? DOCUMENT_CODECS.get() : null;
    if (document != null) {
      codecs.forEach((font, codec) -> {
        FontCodec learned = document.get(font.getCOSObject());
        if (learned != null) codec.learnFrom(learned);
      });
    }
    return codecs;
  }

  private static boolean replacePreviousString(
      PDResources resources,
      List<Object> tokens,
      int operatorIndex,
      TextEdit edit,
      PDFont font,
      COSName fontName,
      float fontSize,
      FontCodec codec,
      MatchCounter counter,
      boolean canConvertToArray) {
    if (operatorIndex < 1 || !(tokens.get(operatorIndex - 1) instanceof COSString value)) {
      return false;
    }
    return replaceString(
        resources,
        tokens,
        operatorIndex,
        value,
        edit,
        font,
        fontName,
        fontSize,
        codec,
        counter,
        canConvertToArray);
  }

  private static boolean replaceDoubleQuoteString(
      PDResources resources,
      List<Object> tokens,
      int operatorIndex,
      TextEdit edit,
      PDFont font,
      COSName fontName,
      float fontSize,
      FontCodec codec,
      MatchCounter counter) {
    if (operatorIndex < 3 || !(tokens.get(operatorIndex - 1) instanceof COSString value)) {
      return false;
    }
    return replaceString(
        resources,
        tokens,
        operatorIndex,
        value,
        edit,
        font,
        fontName,
        fontSize,
        codec,
        counter,
        false);
  }

  private static boolean replacePreviousArray(
      PDResources resources,
      List<Object> tokens,
      int operatorIndex,
      TextEdit edit,
      PDFont font,
      COSName fontName,
      float fontSize,
      FontCodec codec,
      MatchCounter counter) {
    if (operatorIndex < 1 || !(tokens.get(operatorIndex - 1) instanceof COSArray array)) {
      return false;
    }

    for (int i = 0; i < array.size(); i += 1) {
      COSBase item = array.getObject(i);
      if (edit.occurrence < 0
          && item instanceof COSString value
          && replaceString(null, null, -1, value, edit, font, fontName, fontSize, codec, null, false)) {
        return true;
      }
    }

    StringBuilder joined = new StringBuilder();
    for (int i = 0; i < array.size(); i += 1) {
      COSBase item = array.getObject(i);
      if (item instanceof COSString value) {
        joined.append(decodeString(value, font));
      }
    }
    String joinedText = joined.toString();
    if (!joinedText.contains(edit.oldText)) {
      return false;
    }
    if (!counter.accept()) {
      return false;
    }

    String replacement = joinedText.replace(edit.oldText, edit.newText);
    EncodedText encoded = encodeString(replacement, font, codec);
    if (encoded == null) {
      return replaceOperatorWithMixedFonts(
          resources,
          tokens,
          operatorIndex,
          replacement,
          edit,
          font,
          fontName,
          fontSize,
          codec);
    }
    array.clear();
    if (encoded.spacedArray != null) {
      array.addAll(encoded.spacedArray);
    } else {
      array.add(new COSString(encoded.bytes));
    }
    return true;
  }

  private static boolean replaceString(
      PDResources resources,
      List<Object> tokens,
      int operatorIndex,
      COSString value,
      TextEdit edit,
      PDFont font,
      COSName fontName,
      float fontSize,
      FontCodec codec,
      MatchCounter counter,
      boolean canConvertToArray) {
    String current = decodeString(value, font);
    if (current.equals(edit.oldText)) {
      if (!fontSizeCompatible(edit, fontSize)) {
        return false;
      }
      if (counter != null && !counter.accept()) {
        return false;
      }
      EncodedText encoded = encodeString(edit.newText, font, codec);
      if (encoded == null) {
        return replaceOperatorWithMixedFonts(
            resources,
            tokens,
            operatorIndex,
            edit.newText,
            edit,
            font,
            fontName,
            fontSize,
            codec);
      }
      applyEncodedText(tokens, operatorIndex, value, encoded, canConvertToArray);
      return true;
    }
    if (current.contains(edit.oldText)) {
      if (!fontSizeCompatible(edit, fontSize)) {
        return false;
      }
      if (counter != null && !counter.accept()) {
        return false;
      }
      String replacement = current.replace(edit.oldText, edit.newText);
      EncodedText encoded = encodeString(replacement, font, codec);
      if (encoded == null) {
        return replaceOperatorWithMixedFonts(
            resources,
            tokens,
            operatorIndex,
            replacement,
            edit,
            font,
            fontName,
            fontSize,
            codec);
      }
      applyEncodedText(tokens, operatorIndex, value, encoded, canConvertToArray);
      return true;
    }
    return false;
  }

  private static boolean fontSizeCompatible(TextEdit edit, float fontSize) {
    if (edit.fontSize <= 0 || fontSize <= 0) {
      return true;
    }
    double ratio = Math.min(edit.fontSize, fontSize) / Math.max(edit.fontSize, fontSize);
    return ratio >= 0.55;
  }

  private static boolean replaceAcrossWithMixedFonts(
      PDResources resources,
      List<TextUnit> affected,
      String replacement,
      TextEdit edit,
      Map<PDFont, FontCodec> codecs) {
    TextUnit first = affected.get(0);
    if (!"Tj".equals(first.operatorName) && !"TJ".equals(first.operatorName)) {
      return false;
    }
    List<Object> mixedTokens = mixedTextTokensForUnits(resources, replacement, affected, codecs);
    if (mixedTokens.isEmpty()) {
      return false;
    }

    for (TextUnit unit : affected) {
      EncodedText empty = encodeString("", unit.font, codecs.get(unit.font));
      if (empty == null) {
        return false;
      }
      unit.value.setValue(empty.bytes);
    }
    first.tokens.addAll(first.operatorIndex - 1, mixedTokens);
    return true;
  }

  private static boolean replaceOperatorWithMixedFonts(
      PDResources resources,
      List<Object> tokens,
      int operatorIndex,
      String replacement,
      TextEdit edit,
      PDFont font,
      COSName fontName,
      float fontSize,
      FontCodec codec) {
    if (resources == null || tokens == null || operatorIndex < 1) {
      return false;
    }
    if (!(tokens.get(operatorIndex) instanceof Operator operator) || !"Tj".equals(operator.getName())) {
      return false;
    }

    List<Object> mixedTokens = mixedTextTokens(resources, replacement, font, fontName, fontSize, codec);
    if (mixedTokens.isEmpty()) {
      return false;
    }
    tokens.remove(operatorIndex);
    tokens.remove(operatorIndex - 1);
    tokens.addAll(operatorIndex - 1, mixedTokens);
    return true;
  }

  private static List<Object> mixedTextTokens(
      PDResources resources,
      String text,
      PDFont originalFont,
      COSName originalFontName,
      float originalFontSize,
      FontCodec originalCodec) {
    if (resources == null || originalFont == null || originalFontName == null || originalFontSize <= 0) {
      return List.of();
    }

    Map<PDFont, COSName> fontNames = new IdentityHashMap<>();
    fontNames.put(originalFont, originalFontName);
    List<Object> mixedTokens = new ArrayList<>();
    COSName activeFontName = null;
    boolean whole = !sameDesignFallback(originalFont) && needsWholeFallback(text, (glyph) -> encodeString(glyph, originalFont, originalCodec) != null);
    for (int offset = 0; offset < text.length();) {
      int codePoint = text.codePointAt(offset);
      offset += Character.charCount(codePoint);
      String glyph = new String(Character.toChars(codePoint));
      boolean own = encodeString(glyph, originalFont, originalCodec) != null
          && (!whole || !drawnByFallback(originalFont, glyph));
      if (!own && !whole && isSpace(glyph)) {
        mixedTokens.addAll(spaceGapTokens(1));
        continue;
      }
      PDFont runFont = own ? originalFont : glyphFallbackFont(originalFont, glyph);
      String runGlyph = own ? glyph : fallbackGlyph(glyph, runFont);
      if (runGlyph.isEmpty()) continue;
      EncodedText encoded = encodeString(runGlyph, runFont, own ? originalCodec : null);
      if (encoded == null) {
        return List.of();
      }
      if (!own) registerSubsetGlyphs(runFont, runGlyph);
      COSName runFontName = fontNames.computeIfAbsent(runFont, resources::add);
      if (!runFontName.equals(activeFontName)) {
        mixedTokens.add(runFontName);
        mixedTokens.add(new COSFloat(originalFontSize));
        mixedTokens.add(Operator.getOperator("Tf"));
        activeFontName = runFontName;
      }
      mixedTokens.add(new COSString(encoded.bytes));
      mixedTokens.add(Operator.getOperator("Tj"));
    }
    if (!originalFontName.equals(activeFontName)) {
      mixedTokens.add(originalFontName);
      mixedTokens.add(new COSFloat(originalFontSize));
      mixedTokens.add(Operator.getOperator("Tf"));
    }
    return mixedTokens;
  }

  private static List<Object> mixedTextTokensForUnits(
      PDResources resources,
      String text,
      List<TextUnit> styleUnits,
      Map<PDFont, FontCodec> codecs) {
    if (resources == null || styleUnits.isEmpty()) {
      return List.of();
    }

    Map<PDFont, COSName> fallbackFontNames = new IdentityHashMap<>();
    List<Object> mixedTokens = new ArrayList<>();
    COSName activeFontName = null;
    float activeFontSize = -1f;

    // Fonts that lack a character of this line draw all of their part of it.
    Set<PDFont> wholeFallback = Collections.newSetFromMap(new IdentityHashMap<>());
    for (int offset = 0; offset < text.length();) {
      TextUnit styleUnit = styleUnitForOffset(styleUnits, offset);
      int codePoint = text.codePointAt(offset);
      offset += Character.charCount(codePoint);
      if (styleUnit.font == null) continue;
      String glyph = new String(Character.toChars(codePoint));
      if (!isSpace(glyph) && !sameDesignFallback(styleUnit.font) && encodeString(glyph, styleUnit.font, codecs.get(styleUnit.font)) == null) {
        wholeFallback.add(styleUnit.font);
      }
    }

    for (int offset = 0; offset < text.length();) {
      TextUnit styleUnit = styleUnitForOffset(styleUnits, offset);
      if (
          styleUnit.font == null ||
          styleUnit.fontName == null ||
          styleUnit.fontSize <= 0) {
        return List.of();
      }

      int codePoint = text.codePointAt(offset);
      String glyph = new String(Character.toChars(codePoint));
      FontCodec codec = codecs.get(styleUnit.font);
      boolean missing = encodeString(glyph, styleUnit.font, codec) == null;
      if (missing && isSpace(glyph) && !wholeFallback.contains(styleUnit.font)) {
        mixedTokens.addAll(spaceGapTokens(1));
        offset += Character.charCount(codePoint);
        continue;
      }
      boolean useFallback = missing
          || wholeFallback.contains(styleUnit.font) && drawnByFallback(styleUnit.font, glyph);
      PDFont runFont = styleUnit.font;
      COSName runFontName = styleUnit.fontName;
      FontCodec runCodec = codec;
      String runGlyph = glyph;
      if (useFallback) {
        PDFont fallbackFont = glyphFallbackFont(styleUnit.font, glyph);
        runFontName = fallbackFontNames.computeIfAbsent(fallbackFont, resources::add);
        runFont = fallbackFont;
        runCodec = null;
        runGlyph = fallbackGlyph(glyph, fallbackFont);
      }
      if (runGlyph.isEmpty()) {
        offset += Character.charCount(codePoint);
        continue;
      }

      EncodedText encoded = encodeString(runGlyph, runFont, runCodec);
      if (encoded == null) {
        return List.of();
      }
      if (useFallback) registerSubsetGlyphs(runFont, runGlyph);
      if (!runFontName.equals(activeFontName) || styleUnit.fontSize != activeFontSize) {
        mixedTokens.add(runFontName);
        mixedTokens.add(new COSFloat(styleUnit.fontSize));
        mixedTokens.add(Operator.getOperator("Tf"));
        activeFontName = runFontName;
        activeFontSize = styleUnit.fontSize;
      }
      mixedTokens.add(new COSString(encoded.bytes));
      mixedTokens.add(Operator.getOperator("Tj"));
      offset += Character.charCount(codePoint);
    }

    TextUnit first = styleUnits.get(0);
    if (first.fontName != null && !first.fontName.equals(activeFontName)) {
      mixedTokens.add(first.fontName);
      mixedTokens.add(new COSFloat(Math.max(1f, first.fontSize)));
      mixedTokens.add(Operator.getOperator("Tf"));
    }
    return mixedTokens;
  }

  private static TextUnit styleUnitForOffset(List<TextUnit> units, int textOffset) {
    int cursor = 0;
    TextUnit fallback = units.get(units.size() - 1);
    for (TextUnit unit : units) {
      int end = cursor + unit.text.length();
      if (textOffset < end) {
        return unit;
      }
      cursor = end;
      fallback = unit;
    }
    return fallback;
  }

  private static PDFont standardFallbackFont(boolean bold) {
    return new PDType1Font(bold
        ? Standard14Fonts.FontName.HELVETICA_BOLD
        : Standard14Fonts.FontName.HELVETICA);
  }

  /** A bundled stand-in font (backend/fonts/fallback) in one of its four styles. */
  private record FallbackFace(String family, boolean bold, boolean italic) {
    String stem() {
      return family + "-" + (bold && italic ? "BoldItalic" : bold ? "Bold" : italic ? "Italic" : "Regular");
    }
  }

  private enum FontKind { SERIF, SANS, MONO }

  /**
   * What a PDF font looks like: its kind, weight and slant, read from its name,
   * its descriptor and its embedded file (OS/2 class and PANOSE), plus a bundled
   * family of the same design when there is one (metric-compatible stand-ins,
   * or Latin Modern for TeX's Computer Modern).
   */
  private record FontTraits(FontKind kind, boolean bold, boolean italic, String knownFamily) {}

  /** TeX font names: cmr10, cmbx12, sfrm1095, ecti1000, cmunss, lmroman10-bold, … */
  private static final java.util.regex.Pattern TEX_FONT = java.util.regex.Pattern.compile(
      "^(?:cmun([a-z]*)|cm([a-z]{1,6})\\d{1,2}|(?:sf|ec|tc)([a-z]{2,4})\\d{3,4}|lm(roman|sans|mono|math)[a-z]*\\d*[a-z]*|latinmodern(roman|sans|mono|math)[a-z]*)$");

  /**
   * TeX fonts come in cuts drawn for one size (cmr8, sfbx2074 = 20.74 pt): small
   * sizes wider and sturdier, large ones narrower. The closest bundled Latin
   * Modern Roman cut for that style, as a family suffix ("" for the 10 pt one).
   */
  private static String texOpticalSize(String name, boolean bold, boolean italic) {
    java.util.regex.Matcher digits = java.util.regex.Pattern.compile("(\\d+)").matcher(name);
    if (!digits.find()) return "";
    String number = digits.group(1);
    double size = number.length() >= 3 ? Integer.parseInt(number) / 100.0 : Integer.parseInt(number);
    int[] cuts = bold && italic ? new int[] {10} : bold || italic ? new int[] {8, 10, 12} : new int[] {8, 10, 12, 17};
    int best = 10;
    for (int cut : cuts) {
      if (Math.abs(Math.log(size / cut)) < Math.abs(Math.log(size / best)) - 1e-9) best = cut;
    }
    return best == 10 ? "" : String.valueOf(best);
  }

  /**
   * Only the font itself decides, not a line's bold flag: the editor picks the
   * stand-in per font, and the export must pick the same one.
   */
  private static FontTraits fontTraits(PDFont font) {
    PDFontDescriptor descriptor = font == null ? null : font.getFontDescriptor();
    String name = normalizeFontName(fontPostScriptName(font));
    boolean italic = fontIsItalic(font) || descriptor != null && Math.abs(descriptor.getItalicAngle()) > 1f;
    boolean bold = fontLooksBold(font, false) || descriptor != null && descriptor.getFontWeight() >= 600;

    // A line edited before carries our bundled cut; it stands in for itself.
    java.util.regex.Matcher own = java.util.regex.Pattern
        .compile("^docuflexmodern(roman|sans|mono)(\\d*)(regular|bold|italic|bolditalic)?$").matcher(name);
    if (own.matches()) {
      String style = own.group(3) == null ? "regular" : own.group(3);
      FontKind kind = own.group(1).equals("mono") ? FontKind.MONO : own.group(1).equals("sans") ? FontKind.SANS : FontKind.SERIF;
      String family = "DocuflexModern" + Character.toUpperCase(own.group(1).charAt(0)) + own.group(1).substring(1) + own.group(2);
      return new FontTraits(kind, style.contains("bold"), style.contains("italic"), family);
    }

    java.util.regex.Matcher tex = TEX_FONT.matcher(name);
    if (tex.matches()) {
      String code = "";
      for (int group = 1; group <= tex.groupCount(); group += 1) {
        if (tex.group(group) != null) code = tex.group(group);
      }
      String styled = name.substring(Math.max(0, name.indexOf(code)));
      FontKind kind = code.contains("tt") || code.equals("mono") ? FontKind.MONO
          : code.contains("ss") || code.equals("sans") ? FontKind.SANS
          : FontKind.SERIF;
      bold = bold || code.contains("bx") || code.equals("b") || code.startsWith("mib") || code.startsWith("bsy") || styled.contains("bold") || code.contains("bi");
      italic = italic || code.matches(".*(ti|it|sl|bi|mi|si).*") || styled.matches(".*(italic|oblique).*");
      String family = kind == FontKind.MONO ? "DocuflexModernMono" : kind == FontKind.SANS ? "DocuflexModernSans" : "DocuflexModernRoman";
      if (kind == FontKind.SERIF) family += texOpticalSize(name, bold, italic);
      return new FontTraits(kind, bold, italic, family);
    }

    String known = null;
    if (name.contains("calibri") || name.contains("carlito")) known = "Carlito";
    else if (name.contains("cambria") || name.contains("caladea")) known = "Caladea";
    else if (name.matches(".*(courier|cousine|liberationmono).*")) known = "LiberationMono";
    else if (name.matches(".*(times|tinos|liberationserif).*")) known = "LiberationSerif";
    else if (name.matches(".*(arial|helvetica|arimo|liberationsans).*")) known = "LiberationSans";

    // The embedded file says more than the descriptor flags, which are often unset.
    int familyClass = -1;
    org.apache.pdfbox.pdmodel.font.PDPanoseClassification panose = null;
    try {
      org.apache.fontbox.ttf.TrueTypeFont ttf = font instanceof org.apache.pdfbox.pdmodel.font.PDTrueTypeFont trueType ? trueType.getTrueTypeFont()
          : font instanceof PDType0Font type0 && type0.getDescendantFont() instanceof org.apache.pdfbox.pdmodel.font.PDCIDFontType2 cid ? cid.getTrueTypeFont()
          : null;
      org.apache.fontbox.ttf.OS2WindowsMetricsTable os2 = ttf == null ? null : ttf.getOS2Windows();
      if (os2 != null) {
        familyClass = os2.getFamilyClass() >> 8;
        if (os2.getPanose() != null && os2.getPanose().length >= 10) panose = new org.apache.pdfbox.pdmodel.font.PDPanoseClassification(os2.getPanose());
        bold = bold || os2.getWeightClass() >= 600;
      }
    } catch (IOException | RuntimeException ignored) {
      // A damaged embedded file: decide from the name and descriptor.
    }
    if (panose == null && descriptor != null && descriptor.getPanose() != null) panose = descriptor.getPanose().getPanose();

    FontKind kind;
    if (name.matches(".*(mono|consolas|menlo|monaco|lucidaconsole|andale|typewriter|code).*")
        || descriptor != null && descriptor.isFixedPitch()
        || panose != null && panose.getFamilyKind() == 2 && panose.getProportion() == 9) {
      kind = FontKind.MONO;
    } else if (name.matches(".*(sans|grotesk|grotesque|gothic|arial|helvetica|verdana|tahoma|segoe|calibri|roboto|inter|geist|frutiger|futura|avenir|univers|myriad|opensans|lato|montserrat|source(sans)?pro).*")) {
      kind = FontKind.SANS;
    } else if (name.matches(".*(serif|times|georgia|garamond|palatino|bookantiqua|baskerville|minion|charter|didot|bodoni|caslon|century|constantia|cochin|hoefler|cambria|roman|antiqua|book|mincho|song|ming).*")) {
      kind = FontKind.SERIF;
    } else if (familyClass >= 1 && familyClass <= 7) {
      kind = FontKind.SERIF;
    } else if (familyClass == 8) {
      kind = FontKind.SANS;
    } else if (panose != null && panose.getFamilyKind() == 2 && panose.getSerifStyle() >= 2 && panose.getSerifStyle() <= 10) {
      kind = FontKind.SERIF;
    } else if (panose != null && panose.getFamilyKind() == 2 && panose.getSerifStyle() >= 11 && panose.getSerifStyle() <= 13) {
      kind = FontKind.SANS;
    } else if (descriptor != null && descriptor.isSerif()) {
      kind = FontKind.SERIF;
    } else {
      kind = FontKind.SANS;
    }
    if (panose != null && panose.getFamilyKind() == 2 && panose.getWeight() >= 7) bold = true;
    if (!bold && descriptor != null && descriptor.getFontWeight() <= 0 && descriptor.getStemV() >= 120f) bold = true;
    return new FontTraits(kind, bold, italic, known);
  }

  /**
   * The bundled font that stands in for characters a PDF font lacks (usually a
   * subset) when neither the font itself nor a close match is installed. The
   * editor gets the same choice through /fonts and draws with the same files.
   */
  private static FallbackFace fallbackFace(PDFont font) {
    FontTraits traits = fontTraits(font);
    String family = traits.knownFamily() != null ? traits.knownFamily()
        : traits.kind() == FontKind.MONO ? "LiberationMono"
        : traits.kind() == FontKind.SERIF ? "LiberationSerif"
        : "LiberationSans";
    return new FallbackFace(family, traits.bold(), traits.italic());
  }

  /**
   * The font for a character the PDF's own (subset) font lacks: the same font
   * installed on this computer when it has the character, otherwise the bundled
   * stand-in. The editor resolves characters in the same order, so both match.
   */
  private static PDFont glyphFallbackFont(PDFont original, String glyph) {
    PDFont installed = installedFontFor(original);
    if (installed != null && canEncodeWithFont(glyph, installed)) return installed;
    return matchingFallbackFont(original);
  }

  /** Whether an installed font may be embedded, per font name; checked once. */
  private static final Map<String, Boolean> INSTALLED_EMBEDDABLE = new java.util.concurrent.ConcurrentHashMap<>();

  /**
   * The PDF font's own family installed on this computer (the desktop app runs
   * on the user's computer), matched by its PostScript name. Substitutes are
   * not accepted, and neither are fonts whose license forbids embedding.
   */
  private static org.apache.fontbox.ttf.TrueTypeFont installedTrueType(String postScriptName) {
    String name = cleanFontName(postScriptName == null ? "" : postScriptName).trim();
    if (name.isEmpty() || name.startsWith("DocuflexPdfFont")) return null;
    try {
      org.apache.pdfbox.pdmodel.font.FontMapping<org.apache.fontbox.ttf.TrueTypeFont> mapping =
          org.apache.pdfbox.pdmodel.font.FontMappers.instance().getTrueTypeFont(name, null);
      if (mapping == null || mapping.isFallback() || mapping.getFont() == null) return null;
      org.apache.fontbox.ttf.TrueTypeFont ttf = mapping.getFont();
      boolean embeddable = INSTALLED_EMBEDDABLE.computeIfAbsent(name, (key) -> {
        try (PDDocument probe = new PDDocument()) {
          PDType0Font.load(probe, ttf, true);
          return true;
        } catch (IOException | RuntimeException error) {
          return false;
        }
      });
      return embeddable ? ttf : null;
    } catch (RuntimeException error) {
      return null;
    }
  }

  private static String fontPostScriptName(PDFont font) {
    if (font == null) return "";
    PDFontDescriptor descriptor = font.getFontDescriptor();
    return descriptor != null && descriptor.getFontName() != null ? descriptor.getFontName() : font.getName() == null ? "" : font.getName();
  }

  /**
   * The installed font that draws what a PDF font lacks: the same font when it
   * is installed, otherwise (unless a bundled font has the very same design)
   * the closest installed one, much as a browser asks the system for the best
   * match. Null when there is none; the bundled stand-in is used then.
   */
  private static String installedFallbackName(PDFont original) {
    String name = cleanFontName(fontPostScriptName(original));
    if (installedTrueType(name) != null) return name;
    FontTraits traits = fontTraits(original);
    if (traits.knownFamily() != null) return null;
    return closestInstalledFont(traits);
  }

  private static final Map<String, java.util.Optional<String>> CLOSEST_INSTALLED = new java.util.concurrent.ConcurrentHashMap<>();
  private static final String LATIN_SAMPLE = "AZaz09&?äöüßÄÖÜéèçñ";

  /** Familiar faces first among equally good matches, like a browser's defaults. */
  private static final Map<FontKind, List<String>> PREFERRED_FAMILIES = Map.of(
      FontKind.SERIF, List.of("timesnewroman", "times", "georgia", "liberationserif", "dejavuserif", "notoserif"),
      FontKind.SANS, List.of("helvetica", "arial", "helveticaneue", "liberationsans", "dejavusans", "notosans"),
      FontKind.MONO, List.of("couriernew", "menlo", "courier", "liberationmono", "dejavusansmono", "notosansmono"));

  private static String closestInstalledFont(FontTraits traits) {
    String key = traits.kind() + "/" + traits.bold() + "/" + traits.italic();
    return CLOSEST_INSTALLED.computeIfAbsent(key, (ignored) -> java.util.Optional.ofNullable(searchInstalledFonts(traits))).orElse(null);
  }

  /** The installed face of a family by name ("Georgia", bold → Georgia-Bold), or null. */
  private static String installedFamilyFont(String family, boolean bold, boolean italic) {
    String wanted = normalizeFontName(family);
    if (wanted.isEmpty()) return null;
    List<? extends org.apache.pdfbox.pdmodel.font.FontInfo> fonts;
    try {
      org.apache.pdfbox.pdmodel.font.FontMapper mapper = org.apache.pdfbox.pdmodel.font.FontMappers.instance();
      java.lang.reflect.Method provider = mapper.getClass().getMethod("getProvider");
      provider.setAccessible(true);
      fonts = ((org.apache.pdfbox.pdmodel.font.FontProvider) provider.invoke(mapper)).getFontInfo();
    } catch (ReflectiveOperationException | RuntimeException error) {
      return null;
    }
    String best = null;
    double bestScore = Double.MAX_VALUE;
    for (org.apache.pdfbox.pdmodel.font.FontInfo info : fonts) {
      String name = info.getPostScriptName();
      if (info.getFormat() != org.apache.pdfbox.pdmodel.font.FontFormat.TTF || name == null) continue;
      String normalized = normalizeFontName(name);
      if (!normalized.startsWith(wanted)) continue;
      String rest = normalized.substring(wanted.length()).replaceFirst("^(ps|mt)", "");
      int weight = info.getWeightClass() > 0 ? info.getWeightClass() : (info.getMacStyle() & 1) != 0 ? 700 : 400;
      boolean faceItalic = (info.getMacStyle() & 2) != 0 || rest.matches(".*(italic|oblique).*");
      double score = Math.abs(weight - (bold ? 700 : 400)) / 100.0 + (faceItalic == italic ? 0 : 20)
          + (rest.matches("^(regular|bold|italic|bolditalic|mt|psmt)?(mt)?$") ? 0 : 5) + rest.length() * 0.01;
      if (score < bestScore) {
        bestScore = score;
        best = name;
      }
    }
    return best;
  }

  private static String searchInstalledFonts(FontTraits traits) {
    List<? extends org.apache.pdfbox.pdmodel.font.FontInfo> fonts;
    try {
      // PDFBox indexes every installed font; its mapper keeps that index private.
      org.apache.pdfbox.pdmodel.font.FontMapper mapper = org.apache.pdfbox.pdmodel.font.FontMappers.instance();
      java.lang.reflect.Method provider = mapper.getClass().getMethod("getProvider");
      provider.setAccessible(true);
      fonts = ((org.apache.pdfbox.pdmodel.font.FontProvider) provider.invoke(mapper)).getFontInfo();
    } catch (ReflectiveOperationException | RuntimeException error) {
      return null;
    }
    record Candidate(String name, double score) {}
    List<Candidate> candidates = new ArrayList<>();
    for (org.apache.pdfbox.pdmodel.font.FontInfo info : fonts) {
      String name = info.getPostScriptName();
      if (info.getFormat() != org.apache.pdfbox.pdmodel.font.FontFormat.TTF || name == null || name.startsWith(".")) continue;
      String normalized = normalizeFontName(name);
      if (normalized.matches(".*(emoji|symbol|dingbat|webding|wingding|lastresort|ornament|icon|braille|music|math|fallback|bitmap).*")) continue;
      int familyClass = info.getFamilyClass() > 255 ? info.getFamilyClass() >> 8 : info.getFamilyClass();
      org.apache.pdfbox.pdmodel.font.PDPanoseClassification panose = info.getPanose();
      int panoseKind = panose == null ? 0 : panose.getFamilyKind();
      if (familyClass == 9 || familyClass == 10 || familyClass == 12 || panoseKind >= 3) continue;
      if (info.getCodePageRange1() != 0 && (info.getCodePageRange1() & 1) == 0) continue;

      FontKind kind = null;
      if (normalized.matches(".*(mono|courier|menlo|consolas|monaco|typewriter|code).*") || panoseKind == 2 && panose.getProportion() == 9) kind = FontKind.MONO;
      else if (familyClass == 8 || panoseKind == 2 && panose.getSerifStyle() >= 11 && panose.getSerifStyle() <= 13 || normalized.contains("sans")) kind = FontKind.SANS;
      else if (familyClass >= 1 && familyClass <= 7 || panoseKind == 2 && panose.getSerifStyle() >= 2 && panose.getSerifStyle() <= 10 || normalized.contains("serif")) kind = FontKind.SERIF;

      int weight = info.getWeightClass() > 0 ? info.getWeightClass() : (info.getMacStyle() & 1) != 0 ? 700 : 400;
      boolean italic = (info.getMacStyle() & 2) != 0 || normalized.matches(".*(italic|oblique).*");
      if (normalized.matches(".*(condensed|narrow|compressed|extended|expanded|hairline|thin|outline|inline|shadow|stencil|display|poster).*")) continue;
      double score = kind == traits.kind() ? 0 : kind == null ? 35 : 100;
      score += Math.abs(weight - (traits.bold() ? 700 : 400)) / 100.0 * 8;
      score += italic == traits.italic() ? 0 : 40;
      List<String> preferred = PREFERRED_FAMILIES.get(traits.kind());
      for (int index = 0; index < preferred.size(); index += 1) {
        if (normalized.startsWith(preferred.get(index))) {
          score -= 6 - index * 0.5;
          break;
        }
      }
      candidates.add(new Candidate(name, score));
    }
    candidates.sort(java.util.Comparator.comparingDouble(Candidate::score).thenComparing(Candidate::name));
    for (Candidate candidate : candidates.subList(0, Math.min(25, candidates.size()))) {
      org.apache.fontbox.ttf.TrueTypeFont ttf = installedTrueType(candidate.name());
      if (ttf == null) continue;
      try {
        synchronized (ttf) {
          org.apache.fontbox.ttf.CmapLookup cmap = ttf.getUnicodeCmapLookup(false);
          if (cmap != null && LATIN_SAMPLE.codePoints().allMatch((codePoint) -> cmap.getGlyphId(codePoint) != 0)) return candidate.name();
        }
      } catch (IOException | RuntimeException ignored) {
        // Unreadable font: try the next candidate.
      }
    }
    return null;
  }

  /** The installed fallback font, loaded once into the document being edited. */
  private static PDFont installedFontFor(PDFont original) {
    PDDocument document = EDIT_DOCUMENT.get();
    String name = installedFallbackName(original);
    if (document == null || name == null || name.isEmpty()) return null;
    FontFallbacks cache = FONT_FALLBACKS.computeIfAbsent(document, ignored -> new FontFallbacks());
    synchronized (cache) {
      String key = "installed:" + name;
      if (cache.files.containsKey(key)) return cache.files.get(key);
      PDFont font = null;
      org.apache.fontbox.ttf.TrueTypeFont ttf = installedTrueType(name);
      if (ttf != null) {
        try {
          font = PDType0Font.load(document, ttf, true);
        } catch (IOException | RuntimeException ignored) {
          font = null;
        }
      }
      cache.files.put(key, font);
      return font;
    }
  }

  /**
   * A standalone TrueType copy of an installed font, for the editor to draw the
   * same characters the export embeds. Null when the font is not installed.
   */
  private static byte[] installedFontFile(String postScriptName) throws IOException {
    org.apache.fontbox.ttf.TrueTypeFont ttf = installedTrueType(postScriptName);
    if (ttf == null) return null;
    synchronized (ttf) {
      org.apache.fontbox.ttf.CmapLookup cmap = ttf.getUnicodeCmapLookup(false);
      if (cmap == null) return null;
      Set<Integer> codePoints = new java.util.TreeSet<>();
      for (int codePoint = 0x20; codePoint <= 0x2FFFF; codePoint += 1) {
        if (cmap.getGlyphId(codePoint) != 0) codePoints.add(codePoint);
      }
      // Only the tables a browser needs to draw glyphs: layout tables (GSUB,
      // GPOS, kern, hdmx, …) would still point at the old glyph numbering, which
      // browsers reject, and the export does not use them either.
      org.apache.fontbox.ttf.TTFSubsetter subsetter = new org.apache.fontbox.ttf.TTFSubsetter(ttf, List.of(
          "head", "hhea", "loca", "maxp", "cvt ", "prep", "glyf", "hmtx", "fpgm", "gasp", "name", "OS/2", "post", "cmap"));
      subsetter.addAll(codePoints);
      ByteArrayOutputStream output = new ByteArrayOutputStream();
      subsetter.writeToStream(output);
      return output.toByteArray();
    }
  }

  /** Loads the stand-in for this font into the document being edited, or plain Helvetica if it cannot be embedded. */
  private static PDFont matchingFallbackFont(PDFont original) {
    FallbackFace face = fallbackFace(original);
    PDDocument document = EDIT_DOCUMENT.get();
    PDFont font = document == null ? null : embeddedFontFile(document, "backend/fonts/fallback/" + face.stem() + ".ttf");
    return font != null ? font : standardFallbackFont(face.bold());
  }

  private static boolean fontLooksBold(PDFont font, boolean fallback) {
    if (font == null) {
      return fallback;
    }
    PDFontDescriptor descriptor = font.getFontDescriptor();
    if (descriptor != null) {
      String name = descriptor.getFontName();
      if (looksLikeBoldName(name)) {
        return true;
      }
      if (descriptor.isForceBold()) {
        return true;
      }
    }
    String fontName = font.getName();
    if (looksLikeBoldName(fontName)) {
      return true;
    }
    return fallback;
  }

  private static boolean looksLikeBoldName(String value) {
    return value != null && value.toLowerCase().matches(".*(bold|black|heavy|semibold|demibold|medium).*");
  }

  private static String fallbackGlyph(String glyph, PDFont fallbackFont) {
    if (canEncodeWithFont(glyph, fallbackFont)) {
      return glyph;
    }
    String sanitized = sanitizeWinAnsi(glyph);
    if (canEncodeWithFont(sanitized, fallbackFont)) {
      return sanitized;
    }
    return canEncodeWithFont("?", fallbackFont) ? "?" : "";
  }

  private static boolean canEncodeWithFont(String value, PDFont font) {
    try {
      font.encode(value);
      return true;
    } catch (IOException | IllegalArgumentException | UnsupportedOperationException error) {
      return false;
    }
  }

  private static void applyEncodedText(
      List<Object> tokens,
      int operatorIndex,
      COSString value,
      EncodedText encoded,
      boolean canConvertToArray) {
    if (canConvertToArray && encoded.spacedArray != null && tokens != null && operatorIndex > 0) {
      tokens.set(operatorIndex - 1, encoded.spacedArray);
      tokens.set(operatorIndex, Operator.getOperator("TJ"));
      return;
    }
    value.setValue(encoded.bytes);
  }

  private static String decodeString(COSString value, PDFont font) {
    if (font == null) {
      return value.getString();
    }
    StringBuilder decoded = new StringBuilder();
    try (ByteArrayInputStream input = new ByteArrayInputStream(value.getBytes())) {
      while (input.available() > 0) {
        int code = font.readCode(input);
        String unicode = decodeCode(font, code);
        decoded.append(unicode != null ? unicode : "");
      }
      return decoded.toString();
    } catch (IOException error) {
      return value.getString();
    }
  }

  private static EncodedText encodeString(String value, PDFont font, FontCodec codec) {
    if (codec != null) {
      return codec.encode(value);
    }
    try {
      byte[] bytes = font != null ? font.encode(value) : new COSString(value).getBytes();
      return new EncodedText(bytes, null);
    } catch (IOException | IllegalArgumentException | UnsupportedOperationException error) {
      return null;
    }
  }

  private record EncodedText(byte[] bytes, COSArray spacedArray) {}

  private static class FontCodec {
    private final PDFont font;
    private final Map<String, byte[]> unicodeToBytes = new LinkedHashMap<>();
    private final Map<String, Float> unicodeToWidth = new LinkedHashMap<>();

    FontCodec(PDFont font) {
      this.font = font;
    }

    void learn(COSString value) {
      byte[] bytes = value.getBytes();
      try (ByteArrayInputStream input = new ByteArrayInputStream(bytes)) {
        while (input.available() > 0) {
          int start = bytes.length - input.available();
          int code = font.readCode(input);
          int end = bytes.length - input.available();
          String unicode = decodeCode(font, code);
          if (unicode != null && !unicode.isEmpty()) {
            unicodeToBytes.putIfAbsent(unicode, Arrays.copyOfRange(bytes, start, end));
            unicodeToWidth.putIfAbsent(unicode, widthOf(code));
          }
        }
      } catch (IOException ignored) {
        // Some PDFs contain malformed text chunks; those chunks simply cannot teach us encodings.
      }
    }

    void learnFrom(FontCodec other) {
      other.unicodeToBytes.forEach(unicodeToBytes::putIfAbsent);
      other.unicodeToWidth.forEach(unicodeToWidth::putIfAbsent);
    }

    /** The single characters this font draws. */
    String characters() {
      StringBuilder characters = new StringBuilder();
      unicodeToBytes.keySet().stream()
          .filter((unicode) -> unicode.codePointCount(0, unicode.length()) == 1)
          .sorted()
          .forEach(characters::append);
      return characters.toString();
    }

    EncodedText encode(String value) {
      ByteArrayOutputStream output = new ByteArrayOutputStream();
      COSArray spacedArray = new COSArray();
      boolean needsExplicitSpacing = false;
      for (int offset = 0; offset < value.length();) {
        int codePoint = value.codePointAt(offset);
        String unicode = new String(Character.toChars(codePoint));
        byte[] bytes = unicodeToBytes.get(unicode);
        if (bytes == null) {
          return null;
        }
        output.writeBytes(bytes);
        offset += Character.charCount(codePoint);
      }
      return new EncodedText(output.toByteArray(), null);
    }

    COSArray spacedArray(String value) {
      EncodedText encoded = encode(value);
      return encoded != null ? encoded.spacedArray : null;
    }

    private float widthOf(int code) {
      try {
        return font.getWidth(code);
      } catch (IOException | IllegalArgumentException error) {
        return 0;
      }
    }

    private boolean isSuspiciousWidth(String unicode) {
      return glyphWidth(unicode) < 100f;
    }

    private byte[] encodeSingleGlyph(String unicode) {
      try {
        return font.encode(unicode);
      } catch (IOException | IllegalArgumentException | UnsupportedOperationException error) {
        return null;
      }
    }

    private float glyphWidth(String unicode) {
      Float learnedWidth = unicodeToWidth.get(unicode);
      if (learnedWidth != null) {
        return learnedWidth;
      }
      try {
        return font.getStringWidth(unicode);
      } catch (IOException | IllegalArgumentException error) {
        return 0;
      }
    }

    private float spacingAdvance(boolean learnedGlyph) {
      float average = font.getAverageFontWidth();
      if (!learnedGlyph) {
        return Math.max(760f, average > 100f ? Math.min(900f, average * 1.35f) : 820f);
      }
      if (average > 100f) {
        return Math.min(750f, Math.max(350f, average));
      }
      return 520f;
    }
  }

  private static String decodeCode(PDFont font, int code) {
    String unicode = font.toUnicode(code);
    if (unicode != null) {
      return unicode;
    }

    if (font instanceof PDSimpleFont simpleFont) {
      Encoding encoding = simpleFont.getEncoding();
      if (encoding != null) {
        String glyphName = encoding.getName(code);
        if (glyphName != null && !glyphName.isBlank() && !".notdef".equals(glyphName)) {
          String fromFontGlyphList = simpleFont.getGlyphList() != null
              ? simpleFont.getGlyphList().toUnicode(glyphName)
              : null;
          if (fromFontGlyphList != null) {
            return fromFontGlyphList;
          }
          String fromAdobeGlyphList = GlyphList.getAdobeGlyphList().toUnicode(glyphName);
          if (fromAdobeGlyphList != null) {
            return fromAdobeGlyphList;
          }
          if (glyphName.length() == 1) {
            return glyphName;
          }
        }
      }
    }

    if (code >= 32 && code <= 126) {
      return Character.toString((char) code);
    }
    return null;
  }

  private static List<TextEdit> parseEdits(List<Object> rawEdits) {
    List<TextEdit> edits = new ArrayList<>();
    for (Object raw : rawEdits) {
      Map<String, Object> edit = asObject(raw);
      if ("image".equals(optionalString(edit.get("kind")))) continue;
      edits.add(new TextEdit(
          asInt(edit.get("page")),
          asString(edit.get("oldText")),
          asString(edit.get("newText")),
          parseStringList(edit.get("oldTextCandidates")),
          optionalInt(edit.get("occurrence"), -1),
          parseDoubleList(edit.get("rect")),
          parseDoubleList(edit.get("alignRect")),
          parseDoubleList(edit.get("visualRect")),
          parseDoubleList(edit.get("originalRect")),
          parseDoubleList(edit.get("pageSize")),
          parseDoubleList(edit.get("color")),
          optionalString(edit.get("fontName")),
          optionalDouble(edit.get("fontSize")),
          optionalBoolean(edit.get("bold")),
          optionalBoolean(edit.get("moved")),
          optionalBoolean(edit.get("overlay")),
          optionalString(edit.get("alignment")),
          optionalBoolean(edit.get("fontChanged")),
          optionalBoolean(edit.get("boldChanged")),
          optionalBoolean(edit.get("italic")),
          optionalBoolean(edit.get("italicChanged")),
          optionalBoolean(edit.get("underline")),
          optionalBoolean(edit.get("strikethrough")),
          optionalDouble(edit.get("letterSpacing")),
          optionalDouble(edit.get("baseline"), -1)));
    }
    return edits;
  }

  private static List<ImageEdit> parseImageEdits(List<Object> rawEdits) {
    List<ImageEdit> edits = new ArrayList<>();
    for (Object raw : rawEdits) {
      Map<String, Object> edit = asObject(raw);
      if (!"image".equals(optionalString(edit.get("kind")))) continue;
      edits.add(new ImageEdit(
          asInt(edit.get("page")),
          optionalInt(edit.get("occurrence"), -1),
          optionalBoolean(edit.get("group")),
          parseDoubleList(edit.get("rect")),
          parseDoubleList(edit.get("originalRect"))));
    }
    return edits;
  }

  private static List<AnnotationStroke> parseAnnotations(List<Object> rawAnnotations) {
    if (rawAnnotations.size() > 10_000) {
      throw new IllegalArgumentException("Too many annotation strokes.");
    }
    List<AnnotationStroke> annotations = new ArrayList<>();
    int pointCount = 0;
    for (Object raw : rawAnnotations) {
      Map<String, Object> annotation = asObject(raw);
      String type = asString(annotation.get("type"));
      boolean isStroke = "marker".equals(type) || "pen".equals(type);
      boolean isShape = "triangle".equals(type) || "rectangle".equals(type) || "circle".equals(type) ||
          "check".equals(type) || "cross".equals(type) || "arrow".equals(type) || "line".equals(type) ||
          "crop".equals(type) || "watermark".equals(type) ||
          "textfield".equals(type) || "signature".equals(type) || "image".equals(type) || "checkbox".equals(type) || "input".equals(type) ||
          "highlight".equals(type) || "underline".equals(type) ||
          "crossout".equals(type) || "blackout".equals(type) || "whiteout".equals(type);
      if (!isStroke && !isShape) {
        throw new IllegalArgumentException("Unsupported annotation type: " + type);
      }
      if (isShape) {
        double x = optionalDouble(annotation.get("x"));
        double y = optionalDouble(annotation.get("y"));
        double width = optionalDouble(annotation.get("width"));
        double height = optionalDouble(annotation.get("height"));
        double rotation = optionalDouble(annotation.get("rotation"));
        double radiusX = optionalDouble(annotation.get("radiusX"));
        double radiusY = optionalDouble(annotation.get("radiusY"));
        List<Double> color = parseDoubleList(annotation.get("color"));
        if (!Double.isFinite(x) || !Double.isFinite(y) || !Double.isFinite(width) ||
            !Double.isFinite(height) || !Double.isFinite(rotation) ||
            !Double.isFinite(radiusX) || !Double.isFinite(radiusY)) {
          throw new IllegalArgumentException("Shape coordinates must be finite numbers.");
        }
        if (width <= 0 || height <= 0 || width > 2 || height > 2) {
          throw new IllegalArgumentException("Invalid shape size.");
        }
        String imageData = optionalString(annotation.get("imageData"));
        String text = optionalString(annotation.get("text"));
        Map<String, Object> textStyle = annotation.get("textStyle") instanceof Map<?, ?>
            ? asObject(annotation.get("textStyle"))
            : Map.of();
        List<Map<String, Object>> textStyleRanges = new ArrayList<>();
        if (annotation.get("textStyleRanges") instanceof List<?>) {
          for (Object rawRange : asArray(annotation.get("textStyleRanges"))) {
            if (rawRange instanceof Map<?, ?>) textStyleRanges.add(asObject(rawRange));
          }
        }
        if ("watermark".equals(type) && text.codePointCount(0, text.length()) > 80) {
          throw new IllegalArgumentException("Watermark text is too long.");
        }
        if (imageData.length() > 16 * 1024 * 1024) {
          throw new IllegalArgumentException("Placed image data is too large.");
        }
        annotations.add(new AnnotationStroke(
            asInt(annotation.get("page")), type, List.of(),
            x, y, width, height, rotation, Math.max(0, radiusX), Math.max(0, radiusY),
            color, text, imageData,
            optionalString(annotation.get("fieldName")), optionalString(annotation.get("fieldValue")),
            optionalBoolean(annotation.get("fieldValue")), optionalBoolean(annotation.get("existingField")),
            textStyle, textStyleRanges));
        continue;
      }
      List<NormalizedPoint> points = new ArrayList<>();
      for (Object rawPoint : asArray(annotation.get("points"))) {
        Map<String, Object> point = asObject(rawPoint);
        double x = asDouble(point.get("x"));
        double y = asDouble(point.get("y"));
        if (!Double.isFinite(x) || !Double.isFinite(y)) {
          throw new IllegalArgumentException("Annotation coordinates must be finite numbers.");
        }
        points.add(new NormalizedPoint(x, y));
        pointCount += 1;
        if (pointCount > 2_000_000) {
          throw new IllegalArgumentException("Too many annotation points.");
        }
      }
      annotations.add(new AnnotationStroke(
          asInt(annotation.get("page")), type, points, 0, 0, 0, 0, 0, 0, 0, parseDoubleList(annotation.get("color")), "", "", "", "", false, false,
          Map.of(), List.of()));
    }
    return annotations;
  }

  private static List<String> parseStringList(Object value) {
    if (value == null) {
      return List.of();
    }
    List<String> strings = new ArrayList<>();
    for (Object item : asArray(value)) {
      if (item instanceof String string && !string.isBlank()) {
        strings.add(string);
      }
    }
    return strings;
  }

  private static List<Double> parseDoubleList(Object value) {
    if (value == null) {
      return List.of();
    }
    List<Double> numbers = new ArrayList<>();
    for (Object item : asArray(value)) {
      if (item instanceof Number number) {
        numbers.add(number.doubleValue());
      }
    }
    return numbers;
  }

  private static float annotationColorComponent(List<Double> color, int index) {
    if (color == null || color.size() <= index || !Double.isFinite(color.get(index))) return 0f;
    return (float) Math.max(0, Math.min(1, color.get(index)));
  }

  private static double optionalDouble(Object value) {
    return value instanceof Number number ? number.doubleValue() : 0;
  }

  private static double optionalDouble(Object value, double fallback) {
    return value instanceof Number number ? number.doubleValue() : fallback;
  }

  private static boolean optionalBoolean(Object value) {
    return value instanceof Boolean bool && bool;
  }

  private static byte[] decodePdf(String encoded) {
    if (encoded == null || encoded.isEmpty() || encoded.length() > ((MAX_PDF_BYTES + 2L) / 3L) * 4L + 4L) {
      throw new IllegalArgumentException("The PDF payload is empty or too large.");
    }
    byte[] bytes;
    try {
      bytes = Base64.getDecoder().decode(encoded);
    } catch (IllegalArgumentException error) {
      throw new IllegalArgumentException("The PDF payload is not valid base64 data.");
    }
    if (bytes.length == 0 || bytes.length > MAX_PDF_BYTES || !hasPdfHeader(bytes)) {
      throw new IllegalArgumentException("The PDF payload is not a valid PDF.");
    }
    return bytes;
  }

  private static boolean hasPdfHeader(byte[] bytes) {
    int limit = Math.min(bytes.length - 4, 1024);
    for (int index = 0; index < limit; index += 1) {
      if (bytes[index] == '%' && bytes[index + 1] == 'P' && bytes[index + 2] == 'D'
          && bytes[index + 3] == 'F' && bytes[index + 4] == '-') return true;
    }
    return false;
  }

  private static PDDocument loadPdf(byte[] bytes) throws IOException {
    return validateLoadedPdf(Loader.loadPDF(bytes));
  }

  private static PDDocument loadPdf(byte[] bytes, String password) throws IOException {
    return validateLoadedPdf(Loader.loadPDF(bytes, password));
  }

  private static PDDocument validateLoadedPdf(PDDocument document) throws IOException {
    try {
      int pages = document.getNumberOfPages();
      if (pages <= 0 || pages > MAX_PDF_PAGES) {
        throw new IOException("The PDF page count is outside the supported range.");
      }
      for (PDPage page : document.getPages()) {
        PDRectangle box = page.getMediaBox();
        if (box == null || !Float.isFinite(box.getWidth()) || !Float.isFinite(box.getHeight())
            || box.getWidth() <= 0 || box.getHeight() <= 0
            || box.getWidth() > 50_000 || box.getHeight() > 50_000) {
          throw new IOException("The PDF contains an invalid page size.");
        }
      }
      return document;
    } catch (Exception error) {
      document.close();
      if (error instanceof IOException ioError) throw ioError;
      throw new IOException("The PDF structure is invalid.", error);
    }
  }

  private static String optionalString(Object value) {
    return value instanceof String string ? string : "";
  }

  private static void addCors(HttpExchange exchange) {
    String origin = exchange.getRequestHeaders().getFirst("Origin");
    if (origin != null && (
        origin.matches("http://localhost:51[0-9]{2}") ||
        origin.matches("http://127\\.0\\.0\\.1:51[0-9]{2}"))) {
      exchange.getResponseHeaders().set("Access-Control-Allow-Origin", origin);
    } else {
      exchange.getResponseHeaders().set("Access-Control-Allow-Origin", "http://127.0.0.1:5173");
    }
    exchange.getResponseHeaders().add("Vary", "Origin");
    exchange.getResponseHeaders().add("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    exchange.getResponseHeaders().add("Access-Control-Allow-Headers", "Content-Type");
    exchange.getResponseHeaders().add("Access-Control-Expose-Headers", "Content-Disposition");
  }

  private static String readRequestBody(HttpExchange exchange) throws IOException {
    byte[] bytes = exchange.getRequestBody().readNBytes(MAX_REQUEST_BYTES + 1);
    if (bytes.length > MAX_REQUEST_BYTES) {
      throw new IllegalArgumentException("Request is too large.");
    }
    return new String(bytes, StandardCharsets.UTF_8);
  }

  private static void sendJson(HttpExchange exchange, int status, String body) throws IOException {
    exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
    exchange.getResponseHeaders().set("Cache-Control", "no-store");
    exchange.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
    send(exchange, status, body);
  }

  private static void sendFailure(HttpExchange exchange, Exception error, String publicMessage) throws IOException {
    String reference = UUID.randomUUID().toString();
    System.err.println("[PDF request " + reference + "] " + error.getClass().getSimpleName() + ": " + error.getMessage());
    error.printStackTrace(System.err);
    // The top-level exception message (not the stack trace) is safe to surface to
    // the client: it's what lets the desktop app show what actually went wrong
    // (e.g. "Could not find font: /Helvetica") instead of only a generic
    // placeholder, without leaking internal file paths or class internals.
    String detail = error.getMessage();
    String combinedMessage = detail == null || detail.isBlank() ? publicMessage : publicMessage + " (" + detail + ")";
    sendJson(exchange, 400, "{\"error\":\"" + escapeJson(combinedMessage)
        + "\",\"reference\":\"" + reference + "\"}");
  }

  private static void sendPdf(HttpExchange exchange, byte[] bytes) throws IOException {
    if (bytes.length == 0 || bytes.length > MAX_RESPONSE_BYTES) {
      throw new IOException("Generated PDF exceeded the safe response limit.");
    }
    exchange.getResponseHeaders().set("Content-Type", "application/pdf");
    exchange.getResponseHeaders().set("Content-Disposition", "attachment; filename=docuflex-export.pdf");
    exchange.getResponseHeaders().set("Cache-Control", "no-store");
    exchange.sendResponseHeaders(200, bytes.length);
    try (OutputStream response = exchange.getResponseBody()) {
      response.write(bytes);
    }
  }

  private static void send(HttpExchange exchange, int status, String body) throws IOException {
    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
    if (bytes.length > MAX_RESPONSE_BYTES) {
      throw new IOException("Generated response exceeded the safe response limit.");
    }
    exchange.sendResponseHeaders(status, bytes.length);
    try (OutputStream response = exchange.getResponseBody()) {
      response.write(bytes);
    }
  }

  private static void sendNoContent(HttpExchange exchange) throws IOException {
    exchange.sendResponseHeaders(204, -1);
    exchange.close();
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> asObject(Object value) {
    if (value instanceof Map<?, ?> map) {
      return (Map<String, Object>) map;
    }
    throw new IllegalArgumentException("Expected JSON object.");
  }

  @SuppressWarnings("unchecked")
  private static List<Object> asArray(Object value) {
    if (value instanceof List<?> list) {
      return (List<Object>) list;
    }
    throw new IllegalArgumentException("Expected JSON array.");
  }

  private static String asString(Object value) {
    if (value instanceof String string) {
      return string;
    }
    throw new IllegalArgumentException("Expected JSON string.");
  }

  private static int asInt(Object value) {
    if (value instanceof Number number) {
      return number.intValue();
    }
    throw new IllegalArgumentException("Expected JSON number.");
  }

  private static double asDouble(Object value) {
    if (value instanceof Number number) {
      return number.doubleValue();
    }
    throw new IllegalArgumentException("Expected JSON number.");
  }

  private static double clamp(double value, double minimum, double maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  private static int environmentInt(String name, int fallback) {
    String value = System.getenv(name);
    if (value == null || value.isBlank()) {
      return fallback;
    }
    try {
      return Integer.parseInt(value);
    } catch (NumberFormatException error) {
      throw new IllegalArgumentException(name + " must be an integer.", error);
    }
  }

  private static String environmentString(String name, String fallback) {
    String value = System.getenv(name);
    return value == null || value.isBlank() ? fallback : value;
  }

  private static int optionalInt(Object value, int fallback) {
    return value instanceof Number number ? number.intValue() : fallback;
  }

  private static String escapeJson(String value) {
    StringBuilder escaped = new StringBuilder();
    for (int i = 0; i < value.length(); i += 1) {
      char ch = value.charAt(i);
      switch (ch) {
        case '\\' -> escaped.append("\\\\");
        case '"' -> escaped.append("\\\"");
        case '\n' -> escaped.append("\\n");
        case '\r' -> escaped.append("\\r");
        case '\t' -> escaped.append("\\t");
        default -> {
          // JSON forbids raw control characters; PDF text often contains them.
          if (ch < 0x20 || ch == '\u2028' || ch == '\u2029') {
            escaped.append(String.format("\\u%04x", (int) ch));
          } else {
            escaped.append(ch);
          }
        }
      }
    }
    return escaped.toString();
  }

  private record TextEdit(
      int page,
      String oldText,
      String newText,
      List<String> oldTextCandidates,
      int occurrence,
      List<Double> rect,
      List<Double> alignRect,
      List<Double> visualRect,
      List<Double> originalRect,
      List<Double> pageSize,
      List<Double> color,
      String fontName,
      double fontSize,
      boolean bold,
      boolean moved,
      boolean overlay,
      String alignment,
      boolean fontChanged,
      boolean boldChanged,
      boolean italic,
      boolean italicChanged,
      boolean underline,
      boolean strikethrough,
      double letterSpacing,
      double baseline) {}

  private record ImageEdit(
      int page,
      int occurrence,
      boolean group,
      List<Double> rect,
      List<Double> originalRect) {}

  private record ImageMatrixCandidate(
      int operatorIndex,
      List<Object> tokens,
      PDFormXObject form,
      Matrix parentMatrix,
      double[] globalMatrix,
      double[] bounds) {}

  private record AnnotationStroke(
      int page,
      String type,
      List<NormalizedPoint> points,
      double x,
      double y,
      double width,
      double height,
      double rotation,
      double radiusX,
      double radiusY,
      List<Double> color,
      String text,
      String imageData,
      String fieldName,
      String fieldValue,
      boolean fieldChecked,
      boolean existingField,
      Map<String, Object> textStyle,
      List<Map<String, Object>> textStyleRanges) {}

  private record NormalizedPoint(double x, double y) {}

  private record PdfPoint(float x, float y) {}

  private record PdfTextStyle(
      PDFont font,
      float fontSize,
      float letterSpacing,
      float[] color,
      boolean underline,
      boolean strikethrough) {}

  private record PdfTextSegment(String text, PdfTextStyle style) {}

  private record EmbeddedFont(String pdfJsName, String family, String baseName, String css, String fallback, String installed, boolean sameDesign, COSBase cos, String characters) {
    EmbeddedFont withCharacters(String value) {
      return new EmbeddedFont(pdfJsName, family, baseName, css, fallback, installed, sameDesign, cos, value);
    }
  }

  private record TextRange(int start, int end) {}

  private record TextBlockRange(int start, int end) {}

  private record TextBlockMove(TextBlockRange range, COSName fontName, float fontSize, int renderingMode) {}

  private record CompactText(String text, List<Integer> sourceIndexes) {}

  private record OverlayStyle(PDFont font, float fontSize) {
    static OverlayStyle empty() {
      return new OverlayStyle(null, 0f);
    }
  }

  private record UnitReplacement(TextUnit unit, EncodedText encoded) {}


  private static class MatchCounter {
    private final int target;
    private int seen = 0;

    MatchCounter(int target) {
      this.target = target;
    }

    boolean accept() {
      if (target < 0) {
        return true;
      }
      boolean accepted = seen == target;
      seen += 1;
      return accepted;
    }
  }

  private static class TextUnit {
    private final COSString value;
    private final PDFont font;
    private final COSName fontName;
    private final float fontSize;
    private final int renderingMode;
    private final List<Object> tokens;
    private final int operatorIndex;
    private final String operatorName;
    private final String text;
    private int start;
    private int end;

    TextUnit(
        COSString value,
        PDFont font,
        COSName fontName,
        float fontSize,
        int renderingMode,
        List<Object> tokens,
        int operatorIndex,
        String operatorName,
        String text) {
      this.value = value;
      this.font = font;
      this.fontName = fontName;
      this.fontSize = fontSize;
      this.renderingMode = renderingMode;
      this.tokens = tokens;
      this.operatorIndex = operatorIndex;
      this.operatorName = operatorName;
      this.text = text;
    }
  }

  private static class EditResult {
    byte[] pdfBytes = new byte[0];
    int applied = 0;
    List<String> misses = new ArrayList<>();
    List<Integer> missedEditIndices = new ArrayList<>();

    String missesJson() {
      StringBuilder json = new StringBuilder("[");
      for (int i = 0; i < misses.size(); i += 1) {
        if (i > 0) {
          json.append(",");
        }
        json.append("\"").append(escapeJson(misses.get(i))).append("\"");
      }
      json.append("]");
      return json.toString();
    }

    String missedEditIndicesJson() {
      StringBuilder json = new StringBuilder("[");
      for (int i = 0; i < missedEditIndices.size(); i += 1) {
        if (i > 0) {
          json.append(",");
        }
        json.append(missedEditIndices.get(i));
      }
      json.append("]");
      return json.toString();
    }
  }

  private static class FontExtractResult {
    List<EmbeddedFont> fonts = new ArrayList<>();

    String toJson() {
      StringBuilder css = new StringBuilder();
      StringBuilder fontsJson = new StringBuilder("[");
      for (int i = 0; i < fonts.size(); i += 1) {
        EmbeddedFont font = fonts.get(i);
        css.append(font.css);
        if (i > 0) {
          fontsJson.append(",");
        }
        fontsJson.append("{")
            .append("\"pdfJsName\":\"").append(escapeJson(font.pdfJsName)).append("\",")
            .append("\"family\":\"").append(escapeJson(font.family)).append("\",")
            .append("\"baseName\":\"").append(escapeJson(font.baseName)).append("\",")
            .append("\"fallback\":\"").append(escapeJson(font.fallback)).append("\",")
            .append("\"characters\":\"").append(escapeJson(font.characters)).append("\",")
            .append("\"sameDesign\":").append(font.sameDesign).append(",")
            .append("\"installed\":").append(font.installed == null ? "null" : "\"" + escapeJson(font.installed) + "\"")
            .append("}");
      }
      fontsJson.append("]");
      return "{"
          + "\"css\":\"" + escapeJson(css.toString()) + "\","
          + "\"fonts\":" + fontsJson
          + "}";
    }
  }

  private static class JsonParser {
    private final String source;
    private int index = 0;

    JsonParser(String source) {
      this.source = source;
    }

    Object parse() {
      Object value = parseValue(0);
      skipWhitespace();
      if (index != source.length()) {
        throw new IllegalArgumentException("Unexpected JSON after position " + index);
      }
      return value;
    }

    private Object parseValue(int depth) {
      if (depth > MAX_JSON_DEPTH) {
        throw new IllegalArgumentException("JSON nesting is too deep.");
      }
      skipWhitespace();
      if (index >= source.length()) {
        throw new IllegalArgumentException("Unexpected end of JSON.");
      }
      char ch = source.charAt(index);
      if (ch == '{') {
        return parseObject(depth + 1);
      }
      if (ch == '[') {
        return parseArray(depth + 1);
      }
      if (ch == '"') {
        return parseString();
      }
      if (ch == '-' || Character.isDigit(ch)) {
        return parseNumber();
      }
      if (source.startsWith("true", index)) {
        index += 4;
        return Boolean.TRUE;
      }
      if (source.startsWith("false", index)) {
        index += 5;
        return Boolean.FALSE;
      }
      if (source.startsWith("null", index)) {
        index += 4;
        return null;
      }
      throw new IllegalArgumentException("Unexpected JSON token at position " + index);
    }

    private Map<String, Object> parseObject(int depth) {
      expect('{');
      Map<String, Object> object = new LinkedHashMap<>();
      skipWhitespace();
      if (peek('}')) {
        index += 1;
        return object;
      }
      while (true) {
        String key = parseString();
        skipWhitespace();
        expect(':');
        object.put(key, parseValue(depth));
        skipWhitespace();
        if (peek('}')) {
          index += 1;
          return object;
        }
        expect(',');
      }
    }

    private List<Object> parseArray(int depth) {
      expect('[');
      List<Object> array = new ArrayList<>();
      skipWhitespace();
      if (peek(']')) {
        index += 1;
        return array;
      }
      while (true) {
        array.add(parseValue(depth));
        skipWhitespace();
        if (peek(']')) {
          index += 1;
          return array;
        }
        expect(',');
      }
    }

    private String parseString() {
      expect('"');
      StringBuilder value = new StringBuilder();
      while (index < source.length()) {
        char ch = source.charAt(index++);
        if (ch == '"') {
          return value.toString();
        }
        if (ch != '\\') {
          value.append(ch);
          continue;
        }
        if (index >= source.length()) {
          throw new IllegalArgumentException("Bad JSON escape.");
        }
        char escaped = source.charAt(index++);
        switch (escaped) {
          case '"' -> value.append('"');
          case '\\' -> value.append('\\');
          case '/' -> value.append('/');
          case 'b' -> value.append('\b');
          case 'f' -> value.append('\f');
          case 'n' -> value.append('\n');
          case 'r' -> value.append('\r');
          case 't' -> value.append('\t');
          case 'u' -> {
            if (index + 4 > source.length()) {
              throw new IllegalArgumentException("Bad unicode escape.");
            }
            value.append((char) Integer.parseInt(source.substring(index, index + 4), 16));
            index += 4;
          }
          default -> throw new IllegalArgumentException("Unsupported JSON escape: " + escaped);
        }
      }
      throw new IllegalArgumentException("Unterminated JSON string.");
    }

    private Number parseNumber() {
      int start = index;
      if (peek('-')) {
        index += 1;
      }
      while (index < source.length() && Character.isDigit(source.charAt(index))) {
        index += 1;
      }
      if (peek('.')) {
        index += 1;
        while (index < source.length() && Character.isDigit(source.charAt(index))) {
          index += 1;
        }
        return Double.parseDouble(source.substring(start, index));
      }
      return Integer.parseInt(source.substring(start, index));
    }

    private void skipWhitespace() {
      while (index < source.length() && Character.isWhitespace(source.charAt(index))) {
        index += 1;
      }
    }

    private boolean peek(char expected) {
      return index < source.length() && source.charAt(index) == expected;
    }

    // this comment is here to redeploy

    private void expect(char expected) {
      skipWhitespace();
      if (!peek(expected)) {
        throw new IllegalArgumentException("Expected '" + expected + "' at position " + index);
      }
      index += 1;
    }
  }
}
