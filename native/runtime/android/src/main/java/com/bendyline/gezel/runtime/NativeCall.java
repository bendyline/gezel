package com.bendyline.gezel.runtime;

import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONArray;
import org.json.JSONObject;

/** Native request/reply boundary usable by Java/Kotlin and thin bridge adapters. */
public final class NativeCall {
    public interface Reply {
        void resolve(JSONObject value);
        void reject(String message, String code);
    }
    private final JSONObject input;
    private final Reply reply;
    private final AtomicBoolean settled = new AtomicBoolean();
    public NativeCall(JSONObject input, Reply reply) { this.input = input; this.reply = reply; }
    public boolean contains(String key) { return input.has(key); }
    public String getString(String key) { Object value = input.opt(key); return value instanceof String ? (String)value : null; }
    public String getString(String key, String fallback) { String value = getString(key); return value == null ? fallback : value; }
    public Integer getInt(String key) {
        Object value = input.opt(key);
        if (!(value instanceof Number)) return null;
        double number = ((Number)value).doubleValue();
        return Double.isFinite(number) && number == Math.rint(number) && number >= Integer.MIN_VALUE && number <= Integer.MAX_VALUE ? (int)number : null;
    }
    public int getInt(String key, int fallback) { Integer value = getInt(key); return value == null ? fallback : value; }
    public JSONObject getObject(String key) { return input.optJSONObject(key); }
    public JSONArray getArray(String key) { return input.optJSONArray(key); }
    public void resolve() { resolve(new NativeObject()); }
    public void resolve(JSONObject value) { if (settled.compareAndSet(false, true)) reply.resolve(value); }
    public void reject(String message) { reject(message, "native_error"); }
    public void reject(String message, String code) { if (settled.compareAndSet(false, true)) reply.reject(message, code); }
}
