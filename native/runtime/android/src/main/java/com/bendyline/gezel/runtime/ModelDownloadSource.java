package com.bendyline.gezel.runtime;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import org.json.JSONObject;

/** Immutable catalog identity. No renderer URL or destination path is accepted. */
final class ModelDownloadSource {
    static final Set<String> KEYS = Set.of("catalogId", "catalogVersion", "sourceId", "huggingfaceRepo", "revision", "filename", "sha256");
    static JSONObject validate(JSONObject input, boolean exact) throws Exception {
        if (input == null) throw new IOException("A verified catalog model source is required");
        JSONObject result = new JSONObject();
        for (String key : KEYS) {
            Object raw = input.get(key);
            if (!(raw instanceof String)) throw new IOException("Invalid model source " + key);
            String value = (String) raw;
            int limit = key.equals("filename") ? 400 : key.equals("huggingfaceRepo") ? 200 : key.equals("catalogVersion") ? 80 : 160;
            if (value.isEmpty() || value.length() > limit || value.chars().anyMatch(c -> c < 32 || c == 127)) throw new IOException("Invalid model source " + key);
            result.put(key, value);
        }
        if (!result.getString("huggingfaceRepo").matches("[A-Za-z0-9_-][A-Za-z0-9_.-]*/[A-Za-z0-9_-][A-Za-z0-9_.-]*")
                || !result.getString("revision").matches("[a-f0-9]{40}") || !result.getString("sha256").matches("[a-f0-9]{64}"))
            throw new IOException("Model source must pin a repository revision and SHA-256");
        String filename = result.getString("filename");
        if (!filename.endsWith(".gguf") || filename.contains("\\")) throw new IOException("Expected a confined GGUF filename");
        for (String part : filename.split("/", -1)) if (part.isEmpty() || part.equals(".") || part.equals("..")) throw new IOException("Invalid GGUF filename");
        if (exact) {
            Object raw = input.get("sizeBytes");
            if (!(raw instanceof Number)) throw new IOException("An exact model length is required");
            double value = ((Number) raw).doubleValue();
            if (!Double.isFinite(value) || value < 4 || value > MobileModelStore.MAX_MODEL || value != Math.rint(value)) throw new IOException("Model must be between 4 bytes and 4 GiB");
            result.put("sizeBytes", (long) value);
        }
        return result;
    }
    static URI url(JSONObject source) throws Exception {
        StringBuilder path = new StringBuilder("https://huggingface.co/").append(source.getString("huggingfaceRepo"))
            .append("/resolve/").append(source.getString("revision")).append('/');
        String[] parts = source.getString("filename").split("/");
        for (int i = 0; i < parts.length; i++) {
            if (i > 0) path.append('/');
            path.append(URLEncoder.encode(parts[i], StandardCharsets.UTF_8.name()).replace("+", "%20"));
        }
        return new URI(path.toString());
    }
    static void validateURL(URI url) throws IOException {
        String host = url.getHost();
        if (!"https".equals(url.getScheme()) || url.getRawUserInfo() != null || url.getFragment() != null
                || (url.getPort() != -1 && url.getPort() != 443) || host == null
                || !(host.equals("huggingface.co") || host.endsWith(".huggingface.co") || host.equals("hf.co") || host.endsWith(".hf.co")))
            throw new IOException("Model download redirected outside its trusted HTTPS source");
    }
}
