package com.bendyline.gezel.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    final PreviewSnapshots previewSnapshots = new PreviewSnapshots();
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(GezelMobilePlugin.class);
        registerPlugin(GezelSpeechPlugin.class);
        super.onCreate(savedInstanceState);
        try { PreviewBoundary.install(bridge, previewSnapshots); installBackNavigation(); }
        catch (Exception error) {
            bridge.getWebView().stopLoading();
            android.widget.TextView message = new android.widget.TextView(this);
            message.setText("Gezel could not establish its safe page boundary. Update Android System WebView, then reopen the app.");
            message.setPadding(24, 48, 24, 24); setContentView(message);
        }
    }
    private void installBackNavigation() {
        getOnBackPressedDispatcher().addCallback(this, new androidx.activity.OnBackPressedCallback(true) {
            private long sequence;
            private boolean pending;
            private final android.os.Handler main = new android.os.Handler(android.os.Looper.getMainLooper());
            private void fallBack(long request) {
                if (!pending || sequence != request || isFinishing() || isDestroyed()) return;
                pending = false;
                setEnabled(false);
                try { getOnBackPressedDispatcher().onBackPressed(); }
                finally { if (!isFinishing() && !isDestroyed()) setEnabled(true); }
            }
            @Override public void handleOnBackPressed() {
                if (pending || isFinishing() || isDestroyed()) return;
                pending = true;
                long request = ++sequence;
                android.webkit.WebView view = bridge.getWebView();
                if (!PreviewSnapshots.packaged(android.net.Uri.parse(view.getUrl() == null ? "" : view.getUrl()))) { fallBack(request); return; }
                // A stalled renderer must not trap the system Back button. The
                // request token also ignores late replies after native fallback.
                Runnable timeout = () -> fallBack(request);
                main.postDelayed(timeout, 1000);
                try {
                    view.evaluateJavascript("!window.dispatchEvent(new CustomEvent('gezel:back',{cancelable:true}))", result -> {
                        main.removeCallbacks(timeout);
                        if (!pending || request != sequence || isFinishing() || isDestroyed()) return;
                        if ("true".equals(result)) pending = false;
                        else fallBack(request);
                    });
                } catch (RuntimeException error) { main.removeCallbacks(timeout); fallBack(request); }
            }
        });
    }

}
