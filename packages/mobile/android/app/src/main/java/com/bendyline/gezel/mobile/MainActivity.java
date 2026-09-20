package com.bendyline.gezel.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(GezelMobilePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
