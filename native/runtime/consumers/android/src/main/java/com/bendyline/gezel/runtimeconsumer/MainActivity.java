package com.bendyline.gezel.runtimeconsumer;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.bendyline.gezel.capacitor.GezelRuntimePlugin;

/** Isolated consumer: no Gezel app sources, CMake project, speech, or product state. */
public final class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(GezelRuntimePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
