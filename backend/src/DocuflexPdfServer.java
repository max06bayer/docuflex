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
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.apache.pdfbox.contentstream.operator.Operator;
import org.apache.pdfbox.cos.COSArray;
import org.apache.pdfbox.cos.COSBase;
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
import org.apache.pdfbox.pdmodel.graphics.image.LosslessFactory;
import org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject;
import org.apache.pdfbox.pdmodel.graphics.form.PDFormXObject;
import org.apache.pdfbox.pdmodel.graphics.blend.BlendMode;
import org.apache.pdfbox.pdmodel.graphics.state.PDExtendedGraphicsState;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAppearanceCharacteristicsDictionary;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAppearanceDictionary;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAppearanceEntry;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAppearanceStream;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAnnotationWidget;
import org.apache.pdfbox.pdmodel.interactive.form.PDAcroForm;
import org.apache.pdfbox.pdmodel.interactive.form.PDCheckBox;
import org.apache.pdfbox.pdmodel.interactive.form.PDField;
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
  private static final int MAX_REQUEST_BYTES = 150 * 1024 * 1024;
  private static final float EDITOR_PAGE_SCALE = 1.42f;

  public static void main(String[] args) throws IOException {
    HttpServer server = HttpServer.create(new InetSocketAddress(HOST, PORT), 0);
    server.createContext("/health", DocuflexPdfServer::handleHealth);
    server.createContext("/edit", DocuflexPdfServer::handleEdit);
    server.createContext("/fonts", DocuflexPdfServer::handleFonts);
    server.createContext("/decrypt", DocuflexPdfServer::handleDecrypt);
    server.createContext("/uncrop", DocuflexPdfServer::handleUncrop);
    server.createContext("/pages", DocuflexPdfServer::handlePages);
    server.createContext("/export", DocuflexPdfServer::handleExport);
    server.start();
    System.out.println("Docuflex PDFBox server listening on http://" + HOST + ":" + PORT);
  }

  private static void handleHealth(HttpExchange exchange) throws IOException {
    addCors(exchange);
    if ("OPTIONS".equals(exchange.getRequestMethod())) {
      sendNoContent(exchange);
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
      String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
      Map<String, Object> payload = asObject(new JsonParser(body).parse());
      String pdfBase64 = asString(payload.get("pdfBase64"));
      List<TextEdit> edits = parseEdits(asArray(payload.get("edits")));

      EditResult result = applyEdits(Base64.getDecoder().decode(pdfBase64), edits);
      String response = "{"
          + "\"pdfBase64\":\"" + escapeJson(Base64.getEncoder().encodeToString(result.pdfBytes)) + "\","
          + "\"applied\":" + result.applied + ","
          + "\"misses\":" + result.missesJson()
          + "}";
      sendJson(exchange, 200, response);
    } catch (Exception error) {
      error.printStackTrace();
      sendJson(exchange, 400, "{\"error\":\"" + escapeJson(error.getMessage()) + "\"}");
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
      String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
      Map<String, Object> payload = asObject(new JsonParser(body).parse());
      String pdfBase64 = asString(payload.get("pdfBase64"));
      FontExtractResult result = extractFonts(Base64.getDecoder().decode(pdfBase64));
      sendJson(exchange, 200, result.toJson());
    } catch (Exception error) {
      error.printStackTrace();
      sendJson(exchange, 400, "{\"error\":\"" + escapeJson(error.getMessage()) + "\"}");
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
      byte[] pdfBytes = Base64.getDecoder().decode(asString(payload.get("pdfBase64")));
      List<AnnotationStroke> annotations = parseAnnotations(asArray(payload.get("annotations")));
      String sourcePassword = optionalString(payload.get("sourcePassword"));
      String encryptionPassword = optionalString(payload.get("encryptionPassword"));
      if (encryptionPassword.getBytes(StandardCharsets.UTF_8).length > 32) {
        throw new IllegalArgumentException("Encryption password must be 32 bytes or fewer.");
      }
      byte[] exported = annotations.isEmpty() && sourcePassword.isEmpty() && encryptionPassword.isEmpty()
          ? pdfBytes
          : applyAnnotations(pdfBytes, annotations, sourcePassword, encryptionPassword);
      sendPdf(exchange, exported);
    } catch (Exception error) {
      error.printStackTrace();
      sendJson(exchange, 400, "{\"error\":\"" + escapeJson(error.getMessage()) + "\"}");
    }
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
      byte[] pdfBytes = Base64.getDecoder().decode(asString(payload.get("pdfBase64")));
      String password = asString(payload.get("password"));
      try (PDDocument document = Loader.loadPDF(pdfBytes, password)) {
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
      byte[] pdfBytes = Base64.getDecoder().decode(asString(payload.get("pdfBase64")));
      ByteArrayOutputStream output = new ByteArrayOutputStream();
      StringBuilder pagesJson = new StringBuilder("[");
      boolean changed = false;

      try (PDDocument document = Loader.loadPDF(pdfBytes)) {
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
      error.printStackTrace();
      sendJson(exchange, 400, "{\"error\":\"" + escapeJson(error.getMessage()) + "\"}");
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
      byte[] pdfBytes = Base64.getDecoder().decode(asString(payload.get("pdfBase64")));
      String operation = asString(payload.get("operation"));
      byte[] result;

      if ("rotate".equals(operation)) {
        List<Integer> pages = integerList(asArray(payload.get("pages")));
        int rotation = ((int) asDouble(payload.get("rotation")) % 360 + 360) % 360;
        try (PDDocument document = Loader.loadPDF(pdfBytes)) {
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
        byte[] insertedBytes = Base64.getDecoder().decode(asString(payload.get("insertPdfBase64")));
        int insertAt = (int) asDouble(payload.get("insertAt"));
        try (PDDocument source = Loader.loadPDF(pdfBytes);
             PDDocument inserted = Loader.loadPDF(insertedBytes);
             PDDocument outputDocument = new PDDocument()) {
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
        try (PDDocument source = Loader.loadPDF(pdfBytes);
             PDDocument outputDocument = new PDDocument()) {
          validatePageIndexes(order, source.getNumberOfPages());
          if (order.isEmpty()) throw new IllegalArgumentException("At least one page is required.");
          for (int pageIndex : order) outputDocument.importPage(source.getPage(pageIndex));
          ByteArrayOutputStream output = new ByteArrayOutputStream();
          outputDocument.save(output);
          result = output.toByteArray();
        }
      } else {
        throw new IllegalArgumentException("Unsupported page operation.");
      }

      sendPdf(exchange, result);
    } catch (Exception error) {
      error.printStackTrace();
      sendJson(exchange, 400, "{\"error\":\"" + escapeJson(error.getMessage()) + "\"}");
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
      String sourcePassword,
      String encryptionPassword) throws IOException {
    try (PDDocument document = Loader.loadPDF(pdfBytes, sourcePassword)) {
      document.setAllSecurityToBeRemoved(true);
      List<Integer> redactedPages = new ArrayList<>();
      List<AnnotationStroke> formFields = new ArrayList<>();
      List<AnnotationStroke> pageCrops = new ArrayList<>();
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
          redactedPages.add(pageIndex);
        }
      }
      if (!redactedPages.isEmpty()) {
        flattenRedactedPages(document, redactedPages);
      }
      if (!formFields.isEmpty()) {
        applyFormFields(document, formFields);
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

  private static void flattenRedactedPages(PDDocument document, List<Integer> pageIndexes) throws IOException {
    PDFRenderer renderer = new PDFRenderer(document);
    renderer.setSubsamplingAllowed(false);
    for (int pageIndex : pageIndexes) {
      BufferedImage rendered = renderer.renderImageWithDPI(pageIndex, 144f, ImageType.RGB);
      PDPage page = document.getPage(pageIndex);
      PDRectangle cropBox = page.getCropBox();
      int rotation = ((page.getRotation() % 360) + 360) % 360;
      float displayWidth = rotation == 90 || rotation == 270 ? cropBox.getHeight() : cropBox.getWidth();
      float displayHeight = rotation == 90 || rotation == 270 ? cropBox.getWidth() : cropBox.getHeight();
      PDImageXObject pageImage = LosslessFactory.createFromImage(document, rendered);

      page.setRotation(0);
      page.setMediaBox(new PDRectangle(displayWidth, displayHeight));
      page.setCropBox(new PDRectangle(displayWidth, displayHeight));
      page.setResources(new PDResources());
      page.setContents(new PDStream(document));
      page.setAnnotations(new ArrayList<>());
      try (PDPageContentStream content = new PDPageContentStream(
          document, page, PDPageContentStream.AppendMode.OVERWRITE, false, false)) {
        content.drawImage(pageImage, 0, 0, displayWidth, displayHeight);
      }
      rendered.flush();
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
          if (annotation.fieldChecked) checkbox.check();
          else checkbox.unCheck();
        } else if ("input".equals(annotation.type) && existing instanceof PDTextField textField) {
          textField.setValue(annotation.fieldValue == null ? "" : annotation.fieldValue);
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
          drawTextField(content, page, shape);
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
      PDPageContentStream content,
      PDPage page,
      AnnotationStroke shape) throws IOException {
    String text = sanitizeWinAnsi(shape.text == null ? "" : shape.text)
        .replace("\r\n", "\n")
        .replace('\r', '\n');
    if (text.isBlank()) return;

    String fontFamily = textStyleString(shape, "fontFamily", "Helvetica");
    int fontWeight = (int) textStyleNumber(shape, "fontWeight", 400);
    boolean italic = textStyleBoolean(shape, "italic", false);
    boolean underline = textStyleBoolean(shape, "underline", false);
    boolean strikethrough = textStyleBoolean(shape, "strikethrough", false);
    PDFont font = standardTextFieldFont(fontFamily, fontWeight, italic);
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
    List<String> lines = wrapTextFieldLines(font, fontSize, letterSpacing, availableWidth, text);

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
      List<PdfTextSegment> segments = pdfTextSegments(shape, text, sourceStart, sourceEnd);
      String horizontalAlignment = resolvedPdfTextAlignment(shape, sourceStart);
      float lineWidth = 0;
      for (PdfTextSegment segment : segments) {
        lineWidth += textWidth(segment.style.font, segment.style.fontSize, segment.style.letterSpacing, segment.text);
      }
      double startDistance = horizontalPadding;
      if ("center".equals(horizontalAlignment)) startDistance = (physicalWidth - lineWidth) / 2;
      else if ("right".equals(horizontalAlignment)) startDistance = physicalWidth - horizontalPadding - lineWidth;
      startDistance = Math.max(0, startDistance);
      double baselineDistance = firstBaseline + lineIndex * lineHeight;
      double advance = 0;
      for (PdfTextSegment segment : segments) {
        float segmentWidth = textWidth(segment.style.font, segment.style.fontSize, segment.style.letterSpacing, segment.text);
        double localX = (startDistance + advance) / Math.max(1, physicalWidth);
        PdfPoint baseline = shapePoint(page, shape, localX, baselineDistance / Math.max(1, physicalHeight));
        content.setNonStrokingColor(segment.style.color[0], segment.style.color[1], segment.style.color[2]);
        content.setStrokingColor(segment.style.color[0], segment.style.color[1], segment.style.color[2]);
        content.beginText();
        content.setFont(segment.style.font, segment.style.fontSize);
        content.setCharacterSpacing(segment.style.letterSpacing);
        content.setTextMatrix(new Matrix(cosine, sine, -sine, cosine, baseline.x, baseline.y));
        if (!segment.text.isEmpty()) content.showText(segment.text);
        content.endText();
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
      AnnotationStroke shape,
      String text,
      int start,
      int end) {
    if (end <= start) return List.of(new PdfTextSegment("", resolvedPdfTextStyle(shape, start)));
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
      segments.add(new PdfTextSegment(text.substring(segmentStart, segmentEnd), resolvedPdfTextStyle(shape, segmentStart)));
    }
    return segments;
  }

  private static PdfTextStyle resolvedPdfTextStyle(AnnotationStroke shape, int index) {
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
        standardTextFieldFont(family, weight, italic),
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

  private static float textWidth(PDFont font, float fontSize, float letterSpacing, String text) throws IOException {
    if (text.isEmpty()) return 0;
    return font.getStringWidth(text) / 1000f * fontSize + Math.max(0, text.length() - 1) * letterSpacing;
  }

  private static List<String> wrapTextFieldLines(
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
          if (textWidth(font, fontSize, letterSpacing, remaining.substring(0, index)) > availableWidth) break;
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

    try (PDDocument document = Loader.loadPDF(pdfBytes)) {
      for (int pageIndex = 0; pageIndex < document.getNumberOfPages(); pageIndex += 1) {
        collectEmbeddedFonts(document.getPage(pageIndex).getResources(), result, seenFonts, seenForms);
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
    return new EmbeddedFont(pdfJsName, family, cleanName, css);
  }

  private static String cleanFontName(String value) {
    int subset = value.indexOf('+');
    return subset >= 0 && subset + 1 < value.length() ? value.substring(subset + 1) : value;
  }

  private static EditResult applyEdits(byte[] pdfBytes, List<TextEdit> edits) throws IOException {
    EditResult result = new EditResult();
    try (PDDocument document = Loader.loadPDF(pdfBytes)) {
      document.setAllSecurityToBeRemoved(true);
      for (TextEdit edit : edits) {
        if (edit.newText.equals(edit.oldText) && !edit.moved && !edit.overlay) {
          continue;
        }
        if (edit.page < 0 || edit.page >= document.getNumberOfPages()) {
          result.misses.add("Page " + (edit.page + 1) + " is outside the document.");
          continue;
        }
        PDPage page = document.getPage(edit.page);
        if (edit.overlay) {
          if (overlayEditFallback(document, page, edit)) {
            result.applied += 1;
          } else {
            result.misses.add("Could not place aligned text on page " + (edit.page + 1) + ": " + edit.oldText);
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
          }
          continue;
        }
        TextEdit effectiveEdit = withoutLeadingListMarker(edit);
        if (rewritePageWithCandidates(document, page, effectiveEdit)) {
          result.applied += 1;
        } else {
          result.misses.add("Could not find editable text on page " + (edit.page + 1) + ": " + edit.oldText);
        }
      }

      ByteArrayOutputStream output = new ByteArrayOutputStream();
      document.save(output);
      result.pdfBytes = output.toByteArray();
      return result;
    }
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
        edit.letterSpacing);
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

    rewritePageWithCandidates(document, page, new TextEdit(
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
        0));

    float pageWidth = page.getMediaBox().getWidth();
    float pageHeight = page.getMediaBox().getHeight();
    float left = coordinate(edit.rect.get(0), pageWidth);
    float bottom = coordinate(edit.rect.get(1), pageHeight);
    float right = coordinate(edit.rect.get(2), pageWidth);
    float top = coordinate(edit.rect.get(3), pageHeight);
    float width = Math.max(1f, right - left);
    float height = Math.max(1f, top - bottom);
    float fontSize = overlayFontSize(edit, pageHeight, height);
    String text = sanitizeWinAnsi(edit.newText);
    if (text.isBlank()) {
      text = " ";
    }

    Standard14Fonts.FontName fontName = edit.bold
        ? (edit.italic ? Standard14Fonts.FontName.HELVETICA_BOLD_OBLIQUE : Standard14Fonts.FontName.HELVETICA_BOLD)
        : (edit.italic ? Standard14Fonts.FontName.HELVETICA_OBLIQUE : Standard14Fonts.FontName.HELVETICA);
    PDFont font = !edit.fontChanged && originalStyle.font != null && canEncodeWithFont(text, originalStyle.font)
        ? originalStyle.font
        : findPageFont(page, edit.fontName, text, edit.bold, edit.italic);
    if (font == null) {
      font = overlayFont(document, edit, fontName);
    }
    left = overlayAlignedLeft(edit, font, fontSize, pageWidth, left, right, text);
    float baseline = bottom + Math.max(1f, (height - fontSize) * 0.5f);
    float characterSpacing = edit.pageSize.size() >= 2 && edit.pageSize.get(1) > 0
        ? (float) (edit.letterSpacing * pageHeight / edit.pageSize.get(1))
        : (float) edit.letterSpacing;

    try (PDPageContentStream stream = new PDPageContentStream(
        document, page, PDPageContentStream.AppendMode.APPEND, true, true)) {
      stream.beginText();
      setOverlayColor(stream, edit.color);
      stream.setFont(font, fontSize);
      stream.setCharacterSpacing(characterSpacing);
      if (edit.italic && !fontIsItalic(font)) {
        stream.setTextMatrix(new Matrix(1, 0, 0.22f, 1, left, baseline));
      } else {
        stream.newLineAtOffset(left, baseline);
      }
      stream.showText(text);
      stream.endText();
      if (edit.underline || edit.strikethrough) {
        setOverlayStrokeColor(stream, edit.color);
        stream.setLineWidth(Math.max(0.6f, fontSize * 0.055f));
        float textWidth = pdfTextWidth(font, text, fontSize)
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

  private static float overlayAlignedLeft(
      TextEdit edit,
      PDFont font,
      float fontSize,
      float pageWidth,
      float fallbackLeft,
      float fallbackRight,
      String text) throws IOException {
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

    float textWidth = pdfTextWidth(font, text, fontSize);
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
          edit.letterSpacing))) {
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
        edit.letterSpacing);
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
        edit.letterSpacing);
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
          edit.letterSpacing))) {
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

    List<Integer> adjustedPositionOperators = new ArrayList<>();
    for (int operatorIndex : operatorIndexes) {
      int positionOperator = findNearestTextPositionOperator(tokens, operatorIndex);
      if (positionOperator < 0) {
        return false;
      }
      if (!adjustedPositionOperators.contains(positionOperator)) {
        adjustTextPositionOperator(tokens, positionOperator, dx, dy);
        adjustedPositionOperators.add(positionOperator);
      }
    }
    promoteTextBlocksToFront(tokens, affected, edit);
    return !adjustedPositionOperators.isEmpty();
  }

  private static void promoteTextBlocksToFront(List<Object> tokens, List<TextUnit> units, TextEdit edit) {
    List<TextBlockMove> moves = new ArrayList<>();
    for (TextUnit unit : units) {
      TextBlockRange range = findTextBlockRange(tokens, unit.operatorIndex);
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

  private static int findNearestTextPositionOperator(List<Object> tokens, int textOperatorIndex) {
    for (int index = textOperatorIndex - 1; index >= 0; index -= 1) {
      Object token = tokens.get(index);
      if (!(token instanceof Operator operator)) {
        continue;
      }

      String name = operator.getName();
      if ("Tm".equals(name) || "Td".equals(name) || "TD".equals(name)) {
        return index;
      }
      if ("Tj".equals(name) || "TJ".equals(name) || "'".equals(name) || "\"".equals(name) || "BT".equals(name) || "ET".equals(name)) {
        break;
      }
    }
    return -1;
  }

  private static void adjustTextPositionOperator(List<Object> tokens, int operatorIndex, float dx, float dy) {
    Object token = tokens.get(operatorIndex);
    if (!(token instanceof Operator operator)) {
      return;
    }

    String name = operator.getName();
    if ("Tm".equals(name) && operatorIndex >= 6) {
      adjustNumberToken(tokens, operatorIndex - 2, dx);
      adjustNumberToken(tokens, operatorIndex - 1, dy);
    } else if (("Td".equals(name) || "TD".equals(name)) && operatorIndex >= 2) {
      adjustNumberToken(tokens, operatorIndex - 2, dx);
      adjustNumberToken(tokens, operatorIndex - 1, dy);
    }
  }

  private static void adjustNumberToken(List<Object> tokens, int index, float delta) {
    if (index < 0 || index >= tokens.size() || !(tokens.get(index) instanceof COSNumber number)) {
      return;
    }
    tokens.set(index, new COSFloat(number.floatValue() + delta));
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
    List<Object> mixedTokens = mixedTextTokensForUnits(resources, replacement, affected, codecs, edit.bold);
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

    List<Object> mixedTokens = mixedTextTokens(resources, replacement, font, fontName, fontSize, codec, edit.bold);
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
      FontCodec originalCodec,
      boolean fallbackBold) {
    if (resources == null || originalFont == null || originalFontName == null || originalFontSize <= 0) {
      return List.of();
    }

    PDFont fallbackFont = standardFallbackFont(fontLooksBold(originalFont, fallbackBold));
    COSName fallbackFontName = resources.add(fallbackFont);
    List<TextRun> runs = mixedTextRuns(text, originalFont, originalCodec, fallbackFont);
    if (runs.isEmpty()) {
      return List.of();
    }

    List<Object> mixedTokens = new ArrayList<>();
    COSName activeFontName = null;
    for (TextRun run : runs) {
      COSName runFontName = run.fallback ? fallbackFontName : originalFontName;
      PDFont runFont = run.fallback ? fallbackFont : originalFont;
      FontCodec runCodec = run.fallback ? null : originalCodec;
      EncodedText encoded = encodeString(run.text, runFont, runCodec);
      if (encoded == null) {
        return List.of();
      }
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
      Map<PDFont, FontCodec> codecs,
      boolean fallbackBold) {
    if (resources == null || styleUnits.isEmpty()) {
      return List.of();
    }

    Map<Boolean, PDFont> fallbackFonts = new LinkedHashMap<>();
    Map<Boolean, COSName> fallbackFontNames = new LinkedHashMap<>();
    List<Object> mixedTokens = new ArrayList<>();
    COSName activeFontName = null;
    float activeFontSize = -1f;

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
      boolean useFallback = encodeString(glyph, styleUnit.font, codec) == null;
      PDFont runFont = styleUnit.font;
      COSName runFontName = styleUnit.fontName;
      FontCodec runCodec = codec;
      String runGlyph = glyph;
      if (useFallback) {
        boolean bold = fontLooksBold(styleUnit.font, fallbackBold);
        PDFont fallbackFont = fallbackFonts.computeIfAbsent(bold, DocuflexPdfServer::standardFallbackFont);
        runFontName = fallbackFontNames.computeIfAbsent(bold, (key) -> resources.add(fallbackFont));
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

  private static List<TextRun> mixedTextRuns(
      String text,
      PDFont originalFont,
      FontCodec originalCodec,
      PDFont fallbackFont) {
    List<TextRun> runs = new ArrayList<>();
    StringBuilder current = new StringBuilder();
    Boolean currentFallback = null;

    for (int offset = 0; offset < text.length();) {
      int codePoint = text.codePointAt(offset);
      String glyph = new String(Character.toChars(codePoint));
      boolean fallback = encodeString(glyph, originalFont, originalCodec) == null;
      String runGlyph = fallback ? fallbackGlyph(glyph, fallbackFont) : glyph;
      if (runGlyph.isEmpty()) {
        offset += Character.charCount(codePoint);
        continue;
      }
      if (currentFallback != null && currentFallback != fallback) {
        runs.add(new TextRun(current.toString(), currentFallback));
        current.setLength(0);
      }
      current.append(runGlyph);
      currentFallback = fallback;
      offset += Character.charCount(codePoint);
    }

    if (!current.isEmpty() && currentFallback != null) {
      runs.add(new TextRun(current.toString(), currentFallback));
    }
    return runs;
  }

  private static String fallbackGlyph(String glyph, PDFont fallbackFont) {
    String sanitized = sanitizeWinAnsi(glyph);
    if (canEncodeWithFont(sanitized, fallbackFont)) {
      return sanitized;
    }
    if (canEncodeWithFont(glyph, fallbackFont)) {
      return glyph;
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
          optionalDouble(edit.get("letterSpacing"))));
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

  private static boolean optionalBoolean(Object value) {
    return value instanceof Boolean bool && bool;
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
    send(exchange, status, body);
  }

  private static void sendPdf(HttpExchange exchange, byte[] bytes) throws IOException {
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
        default -> escaped.append(ch);
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
      double letterSpacing) {}

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

  private record EmbeddedFont(String pdfJsName, String family, String baseName, String css) {}

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

  private record TextRun(String text, boolean fallback) {}

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
            .append("\"baseName\":\"").append(escapeJson(font.baseName)).append("\"")
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
      Object value = parseValue();
      skipWhitespace();
      if (index != source.length()) {
        throw new IllegalArgumentException("Unexpected JSON after position " + index);
      }
      return value;
    }

    private Object parseValue() {
      skipWhitespace();
      if (index >= source.length()) {
        throw new IllegalArgumentException("Unexpected end of JSON.");
      }
      char ch = source.charAt(index);
      if (ch == '{') {
        return parseObject();
      }
      if (ch == '[') {
        return parseArray();
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

    private Map<String, Object> parseObject() {
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
        object.put(key, parseValue());
        skipWhitespace();
        if (peek('}')) {
          index += 1;
          return object;
        }
        expect(',');
      }
    }

    private List<Object> parseArray() {
      expect('[');
      List<Object> array = new ArrayList<>();
      skipWhitespace();
      if (peek(']')) {
        index += 1;
        return array;
      }
      while (true) {
        array.add(parseValue());
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
