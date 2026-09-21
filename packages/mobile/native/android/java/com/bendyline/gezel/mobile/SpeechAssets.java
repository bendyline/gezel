package com.bendyline.gezel.mobile;

import android.content.Context;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Iterator;
import org.json.*;

/** Bundled assets are staged with hashes at build time, then checked before
 * native code reads them. Model storage never enters the product file tree. */
final class SpeechAssets {
    private final Context context;
    private final File root;
    private boolean verified;
    SpeechAssets(Context context) { this.context = context; root = new File(context.getNoBackupFilesDir(), "speech-v1"); }
    JSONArray voices() throws Exception {
        try (InputStream stream = context.getAssets().open("speech/voices.json")) {
            return new JSONArray(new String(read(stream), StandardCharsets.UTF_8));
        }
    }
    JSONObject models() throws Exception {
        try (InputStream stream = context.getAssets().open("speech/pack.json")) {
            return new JSONObject(new String(read(stream), StandardCharsets.UTF_8));
        }
    }
    boolean bundled() {
        try (InputStream stream = context.getAssets().open("speech/manifest.json")) { return stream.read() >= 0; }
        catch (IOException unavailable) { return false; }
    }
    File ensure() throws Exception {
        if (verified) return root;
        JSONObject manifest;
        try (InputStream stream = context.getAssets().open("speech/manifest.json")) {
            manifest = new JSONObject(new String(read(stream), StandardCharsets.UTF_8));
        }
        for (Iterator<String> entries = manifest.keys(); entries.hasNext();) {
            String name = entries.next();
            if (name.startsWith("/") || name.contains("\\") || name.contains("..")) throw new IOException("Invalid speech asset path");
            File file = new File(root, name);
            if (!file.getCanonicalPath().startsWith(root.getCanonicalPath() + File.separator)) throw new IOException("Invalid speech asset path");
            if (file.isFile() && hash(file).equals(manifest.getString(name))) continue;
            if (!file.getParentFile().isDirectory() && !file.getParentFile().mkdirs()) throw new IOException("Cannot create speech model storage");
            File temporary = File.createTempFile("speech-", ".partial", file.getParentFile());
            try {
                try (InputStream src = context.getAssets().open("speech/" + name); OutputStream out = new FileOutputStream(temporary)) { copy(src, out); }
                if (!hash(temporary).equals(manifest.getString(name))) throw new IOException("Speech model verification failed");
                java.nio.file.Files.move(temporary.toPath(), file.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING, java.nio.file.StandardCopyOption.ATOMIC_MOVE);
            } finally { temporary.delete(); }
        }
        verified = true; return root;
    }
    private static String hash(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream stream = new FileInputStream(file)) {
            byte[] buffer = new byte[65536]; int count;
            while ((count = stream.read(buffer)) >= 0) digest.update(buffer, 0, count);
        }
        StringBuilder result = new StringBuilder(); for (byte value : digest.digest()) result.append(String.format("%02x", value & 255));
        return result.toString();
    }
    private static void copy(InputStream input, OutputStream output) throws IOException {
        byte[] buffer = new byte[65536]; int count;
        while ((count = input.read(buffer)) >= 0) output.write(buffer, 0, count);
    }
    private static byte[] read(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream(); copy(input, output); return output.toByteArray();
    }
}
