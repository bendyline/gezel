package com.bendyline.gezel.mobile;

import android.content.ContentResolver;
import android.database.Cursor;
import android.net.Uri;
import android.os.SystemClock;
import android.provider.OpenableColumns;
import android.util.AtomicFile;
import com.getcapacitor.JSObject;
import java.io.*;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;

/** App-private state; caller-provided model IDs are looked up, never used as paths. */
final class MobileStore {
    static final int MAX_STATE = 16 * 1024 * 1024;
    static final int MAX_LIBRARY = 1024 * 1024;
    static final int MAX_MODELS = 100;
    static final long MAX_MODEL = 4L * 1024 * 1024 * 1024;
    private static final long DISK_RESERVE = 64L * 1024 * 1024;
    private final File root;
    private final File models;

    MobileStore(File filesDir) throws IOException {
        // Android may expose its trusted app directory through /data/data while
        // the actual directory lives under /data/user/0 (or the reverse).
        root = new File(filesDir.getCanonicalFile(), "gezel");
        models = new File(root, "models");
        requireUnaliased(root);
        requireUnaliased(models);
        if (!models.isDirectory() && !models.mkdirs()) throw new IOException("Cannot create model storage");
        File[] files = models.listFiles();
        if (files != null) for (File file : files) if (file.getName().endsWith(".partial")) file.delete();
    }

    private static void requireUnaliased(File file) throws IOException {
        if (Files.isSymbolicLink(file.toPath()) || !file.getCanonicalFile().equals(file.getAbsoluteFile()))
            throw new IOException("Storage path is invalid");
    }

    private static String decode(byte[] bytes) throws IOException {
        return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
    }

    private byte[] readDocument(String name, int maximum) throws IOException {
        AtomicFile file = new AtomicFile(new File(root, name));
        try (FileInputStream input = file.openRead(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            if (input.getChannel().size() > maximum) throw new IOException("Saved document exceeds its size limit");
            byte[] buffer = new byte[8192];
            int count, total = 0;
            while ((count = input.read(buffer)) != -1) {
                total += count;
                if (total > maximum) throw new IOException("Saved document exceeds its size limit");
                output.write(buffer, 0, count);
            }
            return output.toByteArray();
        } catch (FileNotFoundException error) {
            // openRead must restore .bak before deciding a document is absent.
            if (!file.getBaseFile().exists() && !new File(file.getBaseFile().getPath() + ".bak").exists()) return null;
            throw error;
        }
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

    private void atomicWrite(File destination, byte[] bytes) throws IOException {
        AtomicFile file = new AtomicFile(destination);
        FileOutputStream output = null;
        try {
            output = file.startWrite();
            output.write(bytes);
            file.finishWrite(output);
        } catch (IOException | RuntimeException error) {
            file.failWrite(output);
            throw error;
        }
    }

    static JSONObject validateLibrary(JSONObject value) throws Exception {
        JSONArray entries = value.getJSONArray("models");
        if (entries.length() > MAX_MODELS) throw new IOException("The model library exceeds its limit");
        Set<String> ids = new HashSet<>();
        JSONArray clean = new JSONArray();
        for (int index = 0; index < entries.length(); index++) {
            JSONObject model = entries.getJSONObject(index);
            Object idValue = model.get("id"), nameValue = model.get("name"), sizeValue = model.get("sizeBytes");
            if (!(idValue instanceof String) || !(nameValue instanceof String) || !(sizeValue instanceof Number))
                throw new IOException("Invalid model library");
            String id = (String) idValue, name = (String) nameValue;
            double size = ((Number) sizeValue).doubleValue();
            if (!UUID.fromString(id).toString().equals(id) || !ids.add(id) || name.isEmpty() || name.length() > 200
                    || !Double.isFinite(size) || size < 4 || size > MAX_MODEL || size != Math.rint(size))
                throw new IOException("Invalid model library");
            clean.put(new JSONObject().put("id", id).put("name", name).put("sizeBytes", (long) size));
        }
        JSONObject result = new JSONObject().put("models", clean);
        if (value.has("selectedModelId")) {
            Object selected = value.get("selectedModelId");
            if (!(selected instanceof String) || !ids.contains((String) selected)) throw new IOException("Invalid selected model");
            result.put("selectedModelId", selected);
        }
        return result;
    }

    private JSONObject library() throws Exception {
        byte[] bytes = readDocument("models.json", MAX_LIBRARY);
        if (bytes == null) return new JSONObject().put("models", new JSONArray());
        return validateLibrary(new JSONObject(decode(bytes)));
    }

    private void writeLibrary(JSONObject value) throws Exception {
        byte[] bytes = validateLibrary(value).toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_LIBRARY) throw new IOException("The model library exceeds its size limit");
        atomicWrite(new File(root, "models.json"), bytes);
    }

    synchronized JSObject listModels() throws Exception { return JSObject.fromJSONObject(library()); }

    synchronized JSObject selectModel(String id) throws Exception {
        JSONObject library = library();
        JSONObject model = findModel(library, id);
        checkedPath(model);
        library.put("selectedModelId", id);
        writeLibrary(library);
        return JSObject.fromJSONObject(model);
    }

    synchronized void removeModel(String id) throws Exception {
        JSONObject library = library();
        findModel(library, id);
        File file = modelPath(id);
        JSONArray kept = new JSONArray(), entries = library.getJSONArray("models");
        for (int index = 0; index < entries.length(); index++) {
            JSONObject model = entries.getJSONObject(index);
            if (!model.getString("id").equals(id)) kept.put(model);
        }
        library.put("models", kept);
        if (id.equals(library.optString("selectedModelId"))) library.remove("selectedModelId");
        // Commit removal before deleting bytes. A crash may leave an unlisted
        // file, but can never silently select a different model or lose history.
        writeLibrary(library);
        Files.deleteIfExists(file.toPath());
    }

    private JSONObject findModel(JSONObject library, String id) throws Exception {
        JSONArray list = library.getJSONArray("models");
        for (int index = 0; index < list.length(); index++) {
            JSONObject model = list.getJSONObject(index);
            if (model.getString("id").equals(id)) return model;
        }
        throw new IOException("This model is unavailable. Import it again.");
    }

    private File modelPath(String id) throws IOException {
        if (!UUID.fromString(id).toString().equals(id)) throw new IOException("Invalid model ID");
        File file = new File(models, id + ".gguf");
        requireUnaliased(file);
        return file;
    }

    private File checkedPath(JSONObject model) throws Exception {
        File file = modelPath(model.getString("id"));
        if (!file.isFile() || file.length() != model.getLong("sizeBytes") || file.length() < 4 || file.length() > MAX_MODEL)
            throw new IOException("Model is unavailable or its file has changed");
        try (DataInputStream input = new DataInputStream(new FileInputStream(file))) {
            if (input.readInt() != 0x47475546) throw new IOException("Model is not a GGUF file");
        }
        return file;
    }

    synchronized String[] selectedModel() throws Exception {
        JSONObject library = library();
        JSONObject model = findModel(library, library.optString("selectedModelId", ""));
        return new String[] { model.getString("id"), checkedPath(model).getAbsolutePath() };
    }

    synchronized JSObject importModel(ContentResolver resolver, Uri uri) throws Exception {
        JSONObject library = library();
        if (library.getJSONArray("models").length() >= MAX_MODELS) throw new IOException("Remove a model before importing another");
        String name = "model.gguf";
        long advertisedSize = -1;
        try (Cursor cursor = resolver.query(uri, new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int display = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME), size = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (display >= 0) name = cursor.getString(display);
                if (size >= 0 && !cursor.isNull(size)) advertisedSize = cursor.getLong(size);
            }
        }
        if (name == null || !name.toLowerCase(java.util.Locale.ROOT).endsWith(".gguf")) throw new IOException("Choose a GGUF model file");
        if (advertisedSize > MAX_MODEL || (advertisedSize >= 0 && advertisedSize < 4)) throw new IOException("This model is outside the 4 GB limit");
        if (models.getUsableSpace() < DISK_RESERVE + Math.max(4, advertisedSize)) throw new IOException("Not enough storage to import this model");
        String id = UUID.randomUUID().toString();
        File partial = new File(models, id + ".partial"), target = modelPath(id);
        long started = SystemClock.elapsedRealtime();
        try {
            try (InputStream input = resolver.openInputStream(uri); FileOutputStream output = new FileOutputStream(partial)) {
                if (input == null) throw new IOException("The selected document is unavailable");
                byte[] magic = new byte[4];
                new DataInputStream(input).readFully(magic);
                if (!java.util.Arrays.equals(magic, new byte[] { 'G', 'G', 'U', 'F' })) throw new IOException("Choose a GGUF model file");
                output.write(magic);
                byte[] buffer = new byte[64 * 1024];
                long total = magic.length;
                int count;
                while ((count = input.read(buffer)) != -1) {
                    total += count;
                    if (total > MAX_MODEL) throw new IOException("This model exceeds the current 4 GB limit");
                    if (SystemClock.elapsedRealtime() - started > 300_000) throw new IOException("The model import took too long");
                    if (models.getUsableSpace() < DISK_RESERVE + count) throw new IOException("Not enough storage to finish importing this model");
                    output.write(buffer, 0, count);
                }
                output.getFD().sync();
            }
            String displayName = name.substring(0, Math.min(name.length(), 200));
            if (!displayName.isEmpty() && Character.isHighSurrogate(displayName.charAt(displayName.length() - 1))) displayName = displayName.substring(0, displayName.length() - 1);
            JSONObject model = new JSONObject().put("id", id).put("name", displayName).put("sizeBytes", partial.length());
            library.getJSONArray("models").put(model);
            // Importing never chooses a replacement after a selected model was removed.
            if (!partial.renameTo(target)) throw new IOException("Cannot publish imported model");
            try { writeLibrary(library); }
            catch (Exception error) { target.delete(); throw error; }
            return JSObject.fromJSONObject(model);
        } finally { partial.delete(); }
    }
}
