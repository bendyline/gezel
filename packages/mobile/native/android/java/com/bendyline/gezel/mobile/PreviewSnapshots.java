package com.bendyline.gezel.mobile;

import android.net.Uri;
import android.webkit.WebResourceResponse;
import com.getcapacitor.JSObject;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/** Ephemeral copies only: this handler has no product-file or network authority. */
public final class PreviewSnapshots {
    public static final String PREFIX = "/__gezel_preview/";
    public static final String CSP = "default-src 'none'; script-src data:; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";
    private static final int MAX_BYTES = 8 * 1024 * 1024;
    private static final long TTL = 10 * 60 * 1000;
    private static final class Entry {
        final byte[] bytes; final long created = android.os.SystemClock.elapsedRealtime();
        Entry(byte[] bytes) { this.bytes = bytes; }
    }
    private final Map<String, Entry> entries = new LinkedHashMap<>();
    public volatile boolean available;
    public static boolean reserved(Uri url) { return url.getPath() != null && url.getPath().startsWith(PREFIX); }
    public static boolean packaged(Uri url) {
        return url != null && "https".equals(url.getScheme()) && "localhost".equals(url.getHost()) &&
            (url.getPort() == -1 || url.getPort() == 443) && ("/".equals(url.getPath()) || "/index.html".equals(url.getPath()) || "".equals(url.getPath()));
    }
    public synchronized JSObject publish(String html) {
        if (!available) throw new IllegalStateException("Update Android System WebView to preview pages safely");
        if (html == null || html.length() > MAX_BYTES) throw new IllegalArgumentException("Preview exceeds 8 MiB");
        byte[] bytes = html.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_BYTES) throw new IllegalArgumentException("Preview exceeds 8 MiB");
        expire(); int total = bytes.length;
        for (Entry item : entries.values()) total += item.bytes.length;
        if (entries.size() >= 4 || total > 16 * 1024 * 1024) throw new IllegalStateException("Close another preview before opening this page");
        String id = UUID.randomUUID().toString(); entries.put(id, new Entry(bytes));
        JSObject result = new JSObject(); result.put("id", id); result.put("url", "https://localhost" + PREFIX + id + "/index.html"); return result;
    }
    public synchronized void remove(String id) { entries.remove(id); }
    private void expire() { long now = android.os.SystemClock.elapsedRealtime(); entries.values().removeIf(item -> now - item.created > TTL); }
    public synchronized WebResourceResponse response(Uri url, boolean mainFrame, String method) {
        expire(); Entry entry = null;
        String path = url.getPath();
        if (!mainFrame && "GET".equals(method) && "https".equals(url.getScheme()) && "localhost".equals(url.getHost()) && url.getQuery() == null && path != null && path.matches("/__gezel_preview/[0-9a-f-]{36}/index\\.html")) {
            entry = entries.get(path.substring(PREFIX.length(), PREFIX.length() + 36));
        }
        Map<String, String> headers = new HashMap<>();
        headers.put("Content-Security-Policy", CSP); headers.put("Cache-Control", "no-store"); headers.put("X-Content-Type-Options", "nosniff"); headers.put("Referrer-Policy", "no-referrer");
        return new WebResourceResponse("text/html", "UTF-8", entry == null ? 404 : 200, entry == null ? "Not Found" : "OK", headers, new ByteArrayInputStream(entry == null ? new byte[0] : entry.bytes));
    }
}
