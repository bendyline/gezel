package com.bendyline.gezel.mobile;

import static org.junit.Assert.*;
import android.app.Instrumentation;
import android.content.Intent;
import android.os.SystemClock;
import android.webkit.WebView;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONTokener;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public final class PreviewBoundaryTest {
    @Test public void authoredFramesHaveNoNativeOrNetworkAuthority() throws Exception {
        Instrumentation instrumentation=InstrumentationRegistry.getInstrumentation();
        Intent launch=new Intent(instrumentation.getTargetContext(),MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        MainActivity activity=(MainActivity)instrumentation.startActivitySync(launch);
        WebView view=activity.getBridge().getWebView();
        try {
            long until=SystemClock.elapsedRealtime()+60000;
            while(SystemClock.elapsedRealtime()<until&&!Boolean.TRUE.equals(evaluate(instrumentation,view,"Boolean(window.__GEZEL__ && window.Capacitor?.Plugins?.GezelMobile)")))Thread.sleep(100);
            assertEquals(true,evaluate(instrumentation,view,"Boolean(window.__GEZEL__)"));
            String source;
            try(java.io.InputStream input=instrumentation.getContext().getAssets().open("mobile-preview-security.js")) {java.io.ByteArrayOutputStream out=new java.io.ByteArrayOutputStream();byte[] buffer=new byte[8192];int n;while((n=input.read(buffer))!=-1)out.write(buffer,0,n);source=out.toString(StandardCharsets.UTF_8.name());}
            evaluate(instrumentation,view,source+";runMobilePreviewSecurity().then(r=>window.__previewResult=JSON.stringify(r),e=>window.__previewResult=JSON.stringify({error:String(e)}));true;");
            Object result=null;until=SystemClock.elapsedRealtime()+20000;
            while(SystemClock.elapsedRealtime()<until) {result=evaluate(instrumentation,view,"window.__previewResult||null");if(result instanceof String)break;Thread.sleep(100);}
            assertTrue(String.valueOf(result),result instanceof String && new org.json.JSONObject((String)result).optBoolean("ok"));
        } finally {instrumentation.runOnMainSync(activity::finish);}
    }
    private static Object evaluate(Instrumentation instrumentation,WebView view,String source) throws Exception {
        CountDownLatch done=new CountDownLatch(1);AtomicReference<String> value=new AtomicReference<>();
        instrumentation.runOnMainSync(()->view.evaluateJavascript(source,result->{value.set(result);done.countDown();}));
        assertTrue("JavaScript evaluation timed out",done.await(10,TimeUnit.SECONDS));return new JSONTokener(value.get()).nextValue();
    }
}
