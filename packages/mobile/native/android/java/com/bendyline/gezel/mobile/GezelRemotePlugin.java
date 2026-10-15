package com.bendyline.gezel.mobile;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.os.Build;
import android.provider.Settings;
import android.util.Base64;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.*;
import java.util.concurrent.*;
import javax.net.ssl.*;

/** HTTPS to other devices' gezel servers on the local network, and discovery
 * of them (`_gezel._tcp`).
 *
 * A server's certificate is self-signed and names 127.0.0.1, so a request
 * never checks hostnames: it trusts exactly the certificate the page pinned.
 * To read a server's `/v1/identity` before anything is pinned, it first takes
 * the certificate the server presents (refusing that handshake) and then
 * pins the request to it; the page accepts the identity only if the server's
 * identity key signed that certificate. Requests go only to `https://`
 * IP-literal addresses, so the page cannot use this as a general proxy. A
 * response body streams to the page as `remoteChunk` events and ends with
 * one `remoteEnd`. */
@CapacitorPlugin(name = "GezelRemote")
public final class GezelRemotePlugin extends Plugin {
    static final String CERTIFICATE_REFUSED = "REMOTE_CERTIFICATE_REFUSED";
    static final String UNREACHABLE = "REMOTE_UNREACHABLE";
    static final String CANCELLED = "REMOTE_CANCELLED";
    private static final String SERVICE_TYPE = "_gezel._tcp";
    private static final int MAX_BODY_BYTES = 32 * 1024 * 1024;
    private static final int MAX_REQUESTS = 16;
    /** Idle time between packets; a server writes a heartbeat every 15 s. */
    private static final int READ_TIMEOUT_MS = 120_000;
    private final ExecutorService workers = Executors.newCachedThreadPool();
    private final ExecutorService resolver = Executors.newSingleThreadExecutor();
    private final Map<String, HttpsURLConnection> open = new ConcurrentHashMap<>();
    private final Set<String> cancelled = ConcurrentHashMap.newKeySet();

    @PluginMethod public void request(PluginCall call) {
        String id = call.getString("id");
        URL url;
        try {
            if (id == null || id.isEmpty() || id.length() > 64) throw new IllegalArgumentException();
            url = new URL(call.getString("url"));
            if (!"https".equals(url.getProtocol()) || !isIpLiteral(url.getHost())) throw new IllegalArgumentException();
        } catch (Exception invalid) { call.reject("A server request needs an https:// IP address", "invalid-input"); return; }
        String body = call.getString("body");
        byte[] bytes = body == null ? null : body.getBytes(StandardCharsets.UTF_8);
        if (bytes != null && bytes.length > MAX_BODY_BYTES) { call.reject("This request is too large", "invalid-input"); return; }
        String pem = call.getString("pinnedCertPem");
        byte[] pinned = pem == null ? null : derFromPem(pem);
        if (pem != null && pinned == null) { call.reject("The pinned certificate is unreadable", "invalid-input"); return; }
        if (open.size() >= MAX_REQUESTS) { call.reject("Too many requests to other devices are open", "busy"); return; }
        int connectTimeout = Math.max(1_000, Math.min(call.getInt("connectTimeoutMs", 5_000), 30_000));
        JSObject headers = call.getObject("headers", new JSObject());
        String method = call.getString("method", "GET");
        workers.execute(() -> run(call, id, url, method, headers, bytes, pinned, connectTimeout));
    }

    @PluginMethod public void cancel(PluginCall call) {
        String id = call.getString("id");
        if (id != null) {
            cancelled.add(id);
            HttpsURLConnection connection = open.get(id);
            if (connection != null) workers.execute(connection::disconnect);
        }
        call.resolve();
    }

    @PluginMethod public void deviceName(PluginCall call) {
        String name = Build.VERSION.SDK_INT >= 25
            ? Settings.Global.getString(getContext().getContentResolver(), Settings.Global.DEVICE_NAME)
            : null;
        JSObject result = new JSObject();
        result.put("name", name == null || name.trim().isEmpty() ? Build.MODEL : name.trim());
        call.resolve(result);
    }

    @PluginMethod public void browse(PluginCall call) {
        int waitMs = Math.max(200, Math.min(call.getInt("waitMs", 1_500), 10_000));
        final NsdManager nsd = (NsdManager) getContext().getSystemService(Context.NSD_SERVICE);
        Map<String, JSObject> found = new ConcurrentHashMap<>();
        NsdManager.DiscoveryListener listener = nsd == null ? null : new NsdManager.DiscoveryListener() {
            @Override public void onDiscoveryStarted(String type) {}
            @Override public void onDiscoveryStopped(String type) {}
            @Override public void onStartDiscoveryFailed(String type, int code) {}
            @Override public void onStopDiscoveryFailed(String type, int code) {}
            @Override public void onServiceLost(NsdServiceInfo info) {}
            @Override public void onServiceFound(NsdServiceInfo info) { resolve(nsd, info, found); }
        };
        boolean started = false;
        if (nsd != null) {
            try { nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener); started = true; }
            catch (RuntimeException unavailable) { /* answer with nothing found */ }
        }
        final NsdManager active = started ? nsd : null;
        workers.execute(() -> {
            // Give addresses still resolving a moment, then answer.
            try { Thread.sleep(waitMs + 750L); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
            if (active != null) {
                try { active.stopServiceDiscovery(listener); } catch (RuntimeException ignored) {}
            }
            JSArray servers = new JSArray();
            for (JSObject server : found.values()) servers.put(server);
            JSObject result = new JSObject();
            result.put("servers", servers);
            call.resolve(result);
        });
    }

    /** Older Android resolves one service at a time, so resolution is queued. */
    @SuppressWarnings("deprecation")
    private void resolve(NsdManager nsd, NsdServiceInfo info, Map<String, JSObject> found) {
        resolver.execute(() -> {
            CountDownLatch done = new CountDownLatch(1);
            try {
                nsd.resolveService(info, new NsdManager.ResolveListener() {
                    @Override public void onResolveFailed(NsdServiceInfo service, int code) { done.countDown(); }
                    @Override public void onServiceResolved(NsdServiceInfo service) {
                        InetAddress host = service.getHost();
                        if (host instanceof Inet4Address && service.getPort() > 0) {
                            Map<String, byte[]> txt = service.getAttributes();
                            String name = text(txt.get("name"));
                            String fingerprint = text(txt.get("fp"));
                            JSObject server = new JSObject();
                            server.put("name", name == null || name.isEmpty() ? service.getServiceName() : name.length() > 80 ? name.substring(0, 80) : name);
                            server.put("host", host.getHostAddress());
                            server.put("port", service.getPort());
                            if (fingerprint != null) server.put("fingerprint", fingerprint.toLowerCase(Locale.ROOT));
                            found.put(service.getServiceName(), server);
                        }
                        done.countDown();
                    }
                });
                done.await(3, TimeUnit.SECONDS);
            } catch (InterruptedException stopped) { Thread.currentThread().interrupt(); }
            catch (RuntimeException ignored) {}
        });
    }

    private void run(PluginCall call, String id, URL url, String method, JSObject headers, byte[] body, byte[] pinned, int connectTimeout) {
        PinnedTrust trust = null;
        HttpsURLConnection connection = null;
        boolean answered = false;
        try {
            byte[] pin = pinned != null ? pinned : presentedCertificate(url, connectTimeout);
            trust = new PinnedTrust(pin);
            SSLContext tls = SSLContext.getInstance("TLS");
            tls.init(null, new TrustManager[] { trust }, null);
            connection = (HttpsURLConnection) url.openConnection(Proxy.NO_PROXY);
            open.put(id, connection);
            if (cancelled.contains(id)) throw new IOException("The request was stopped");
            connection.setSSLSocketFactory(tls.getSocketFactory());
            // The certificate is pinned exactly; it names 127.0.0.1, not this address.
            connection.setHostnameVerifier((host, session) -> true);
            connection.setConnectTimeout(connectTimeout);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setUseCaches(false);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestMethod(method);
            Iterator<String> names = headers.keys();
            while (names.hasNext()) {
                String name = names.next();
                String value = headers.optString(name, null);
                if (value != null) connection.setRequestProperty(name, value);
            }
            if (body != null) {
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(body.length);
                try (OutputStream out = connection.getOutputStream()) { out.write(body); }
            }
            int status = connection.getResponseCode();
            JSObject responseHeaders = new JSObject();
            for (Map.Entry<String, List<String>> entry : connection.getHeaderFields().entrySet())
                if (entry.getKey() != null && !entry.getValue().isEmpty())
                    responseHeaders.put(entry.getKey().toLowerCase(Locale.ROOT), String.join(", ", entry.getValue()));
            JSObject head = new JSObject();
            head.put("status", status);
            head.put("headers", responseHeaders);
            answered = true;
            call.resolve(head);
            InputStream in = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            if (in != null) {
                try (InputStream stream = in) {
                    byte[] buffer = new byte[16 * 1024];
                    int read;
                    while ((read = stream.read(buffer)) != -1) {
                        JSObject chunk = new JSObject();
                        chunk.put("id", id);
                        chunk.put("data", Base64.encodeToString(buffer, 0, read, Base64.NO_WRAP));
                        notifyListeners("remoteChunk", chunk);
                    }
                }
            }
            JSObject end = new JSObject();
            end.put("id", id);
            notifyListeners("remoteEnd", end);
        } catch (Exception error) {
            boolean refused = trust != null && trust.refused;
            boolean stopped = cancelled.contains(id);
            String code = refused ? CERTIFICATE_REFUSED : stopped ? CANCELLED : UNREACHABLE;
            String message = refused
                ? "The server presented a certificate other than the one this device trusts"
                : stopped ? "The request was stopped"
                : error.getMessage() == null ? "The server didn't answer" : error.getMessage();
            if (!answered) call.reject(message, code);
            else {
                JSObject end = new JSObject();
                end.put("id", id);
                end.put("error", message);
                end.put("code", code);
                notifyListeners("remoteEnd", end);
            }
        } finally {
            open.remove(id);
            cancelled.remove(id);
            if (connection != null) connection.disconnect();
        }
    }

    /** The certificate a server presents, read from a handshake this refuses. */
    private static byte[] presentedCertificate(URL url, int connectTimeout) throws Exception {
        PinnedTrust capture = new PinnedTrust(null);
        SSLContext tls = SSLContext.getInstance("TLS");
        tls.init(null, new TrustManager[] { capture }, null);
        String host = url.getHost();
        int port = url.getPort() == -1 ? 443 : url.getPort();
        try (Socket raw = new Socket(Proxy.NO_PROXY)) {
            raw.connect(new InetSocketAddress(InetAddress.getByName(host), port), connectTimeout);
            raw.setSoTimeout(10_000);
            try (SSLSocket socket = (SSLSocket) tls.getSocketFactory().createSocket(raw, host, port, false)) {
                socket.startHandshake();
            } catch (SSLException expected) {
                // Refused on purpose once the certificate was read.
            }
        }
        if (capture.presented == null) throw new IOException("The server didn't present a certificate");
        return capture.presented;
    }

    /** Trusts exactly one certificate. Without one, it records the presented
     * certificate and refuses the handshake. */
    private static final class PinnedTrust implements X509TrustManager {
        private final byte[] pinned;
        volatile byte[] presented;
        volatile boolean refused;
        PinnedTrust(byte[] pinned) { this.pinned = pinned; }
        @Override public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            throw new CertificateException("Client certificates are not accepted");
        }
        @Override public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            if (chain == null || chain.length == 0) throw new CertificateException("The server presented no certificate");
            byte[] leaf = chain[0].getEncoded();
            if (pinned == null) {
                presented = leaf;
                throw new CertificateException("Read the presented certificate");
            }
            if (!MessageDigest.isEqual(leaf, pinned)) {
                refused = true;
                throw new CertificateException("The certificate does not match the pinned one");
            }
        }
        @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
    }

    static boolean isIpLiteral(String host) {
        if (host == null) return false;
        if (host.startsWith("[") && host.endsWith("]")) return host.length() > 2 && host.substring(1, host.length() - 1).matches("[0-9a-fA-F:.%]+");
        if (!host.matches("\\d{1,3}(\\.\\d{1,3}){3}")) return false;
        for (String part : host.split("\\.")) if (Integer.parseInt(part) > 255) return false;
        return true;
    }

    static byte[] derFromPem(String pem) {
        StringBuilder body = new StringBuilder();
        for (String line : pem.split("\\r?\\n")) if (!line.startsWith("-----")) body.append(line.trim());
        try { return Base64.decode(body.toString(), Base64.DEFAULT); }
        catch (IllegalArgumentException invalid) { return null; }
    }

    private static String text(byte[] value) {
        return value == null ? null : new String(value, StandardCharsets.UTF_8).trim();
    }
}
