package com.bendyline.gezel.mobile;

import static org.junit.Assert.*;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import android.net.Uri;
import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public final class MobileStoreTest {
    private File folder;
    private MobileStore store;
    private JSONObject model(String id) throws Exception {
        return new JSONObject().put("id", id).put("name", "fixture.gguf").put("sizeBytes", 4);
    }
    private File document(String name) { return new File(new File(folder, "gezel"), name); }
    @Before public void setup() throws Exception {
        File cache = InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir();
        folder = Files.createTempDirectory(cache.toPath(), "mobile-store-test-").toFile();
        store = new MobileStore(folder);
    }
    @After public void cleanup() throws Exception {
        if (folder == null) return;
        try (java.util.stream.Stream<java.nio.file.Path> paths = Files.walk(folder.toPath())) {
            for (java.nio.file.Path path : (Iterable<java.nio.file.Path>) paths.sorted(java.util.Comparator.reverseOrder())::iterator) Files.deleteIfExists(path);
        }
    }
    @Test public void restoresBackupOnlyState() throws Exception {
        String saved = "{\"history\":\"keep\"}";
        store.writeState(saved);
        assertTrue(document("state.json").renameTo(document("state.json.bak")));
        assertEquals(saved, store.readState());
        assertTrue(document("state.json").isFile());
    }

    @Test public void pinnedModelDoesNotFollowSelectionOrFallBackAfterRemoval() throws Exception {
        String first = UUID.randomUUID().toString(), second = UUID.randomUUID().toString();
        JSONObject library = new JSONObject().put("models", new JSONArray().put(model(first)).put(model(second)))
            .put("selectedModelId", second);
        Files.write(document("models.json").toPath(), library.toString().getBytes(StandardCharsets.UTF_8));
        for (String id : new String[] { first, second })
            Files.write(document("models/" + id + ".gguf").toPath(), new byte[] { 'G', 'G', 'U', 'F' });
        assertEquals(first, store.model(first)[0]);
        assertEquals(second, store.selectedModel()[0]);
        store.removeModel(first);
        assertThrows(Exception.class, () -> store.model(first));
        assertEquals(second, store.selectedModel()[0]);
    }
    @Test public void rejectsCorruptOrOversizedLibrary() throws Exception {
        String id = UUID.randomUUID().toString();
        JSONObject duplicate = new JSONObject().put("models", new JSONArray().put(model(id)).put(model(id)));
        assertThrows(Exception.class, () -> MobileStore.validateLibrary(duplicate));
        JSONObject dangling = new JSONObject().put("models", new JSONArray()).put("selectedModelId", id);
        assertThrows(Exception.class, () -> MobileStore.validateLibrary(dangling));
        JSONObject invalidSize = new JSONObject().put("models", new JSONArray().put(model(id).put("sizeBytes", MobileStore.MAX_MODEL + 1)));
        assertThrows(Exception.class, () -> MobileStore.validateLibrary(invalidSize));
        try (RandomAccessFile file = new RandomAccessFile(document("models.json"), "rw")) { file.setLength(MobileStore.MAX_LIBRARY + 1); }
        assertThrows(Exception.class, () -> store.listModels());
        assertEquals(MobileStore.MAX_LIBRARY + 1, document("models.json").length());
    }
    @Test public void removingSelectedModelPreservesHistoryAndDoesNotSelectAnother() throws Exception {
        String first = UUID.randomUUID().toString(), second = UUID.randomUUID().toString();
        JSONArray entries = new JSONArray().put(model(first)).put(model(second));
        JSONObject library = new JSONObject().put("models", entries).put("selectedModelId", first);
        Files.write(document("models.json").toPath(), library.toString().getBytes(StandardCharsets.UTF_8));
        for (String id : new String[] { first, second }) Files.write(document("models/" + id + ".gguf").toPath(), new byte[] { 'G', 'G', 'U', 'F' });
        store.writeState("{\"history\":\"keep\"}");
        store.removeModel(first);
        JSONObject remaining = store.listModels();
        assertFalse(remaining.has("selectedModelId"));
        assertEquals(second, remaining.getJSONArray("models").getJSONObject(0).getString("id"));
        assertFalse(document("models/" + first + ".gguf").exists());
        assertEquals("{\"history\":\"keep\"}", store.readState());
        assertThrows(Exception.class, () -> store.selectedModel());
    }

    @Test public void importsSelectsAndReopensWithoutLosingConversationState() throws Exception {
        File source = new File(folder, "incoming.gguf");
        byte[] content = new byte[] { 'G', 'G', 'U', 'F', 1, 2, 3, 4 };
        Files.write(source.toPath(), content);
        String saved = "{\"history\":\"hello \uD83D\uDE00\",\"revision\":2}";
        store.writeState(saved);
        JSONObject imported = store.importModel(
            InstrumentationRegistry.getInstrumentation().getTargetContext().getContentResolver(),
            Uri.fromFile(source));
        String id = imported.getString("id");
        assertEquals(content.length, imported.getLong("sizeBytes"));
        assertFalse("Import must not silently choose a model", store.listModels().has("selectedModelId"));
        store.selectModel(id);
        Files.delete(source.toPath());

        MobileStore reopened = new MobileStore(folder);
        assertEquals(saved, reopened.readState());
        assertEquals(id, reopened.listModels().getString("selectedModelId"));
        String[] selected = reopened.selectedModel();
        assertEquals(id, selected[0]);
        assertArrayEquals(content, Files.readAllBytes(new File(selected[1]).toPath()));
        reopened.removeModel(id);
        assertEquals(0, new MobileStore(folder).listModels().getJSONArray("models").length());
        assertEquals(saved, new MobileStore(folder).readState());
    }

    @Test public void failedImportAndInvalidStateWritePreserveExistingState() throws Exception {
        String saved = "{\"history\":\"keep\"}";
        store.writeState(saved);
        assertThrows(Exception.class, () -> store.writeState("not json"));
        assertEquals(saved, new MobileStore(folder).readState());
        File source = new File(folder, "broken.gguf");
        Files.write(source.toPath(), new byte[] { 'n', 'o', 'p', 'e', 1 });
        assertThrows(Exception.class, () -> store.importModel(
            InstrumentationRegistry.getInstrumentation().getTargetContext().getContentResolver(),
            Uri.fromFile(source)));
        assertEquals(0, store.listModels().getJSONArray("models").length());
        assertArrayEquals(new String[0], document("models").list());
        assertEquals(saved, store.readState());
    }

    @Test public void corruptStateAndChangedSelectedModelRemainVisibleFailures() throws Exception {
        byte[] corrupt = new byte[] { '{', '"', 'x', '"', ':', '"', (byte) 0xFF, '"', '}' };
        Files.write(document("state.json").toPath(), corrupt);
        assertThrows(Exception.class, () -> store.readState());
        assertArrayEquals(corrupt, Files.readAllBytes(document("state.json").toPath()));

        String id = UUID.randomUUID().toString();
        JSONObject library = new JSONObject().put("models", new JSONArray().put(model(id)))
            .put("selectedModelId", id);
        Files.write(document("models.json").toPath(), library.toString().getBytes(StandardCharsets.UTF_8));
        Files.write(document("models/" + id + ".gguf").toPath(), new byte[] { 'n', 'o', 'p', 'e' });
        assertThrows(Exception.class, () -> store.selectedModel());
        assertEquals("A corrupt model must not silently clear the user's selection", id,
            new MobileStore(folder).listModels().getString("selectedModelId"));
    }

    @Test public void trustedBaseDirectoryAliasKeepsModelPathsUsable() throws Exception {
        File alias = new File(folder, "trusted-alias");
        Files.createSymbolicLink(alias.toPath(), folder.getCanonicalFile().toPath());
        MobileStore aliased = new MobileStore(alias);
        String id = UUID.randomUUID().toString();
        JSONObject library = new JSONObject().put("models", new JSONArray().put(model(id)));
        Files.write(document("models.json").toPath(), library.toString().getBytes(StandardCharsets.UTF_8));
        Files.write(document("models/" + id + ".gguf").toPath(), new byte[] { 'G', 'G', 'U', 'F' });
        aliased.selectModel(id);
        String[] selected = aliased.selectedModel();
        assertEquals(id, selected[0]);
        assertEquals(document("models/" + id + ".gguf").getCanonicalPath(), selected[1]);
    }

    @Test public void symlinkedStorageDirectoriesAreRejectedBeforeCleanup() throws Exception {
        for (boolean linkRoot : new boolean[] { true, false }) {
            File base = new File(folder, linkRoot ? "linked-root" : "linked-models");
            File outside = new File(folder, linkRoot ? "outside-root" : "outside-models");
            assertTrue(base.mkdir());
            assertTrue(outside.mkdir());
            File destination = new File(base, "gezel");
            File outsideModels = outside;
            if (linkRoot) {
                outsideModels = new File(outside, "models");
                assertTrue(outsideModels.mkdir());
            } else {
                assertTrue(destination.mkdir());
                destination = new File(destination, "models");
            }
            File sentinel = new File(outsideModels, "keep.partial");
            Files.write(sentinel.toPath(), new byte[] { 1, 2, 3 });
            Files.createSymbolicLink(destination.toPath(), outside.getCanonicalFile().toPath());
            assertThrows(IOException.class, () -> new MobileStore(base));
            assertArrayEquals(new byte[] { 1, 2, 3 }, Files.readAllBytes(sentinel.toPath()));
        }
    }

    @Test public void symlinkedModelCannotBeSelectedOrRemoved() throws Exception {
        String id = UUID.randomUUID().toString();
        JSONObject library = new JSONObject().put("models", new JSONArray().put(model(id)))
            .put("selectedModelId", id);
        Files.write(document("models.json").toPath(), library.toString().getBytes(StandardCharsets.UTF_8));
        File outside = new File(folder, "outside.gguf");
        byte[] bytes = new byte[] { 'G', 'G', 'U', 'F' };
        Files.write(outside.toPath(), bytes);
        Files.createSymbolicLink(document("models/" + id + ".gguf").toPath(), outside.getCanonicalFile().toPath());
        assertThrows(IOException.class, () -> store.selectModel(id));
        assertThrows(IOException.class, () -> store.selectedModel());
        assertThrows(IOException.class, () -> store.removeModel(id));
        assertArrayEquals(bytes, Files.readAllBytes(outside.toPath()));
        assertEquals(id, store.listModels().getString("selectedModelId"));
        Files.delete(outside.toPath());
        assertThrows("Dangling model symlinks must also be rejected", IOException.class, () -> store.removeModel(id));
        assertEquals(id, store.listModels().getString("selectedModelId"));
    }
}
