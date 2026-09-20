package com.bendyline.gezel.mobile;

import static org.junit.Assert.*;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Stream;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Runs the production JNI and llama.cpp libraries, not a mock model runtime. */
@RunWith(AndroidJUnit4.class)
public final class LlamaRuntimeTest {
    private static final int FINISH_LENGTH = 2;
    private static final int FINISH_CANCELLED = 3;
    private static final String[] ROLES = { "system", "user" };
    private static final String[] CONTENTS = { "Brief replies.", "Hello \uD83D\uDE00" };
    private File folder;
    private File fixture;
    private long engine;
    private long requestId;

    @Before public void setup() throws Exception {
        File cache = InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir();
        folder = Files.createTempDirectory(cache.toPath(), "llama-runtime-test-").toFile();
        fixture = new File(folder, "model-\u6A21\u578B-\uD83D\uDE00.gguf");
        try (InputStream input = InstrumentationRegistry.getInstrumentation().getContext()
                .getAssets().open("fixtures/deterministic-native.gguf")) {
            Files.copy(input, fixture.toPath());
        }
        engine = LlamaRuntime.create();
        assertNotEquals("The native engine must load on this Android ABI", 0L, engine);
    }

    @After public void cleanup() throws Exception {
        if (engine != 0) LlamaRuntime.destroy(engine);
        if (folder != null) try (Stream<Path> paths = Files.walk(folder.toPath())) {
            for (Path path : (Iterable<Path>) paths.sorted(Comparator.reverseOrder())::iterator)
                Files.deleteIfExists(path);
        }
    }

    private long nextRequest() { return ++requestId; }
    private void load() { LlamaRuntime.load(engine, fixture.getAbsolutePath(), nextRequest(), 512); }
    private void assertEightTokens() {
        StringBuilder text = new StringBuilder();
        AtomicInteger chunks = new AtomicInteger();
        int finish = LlamaRuntime.generate(engine, ROLES, CONTENTS, nextRequest(), 8, bytes -> {
            text.append(new String(bytes, StandardCharsets.UTF_8));
            chunks.incrementAndGet();
            return true;
        });
        assertEquals(FINISH_LENGTH, finish);
        assertEquals("aaaaaaaa", text.toString());
        assertTrue("Generation must stream multiple native callbacks", chunks.get() > 1);
    }

    @Test public void loadsUnicodePathStreamsAndReusesFreshTranscript() {
        load();
        assertEightTokens();
        StringBuilder text = new StringBuilder();
        assertEquals(FINISH_LENGTH, LlamaRuntime.generate(engine,
            new String[] { "user", "assistant", "user" },
            new String[] { "First question", "Previous answer", "Second question" },
            nextRequest(), 4, bytes -> {
                text.append(new String(bytes, StandardCharsets.UTF_8));
                return true;
            }));
        assertEquals("aaaa", text.toString());
        LlamaRuntime.unload(engine);
        LlamaRuntime.unload(engine);
        load();
        assertEightTokens();
    }

    @Test public void invalidRequestsFailWithoutPoisoningNextGeneration() {
        assertThrows(IllegalStateException.class, () ->
            LlamaRuntime.generate(engine, ROLES, CONTENTS, nextRequest(), 8, bytes -> true));
        assertThrows(IllegalStateException.class, () ->
            LlamaRuntime.load(engine, new File(folder, "missing.gguf").getPath(), nextRequest(), 512));
        load();
        AtomicInteger chunks = new AtomicInteger();
        LlamaRuntime.Delta unexpected = bytes -> { chunks.incrementAndGet(); return true; };
        assertThrows(IllegalStateException.class, () ->
            LlamaRuntime.generate(engine, ROLES, new String[] { "Mismatch" }, nextRequest(), 8, unexpected));
        assertThrows(IllegalStateException.class, () ->
            LlamaRuntime.generate(engine, new String[] { "user" }, new String[] { null }, nextRequest(), 8, unexpected));
        assertThrows(IllegalStateException.class, () ->
            LlamaRuntime.generate(engine, ROLES, CONTENTS, nextRequest(), 512, unexpected));
        assertEquals(0, chunks.get());
        assertEightTokens();
    }

    @Test public void callbackCancellationAndStaleCancellationKeepEngineReusable() {
        load();
        long cancelled = nextRequest();
        AtomicInteger chunks = new AtomicInteger();
        assertEquals(FINISH_CANCELLED, LlamaRuntime.generate(engine, ROLES, CONTENTS, cancelled, 8, bytes -> {
            chunks.incrementAndGet();
            return false;
        }));
        assertEquals(1, chunks.get());
        StringBuilder text = new StringBuilder();
        assertEquals(FINISH_LENGTH, LlamaRuntime.generate(engine, ROLES, CONTENTS, nextRequest(), 8, bytes -> {
            LlamaRuntime.cancel(engine, cancelled);
            text.append(new String(bytes, StandardCharsets.UTF_8));
            return true;
        }));
        assertEquals("aaaaaaaa", text.toString());
    }

    @Test public void crossThreadCancellationRejectsConcurrentMutationAndThenReusesEngine() throws Exception {
        load();
        long active = nextRequest();
        CountDownLatch chunkSeen = new CountDownLatch(1), releaseChunk = new CountDownLatch(1);
        ExecutorService worker = Executors.newSingleThreadExecutor();
        Future<Integer> generation = worker.submit(() -> LlamaRuntime.generate(engine, ROLES, CONTENTS, active, 8, bytes -> {
            chunkSeen.countDown();
            try { return releaseChunk.await(10, TimeUnit.SECONDS); }
            catch (InterruptedException error) { Thread.currentThread().interrupt(); return false; }
        }));
        try {
            assertTrue("No native stream callback arrived", chunkSeen.await(20, TimeUnit.SECONDS));
            assertThrows(IllegalStateException.class, () -> LlamaRuntime.unload(engine));
            assertThrows(IllegalStateException.class, () ->
                LlamaRuntime.generate(engine, ROLES, CONTENTS, nextRequest(), 8, bytes -> true));
            LlamaRuntime.cancel(engine, active);
            releaseChunk.countDown();
            assertEquals(FINISH_CANCELLED, (int) generation.get(20, TimeUnit.SECONDS));
        } finally {
            LlamaRuntime.cancel(engine, active);
            releaseChunk.countDown();
            worker.shutdown();
            // Native handles cannot be destroyed until all native callers exit.
            boolean stopped = worker.awaitTermination(60, TimeUnit.SECONDS);
            if (!stopped) engine = 0;
            assertTrue("Native generation did not stop; refusing to destroy its active handle", stopped);
        }
        assertEightTokens();
    }

    @Test public void javaCallbackFailurePropagatesAndReleasesNativeBusyState() {
        load();
        IllegalArgumentException expected = new IllegalArgumentException("test stream consumer failed");
        IllegalArgumentException actual = assertThrows(IllegalArgumentException.class, () ->
            LlamaRuntime.generate(engine, ROLES, CONTENTS, nextRequest(), 8, bytes -> { throw expected; }));
        assertSame(expected, actual);
        assertEightTokens();
    }
}
