package com.bendyline.gezel.mobile;

import com.bendyline.gezel.runtime.MobileModelStore;
import java.io.*;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

final class MobileStore extends MobileModelStore {
    final ProductFiles productFiles;
    MobileStore(File filesDir) throws IOException { this(filesDir, true); }
    MobileStore(File filesDir, boolean recoverModels) throws IOException {
        super(new File(filesDir.getCanonicalFile(), "gezel"), recoverModels);
        productFiles = new ProductFiles(new File(root, "product"));
    }
    synchronized String readState() throws Exception {
        byte[] bytes = readDocument("state.json", MAX_STATE);
        if (bytes == null) return null;
        String text = decode(bytes);
        new JSONObject(text);
        return text;
    }

    synchronized void writeState(String text) throws Exception {
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_STATE) throw new IOException("State exceeds the 16 MB limit");
        new JSONObject(text);
        atomicWrite(new File(root, "state.json"), bytes);
    }

}
