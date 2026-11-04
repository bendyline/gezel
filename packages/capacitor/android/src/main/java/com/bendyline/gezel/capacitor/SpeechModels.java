package com.bendyline.gezel.capacitor;

import android.content.Context;
import android.util.AtomicFile;
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.CancellationException;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Downloaded model files in app-private, no-backup storage (speech models and
 * knowledge catalogs, each in its own store): one folder per model,
 * declared files only, each verified against its SHA-256 before the model
 * counts as installed. JavaScript names models and files; it never supplies
 * paths, and every path is checked to stay inside the store.
 */
final class SpeechModels {
    static final class Failure extends IOException {
        final String code;
        Failure(String code, String message) { super(message); this.code = code; }
    }
    interface Progress { void update(long received, long total); }

    private static final Pattern ID = Pattern.compile("[a-z0-9][a-z0-9._-]{0,63}");
    private static final Pattern SEGMENT = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._-]{0,127}");
    private static final Pattern SHA256 = Pattern.compile("[0-9a-f]{64}");
    private static final String MARKER = "installed.json";
    private final File root;
    private final long maxFile;
    private volatile boolean cancelled;
    private volatile HttpURLConnection connection;

    SpeechModels(Context context) { this(new File(context.getNoBackupFilesDir(), "gezel-speech/models"), 1L << 30); }
    SpeechModels(File root, long maxFile) { this.root = root; this.maxFile = maxFile; }
    File root() { return root; }

    static String id(String value) throws IOException {
        if (value == null || !ID.matcher(value).matches()) throw new Failure("invalid-input", "Invalid speech model");
        return value;
    }
    static String name(String value) throws IOException {
        if (value == null || value.length() > 256) throw new Failure("invalid-input", "Invalid speech model file");
        String[] parts = value.split("/", -1);
        if (parts.length > 3) throw new Failure("invalid-input", "Invalid speech model file");
        for (String part : parts) if (!SEGMENT.matcher(part).matches() || part.endsWith(".part")) throw new Failure("invalid-input", "Invalid speech model file");
        return value;
    }
    private File inside(File folder, String relative) throws IOException {
        File file = new File(folder, relative);
        if (!file.getCanonicalPath().startsWith(folder.getCanonicalPath() + File.separator)) throw new Failure("invalid-input", "Invalid speech model file");
        return file;
    }
    private File folder(String model) throws IOException {
        File folder = new File(root, id(model));
        if (Files.isSymbolicLink(folder.toPath())) throw new Failure("failed", "Invalid speech model storage");
        return folder;
    }
    private static JSONObject read(File file) throws Exception {
        try (FileInputStream input = new AtomicFile(file).openRead()) {
            long size = input.getChannel().size();
            if (size > 64 * 1024) throw new IOException("Speech model record exceeds its limit");
            byte[] bytes = new byte[(int) size];
            new DataInputStream(input).readFully(bytes);
            return new JSONObject(new String(bytes, StandardCharsets.UTF_8));
        }
    }
    /** Installed files by name, or null when the model is not installed. */
    private Map<String, String> installed(String model) throws Exception {
        File marker = new File(folder(model), MARKER);
        if (!marker.isFile()) return null;
        JSONObject files = read(marker).getJSONObject("files");
        Map<String, String> result = new TreeMap<>();
        for (Iterator<String> names = files.keys(); names.hasNext();) { String name = names.next(); result.put(name(name), files.getString(name)); }
        return result;
    }
    /** A verified file of an installed model. */
    synchronized File file(String model, String relative) throws Exception {
        Map<String, String> files = installed(model);
        if (files == null) throw new Failure("model-missing", "Download this speech model first");
        if (!files.containsKey(name(relative))) throw new Failure("invalid-input", "This file is not part of the installed model");
        File file = inside(folder(model), relative);
        if (!file.isFile()) throw new Failure("model-missing", "The speech model is incomplete; download it again");
        return file;
    }
    synchronized JSONArray list() throws Exception {
        JSONArray models = new JSONArray();
        File[] folders = root.listFiles();
        if (folders == null) return models;
        for (File folder : folders) {
            if (!folder.isDirectory() || !ID.matcher(folder.getName()).matches()) continue;
            Map<String, String> files = installed(folder.getName());
            if (files != null) models.put(new JSONObject().put("id", folder.getName()).put("files", new JSONArray(files.keySet())));
        }
        return models;
    }
    synchronized void remove(String model) throws Exception {
        File folder = folder(model);
        if (folder.exists()) delete(folder);
    }
    private static void delete(File file) throws IOException {
        if (file.isDirectory() && !Files.isSymbolicLink(file.toPath())) for (File child : Objects.requireNonNull(file.listFiles())) delete(child);
        Files.deleteIfExists(file.toPath());
    }
    void cancel() { cancelled = true; HttpURLConnection current = connection; if (current != null) current.disconnect(); }

    /**
     * Download and verify every file, resuming any partial file from where it
     * stopped. A file that fails verification is deleted so the next attempt
     * starts clean. Runs on the caller's thread; {@link #cancel()} stops it.
     */
    void install(String model, JSONArray specs, Progress progress) throws Exception {
        cancelled = false;
        File folder = folder(model);
        long total = 0;
        List<JSONObject> files = new ArrayList<>();
        Map<String, String> expected = new TreeMap<>();
        if (specs == null || specs.length() == 0 || specs.length() > 64) throw new Failure("invalid-input", "Invalid speech model files");
        for (int i = 0; i < specs.length(); i++) {
            JSONObject spec = specs.getJSONObject(i);
            String name = name(spec.getString("name")), sha = spec.getString("sha256"), url = spec.getString("url");
            long size = spec.getLong("size");
            if (!SHA256.matcher(sha).matches() || size < 1 || size > maxFile || !url.startsWith("https://huggingface.co/") || expected.put(name, sha) != null)
                throw new Failure("invalid-input", "Invalid speech model files");
            files.add(spec);
            total += size;
        }
        final long all = total;
        synchronized (this) {
            if (!folder.isDirectory() && !folder.mkdirs()) throw new Failure("storage", "Cannot create speech model storage");
            Files.deleteIfExists(new File(folder, MARKER).toPath());
        }
        long missing = 0;
        for (JSONObject spec : files) {
            File target = inside(folder, spec.getString("name")), partial = new File(target.getPath() + ".part");
            missing += spec.getLong("size") - (target.isFile() ? target.length() : partial.isFile() ? partial.length() : 0);
        }
        if (folder.getUsableSpace() < missing + 64L * 1024 * 1024) throw new Failure("storage", "Not enough storage for this speech model");
        long done = 0;
        for (JSONObject spec : files) {
            String name = spec.getString("name"), sha = spec.getString("sha256");
            long size = spec.getLong("size");
            File target = inside(folder, name), partial = new File(target.getPath() + ".part");
            File parent = target.getParentFile();
            if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new Failure("storage", "Cannot create speech model storage");
            if (!(target.isFile() && target.length() == size && sha.equals(digest(target)))) {
                Files.deleteIfExists(target.toPath());
                final long before = done;
                transfer(new URL(spec.getString("url")), partial, size, received -> progress.update(before + received, all));
                if (cancelled) throw new CancellationException();
                if (!sha.equals(digest(partial))) {
                    Files.deleteIfExists(partial.toPath());
                    throw new Failure("verification", "The downloaded speech model was damaged, so it was not installed");
                }
                if (!partial.renameTo(target)) throw new Failure("storage", "Cannot save the speech model");
            }
            done += size;
            progress.update(done, all);
        }
        synchronized (this) {
            AtomicFile marker = new AtomicFile(new File(folder, MARKER));
            FileOutputStream output = null;
            try {
                output = marker.startWrite();
                output.write(new JSONObject().put("files", new JSONObject(expected)).toString().getBytes(StandardCharsets.UTF_8));
                marker.finishWrite(output);
            } catch (Exception error) { marker.failWrite(output); throw error; }
        }
    }
    private interface Received { void update(long received); }
    private void transfer(URL url, File partial, long size, Received progress) throws Exception {
        long have = partial.isFile() ? partial.length() : 0;
        if (have > size) { Files.deleteIfExists(partial.toPath()); have = 0; }
        if (have == size) return;
        HttpURLConnection http = (HttpURLConnection) url.openConnection();
        connection = http;
        try {
            if (cancelled) throw new CancellationException();
            http.setConnectTimeout(30_000);
            http.setReadTimeout(60_000);
            http.setRequestProperty("Accept-Encoding", "identity");
            if (have > 0) http.setRequestProperty("Range", "bytes=" + have + "-");
            int status;
            try { status = http.getResponseCode(); }
            catch (IOException error) { if (cancelled) throw new CancellationException(); throw new Failure("interrupted", error.getMessage() == null ? "The connection failed" : error.getMessage()); }
            boolean append = status == 206 && have > 0;
            if (status != 200 && !append) {
                if (status == 416) { Files.deleteIfExists(partial.toPath()); throw new Failure("interrupted", "The download must restart"); }
                throw new Failure(status == 408 || status == 429 || status >= 500 ? "interrupted" : "failed", "Speech model download failed (HTTP " + status + ")");
            }
            if (!append) have = 0;
            byte[] buffer = new byte[1 << 20];
            long last = 0;
            try (InputStream input = http.getInputStream(); FileOutputStream output = new FileOutputStream(partial, append)) {
                for (int read; (read = input.read(buffer)) > 0;) {
                    if (cancelled) throw new CancellationException();
                    have += read;
                    if (have > size) throw new Failure("verification", "The speech model is larger than expected");
                    output.write(buffer, 0, read);
                    long now = System.nanoTime();
                    if (now - last > 250_000_000L) { last = now; progress.update(have); }
                }
                output.getFD().sync();
            } catch (IOException error) {
                if (cancelled) throw new CancellationException();
                if (error instanceof Failure) throw error;
                throw new Failure("interrupted", error.getMessage() == null ? "The download stopped" : error.getMessage());
            }
            if (have != size) throw new Failure("interrupted", "The download ended early");
            progress.update(have);
        } finally {
            connection = null;
            http.disconnect();
        }
    }
    private static String digest(File file) throws Exception {
        MessageDigest sha = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[1 << 20];
        try (InputStream input = new FileInputStream(file)) { for (int read; (read = input.read(buffer)) > 0;) sha.update(buffer, 0, read); }
        StringBuilder hex = new StringBuilder();
        for (byte value : sha.digest()) hex.append(String.format("%02x", value));
        return hex.toString();
    }
}
