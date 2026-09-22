package com.bendyline.gezel.runtime;

import org.json.JSONException;
import org.json.JSONObject;

/** JSON results constructed by trusted native code, independent of WebView frameworks. */
public final class NativeObject extends JSONObject {
    @Override public NativeObject put(String key, Object value) {
        try { super.put(key, value); return this; }
        catch (JSONException error) { throw new IllegalArgumentException(error); }
    }
    @Override public NativeObject put(String key, boolean value) { return put(key, Boolean.valueOf(value)); }
    @Override public NativeObject put(String key, int value) { return put(key, Integer.valueOf(value)); }
    @Override public NativeObject put(String key, long value) { return put(key, Long.valueOf(value)); }
    @Override public NativeObject put(String key, double value) { return put(key, Double.valueOf(value)); }
    public static NativeObject fromJSONObject(JSONObject value) {
        NativeObject copy = new NativeObject();
        for (var keys = value.keys(); keys.hasNext();) { String key = keys.next(); copy.put(key, value.opt(key)); }
        return copy;
    }
}
