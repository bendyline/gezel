package com.bendyline.gezel.consumer;

import android.app.Activity;
import android.os.Bundle;
import android.widget.TextView;
import com.bendyline.gezel.llama.LlamaRuntime;
import java.io.File;
import java.nio.charset.StandardCharsets;

/** Package smoke consumer; optional fixture.gguf is the deterministic test model. */
public final class MainActivity extends Activity {
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        TextView status = new TextView(this);
        status.setText("Loading prebuilt Gezel runtime");
        setContentView(status);
        new Thread(() -> {
            String result;
            try {
                long engine = LlamaRuntime.create();
                if (engine == 0) throw new IllegalStateException("Could not allocate engine");
                try {
                    File fixture = new File(getFilesDir(), "fixture.gguf");
                    if (fixture.isFile()) {
                        LlamaRuntime.load(engine, fixture.getPath(), 1, 512);
                        StringBuilder text = new StringBuilder();
                        int finish = LlamaRuntime.generate(engine, new String[]{"user"},
                            new String[]{"Hello"}, 2, 8, bytes -> {
                                text.append(new String(bytes, StandardCharsets.UTF_8));
                                return true;
                            });
                        if (finish != 2 || !text.toString().equals("aaaaaaaa"))
                            throw new IllegalStateException("Unexpected fixture inference result");
                        result = "Prebuilt Gezel inference passed";
                    } else {
                        result = "Prebuilt Gezel runtime loaded (no fixture model)";
                    }
                } finally { LlamaRuntime.destroy(engine); }
            } catch (Throwable error) { result = "Failed: " + error; }
            String message = result;
            runOnUiThread(() -> status.setText(message));
        }, "gezel-smoke").start();
    }
}
