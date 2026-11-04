package com.bendyline.gezel.capacitor;

import android.content.Context;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Byte ranges of installed knowledge catalogs for the reader that runs in the
 * app's WebView, where SQLite reads catalog pages with synchronous range
 * requests. Capacitor's own file server serves any app file and sizes ranges
 * with InputStream.available(), an int; this one is confined to the catalog
 * store and sized from the file. Apps call {@link #intercept} first from their
 * BridgeWebViewClient's shouldInterceptRequest.
 *
 * Read-only and confined to the catalog store; catalogs are public reference
 * data, never the person's documents.
 */
public final class KnowledgeFiles {
    public static final String PREFIX = "/_gezel_knowledge/";
    private static final Pattern SEGMENT = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._-]{0,127}");
    private static final Pattern RANGE = Pattern.compile("bytes=(\\d+)-(\\d*)");
    private static final int MAX_RANGE = 8 * 1024 * 1024;
    private KnowledgeFiles() {}

    public static File root(Context context) { return new File(context.getNoBackupFilesDir(), "gezel-knowledge/catalogs"); }

    /** The response for a catalog byte range, or null when the request is not one. */
    public static WebResourceResponse intercept(Context context, WebResourceRequest request) {
        Uri url = request.getUrl();
        String path = url.getPath();
        if (!"https".equals(url.getScheme()) || !"localhost".equals(url.getHost()) || path == null || !path.startsWith(PREFIX)) return null;
        if (!"GET".equals(request.getMethod())) return status(405, "Method Not Allowed");
        String[] parts = path.substring(PREFIX.length()).split("/", -1);
        if (parts.length == 0 || parts.length > 12) return status(404, "Not Found");
        for (String part : parts) if (!SEGMENT.matcher(part).matches()) return status(404, "Not Found");
        try {
            File root = root(context).getCanonicalFile();
            File file = new File(root, String.join("/", parts)).getCanonicalFile();
            if (!file.getPath().startsWith(root.getPath() + File.separator) || !file.isFile()) return status(404, "Not Found");
            long size = file.length();
            String header = request.getRequestHeaders().get("Range");
            if (header == null) header = request.getRequestHeaders().get("range");
            Matcher range = header == null ? null : RANGE.matcher(header);
            if (range == null || !range.matches()) return status(416, "Range Not Satisfiable");
            long start = Long.parseLong(range.group(1));
            long end = range.group(2).isEmpty() ? size - 1 : Long.parseLong(range.group(2));
            end = Math.min(end, size - 1);
            if (start > end || end - start + 1 > MAX_RANGE) return status(416, "Range Not Satisfiable");
            Map<String, String> headers = new HashMap<>();
            headers.put("Content-Range", "bytes " + start + "-" + end + "/" + size);
            headers.put("Accept-Ranges", "bytes");
            headers.put("Cache-Control", "no-store");
            // WebView skips to the range's first byte itself but reads on to the end,
            // so the stream starts at byte 0 like the file and ends after the range.
            return new WebResourceResponse("application/octet-stream", null, 206, "Partial Content", headers, new Bounded(new FileInputStream(file), end + 1));
        } catch (Exception error) {
            return status(500, "Internal Server Error");
        }
    }

    /** A file stream that ends at `limit`, counting the bytes WebView skips. */
    private static final class Bounded extends FilterInputStream {
        private long position;
        private final long limit;
        Bounded(InputStream input, long limit) { super(input); this.limit = limit; }
        @Override public int read() throws IOException {
            if (position >= limit) return -1;
            int value = super.read();
            if (value >= 0) position++;
            return value;
        }
        @Override public int read(byte[] buffer, int offset, int length) throws IOException {
            if (position >= limit) return -1;
            int read = super.read(buffer, offset, (int) Math.min(length, limit - position));
            if (read > 0) position += read;
            return read;
        }
        @Override public long skip(long count) throws IOException {
            long skipped = super.skip(Math.min(count, Math.max(0, limit - position)));
            position += skipped;
            return skipped;
        }
        @Override public int available() throws IOException { return (int) Math.min(super.available(), Math.max(0, limit - position)); }
    }

    private static WebResourceResponse status(int code, String reason) {
        return new WebResourceResponse("text/plain", "utf-8", code, reason, new HashMap<>(), new ByteArrayInputStream(reason.getBytes(StandardCharsets.UTF_8)));
    }
}
