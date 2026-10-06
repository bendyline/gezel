# JNI entry points and both callbacks are resolved by their original names.
-keep class com.bendyline.gezel.llama.LlamaRuntime { *; }
-keep interface com.bendyline.gezel.llama.LlamaRuntime$Delta { *; }
-keepclassmembers class * implements com.bendyline.gezel.llama.LlamaRuntime$Delta {
    public boolean onDelta(byte[]);
}
-keep interface com.bendyline.gezel.llama.LlamaRuntime$Event { *; }
-keepclassmembers class * implements com.bendyline.gezel.llama.LlamaRuntime$Event {
    public boolean onEvent(byte[]);
}
