import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.graphics.color.PDDeviceGray;
import org.apache.pdfbox.pdmodel.graphics.color.PDDeviceRGB;
import org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject;

/** Store-only raster operations. PDF editing, glyph coverage and redaction cleanup stay in PDFBox. */
final class NativeRasterBridge {
  private static final int MAGIC = 0x44465232;
  private static final int MAX_BYTES = 160 * 1024 * 1024;
  private static final Set<Process> CHILDREN = ConcurrentHashMap.newKeySet();
  static {
    Runtime.getRuntime().addShutdownHook(new Thread(() -> {
      for (Process child : CHILDREN) child.destroyForcibly();
    }, "docuflex-raster-shutdown"));
  }
  // Native Image snapshots this tiny class at build time. A Store executable
  // therefore cannot fall back to the unsupported macOS AWT path at runtime.
  static final class Mode { static final boolean ENABLED = Boolean.getBoolean("docuflex.native.raster"); }
  static boolean enabled() { return Mode.ENABLED; }

  record Image(int width, int height, int codec, byte[] pixels, byte[] alpha, List<double[]> redactionBounds) {
    PDImageXObject embed(PDDocument document) throws IOException {
      PDImageXObject result = new PDImageXObject(document, new ByteArrayInputStream(pixels),
          codec == 1 ? COSName.DCT_DECODE : COSName.FLATE_DECODE, width, height, 8, PDDeviceRGB.INSTANCE);
      if (alpha.length > 0) {
        PDImageXObject mask = new PDImageXObject(document, new ByteArrayInputStream(alpha),
            COSName.FLATE_DECODE, width, height, 8, PDDeviceGray.INSTANCE);
        result.getCOSObject().setItem(COSName.SMASK, mask);
      }
      return result;
    }
    byte[] encode() throws IOException {
      ByteArrayOutputStream bytes = new ByteArrayOutputStream();
      DataOutputStream out = new DataOutputStream(bytes);
      out.writeInt(MAGIC); out.writeInt(width); out.writeInt(height); out.writeInt(codec);
      out.writeInt(pixels.length); out.writeInt(alpha.length); out.writeInt(redactionBounds.size()); out.write(pixels); out.write(alpha);
      for (double[] box : redactionBounds) for (double coordinate : box) out.writeDouble(coordinate);
      return bytes.toByteArray();
    }
  }
  static Image decode(byte[] bytes) throws IOException { return call("image", "{}", bytes); }
  static Image render(PDDocument document, int page, float dpi, float[] display,
      List<double[][]> polygons, List<Boolean> black, boolean redacting) throws IOException {
    ByteArrayOutputStream pdf = new ByteArrayOutputStream();
    document.save(pdf);
    StringBuilder params = new StringBuilder("{\"page\":").append(page).append(",\"dpi\":").append(dpi)
        .append(",\"display\":[").append(display[0]).append(',').append(display[1])
        .append("],\"redacting\":").append(redacting).append(",\"polygons\":[");
    for (int i = 0; i < polygons.size(); i++) {
      if (i > 0) params.append(','); params.append('[');
      double[][] corners = polygons.get(i);
      for (int j = 0; j < corners.length; j++) {
        if (j > 0) params.append(',');
        params.append('[').append(corners[j][0]).append(',').append(corners[j][1]).append(']');
      }
      params.append(']');
    }
    params.append("],\"black\":[");
    for (int i = 0; i < black.size(); i++) { if (i > 0) params.append(','); params.append(black.get(i)); }
    params.append("]}");
    return call("render", params.toString(), pdf.toByteArray());
  }
  static Image blur(Image source, int left, int top, int right, int bottom, int radius) throws IOException {
    return call("blur", "{\"box\":["+left+","+top+","+right+","+bottom+"],\"radius\":"+radius+"}", source.encode());
  }
  private static Image call(String operation, String parameters, byte[] input) throws IOException {
    if (input.length > MAX_BYTES) throw new IOException("The image input exceeds the supported size.");
    String python = System.getenv("DOCUFLEX_NATIVE_RASTER_PYTHON");
    String script = System.getenv("DOCUFLEX_NATIVE_RASTER_SCRIPT");
    if (python == null || script == null) throw new IOException("The bundled native image helper is missing.");
    Process child = new ProcessBuilder(python, script, operation).redirectError(ProcessBuilder.Redirect.INHERIT).start();
    CHILDREN.add(child);
    Thread watchdog = new Thread(() -> {
      try { Thread.sleep(120_000); child.destroyForcibly(); }
      catch (InterruptedException done) { Thread.currentThread().interrupt(); }
    }, "docuflex-raster-timeout");
    watchdog.setDaemon(true); watchdog.start();
    try {
      try (var output = child.getOutputStream()) {
        output.write(parameters.getBytes(StandardCharsets.UTF_8)); output.write('\n'); output.write(input);
      }
      byte[] frame = child.getInputStream().readNBytes(MAX_BYTES + 1);
      int status;
      try { status = child.waitFor(); }
      catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new IOException("The image operation was cancelled.", error); }
      if (status != 0 || frame.length < 28 || frame.length > MAX_BYTES) throw new IOException("The native image operation failed.");
      DataInputStream data = new DataInputStream(new ByteArrayInputStream(frame));
      if (data.readInt() != MAGIC) throw new IOException("The image helper returned invalid data.");
      int width = data.readInt(), height = data.readInt(), codec = data.readInt();
      int length = data.readInt(), alphaLength = data.readInt(), boxCount = data.readInt();
      if (width <= 0 || height <= 0 || (long) width * height > 40_000_000 || codec < 0 || codec > 1
          || length <= 0 || alphaLength < 0 || boxCount < 0 || boxCount > 100_000 || (long) length + alphaLength + 28 + (long) boxCount * 32 != frame.length) {
        throw new IOException("The image helper returned invalid dimensions.");
      }
      byte[] pixels = data.readNBytes(length), alpha = data.readNBytes(alphaLength);
      List<double[]> bounds = new java.util.ArrayList<>();
      for (int i = 0; i < boxCount; i++) {
        double[] box = new double[4];
        for (int j = 0; j < 4; j++) { box[j] = data.readDouble(); if (!Double.isFinite(box[j])) throw new IOException("Invalid raster bounds."); }
        bounds.add(box);
      }
      return new Image(width, height, codec, pixels, alpha, bounds);
    } finally { watchdog.interrupt(); child.destroyForcibly(); CHILDREN.remove(child); }
  }
}
