package com.bendyline.gezel.mobile;

import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.MessageHandler;
import java.nio.charset.StandardCharsets;
import java.util.Collections;

public final class PreviewBoundary {
    private PreviewBoundary() {}
    public static void install(Bridge bridge, PreviewSnapshots snapshots) throws Exception {
        WebView view = bridge.getWebView();
        // These legacy interfaces have no frame identity, even if their plugin
        // is disabled. Never leave them reachable from authored documents.
        view.removeJavascriptInterface("androidBridge");
        view.removeJavascriptInterface("CapacitorCookiesAndroidInterface");
        view.removeJavascriptInterface("CapacitorHttpAndroidInterface");
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) throw new IllegalStateException("Update Android System WebView to open Gezel safely");
        WebViewCompat.removeWebMessageListener(view, "androidBridge");
        MessageHandler dispatcher = new MessageHandler(bridge, view, null);
        WebViewCompat.removeWebMessageListener(view, "androidBridge");
        view.removeJavascriptInterface("androidBridge");
        WebViewCompat.addWebMessageListener(view, "androidBridge", Collections.singleton("https://localhost"), (sender, message, origin, mainFrame, reply) -> {
            if (!mainFrame || !"https".equals(origin.getScheme()) || !"localhost".equals(origin.getHost()) || !PreviewSnapshots.packaged(Uri.parse(sender.getUrl() == null ? "" : sender.getUrl()))) return;
            try { if (new org.json.JSONObject(message.getData()).optString("type").equals("cordova")) return; } catch (Exception error) { return; }
            dispatcher.postMessage(message.getData());
        });
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            String script;
            try (java.io.InputStream input = view.getContext().getAssets().open("public/preview-isolation.js")) {
                java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream(); byte[] buffer = new byte[4096]; int length;
                while ((length = input.read(buffer)) != -1) bytes.write(buffer, 0, length);
                script = bytes.toString(StandardCharsets.UTF_8.name());
            }
            WebViewCompat.addDocumentStartJavaScript(view, script, Collections.singleton("*"));
            snapshots.available = true;
        }
        bridge.setWebViewClient(new BridgeWebViewClient(bridge) {
            @Override public WebResourceResponse shouldInterceptRequest(WebView webView, WebResourceRequest request) {
                if (PreviewSnapshots.reserved(request.getUrl())) return snapshots.response(request.getUrl(), request.isForMainFrame(), request.getMethod());
                return super.shouldInterceptRequest(webView, request);
            }
            @Override public boolean shouldOverrideUrlLoading(WebView webView, WebResourceRequest request) {
                if (PreviewSnapshots.reserved(request.getUrl())) return request.isForMainFrame() || !snapshots.available;
                if (!request.isForMainFrame()) return true;
                return !PreviewSnapshots.packaged(request.getUrl()) || super.shouldOverrideUrlLoading(webView, request);
            }
        });
    }
}
