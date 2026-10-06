package com.bendyline.gezel.runtime;

import static org.junit.Assert.*;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** Real filesystem tests run on the build host before the runtime AAR is published. */
public final class MobileModelStoreTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    @Test public void linkedRootIsRejectedBeforeRecoveryOrCreation() throws Exception {
        for (boolean recover : new boolean[] {true, false}) {
            File parent = temporary.newFolder();
            File outside = temporary.newFolder();
            File models = new File(outside, "models");
            assertTrue(models.mkdir());
            File sentinel = new File(models, "keep.partial");
            byte[] bytes = {1, 2, 3};
            Files.write(sentinel.toPath(), bytes);
            File root = new File(parent, "gezel");
            Files.createSymbolicLink(root.toPath(), outside.toPath());
            assertThrows(IOException.class, () -> new MobileModelStore(root, recover));
            assertArrayEquals(bytes, Files.readAllBytes(sentinel.toPath()));
            // The public factory must not canonicalize away the link either.
            assertThrows(IllegalArgumentException.class, () -> GezelNativeRuntime.shared(null, root));
            assertArrayEquals(bytes, Files.readAllBytes(sentinel.toPath()));
        }
    }

    @Test public void linkedModelsDirectoryIsRejectedBeforeRecovery() throws Exception {
        File root = temporary.newFolder(), outside = temporary.newFolder();
        File sentinel = new File(outside, "keep.partial");
        Files.write(sentinel.toPath(), new byte[] {4, 5, 6});
        Files.createSymbolicLink(new File(root, "models").toPath(), outside.toPath());
        assertThrows(IOException.class, () -> new MobileModelStore(root));
        assertArrayEquals(new byte[] {4, 5, 6}, Files.readAllBytes(sentinel.toPath()));
    }

    @Test public void danglingLinksDoNotCreateTheirDestinations() throws Exception {
        for (boolean linkRoot : new boolean[] {true, false}) {
            File parent = temporary.newFolder(), outside = new File(temporary.newFolder(), "missing");
            File root = new File(parent, "gezel");
            if (!linkRoot) assertTrue(root.mkdir());
            File link = linkRoot ? root : new File(root, "models");
            Files.createSymbolicLink(link.toPath(), outside.toPath());
            assertThrows(IOException.class, () -> new MobileModelStore(root));
            assertFalse(outside.exists());
        }
    }

    @Test public void trustedParentAliasAndOrdinaryRecoveryStillWork() throws Exception {
        File parent = temporary.newFolder(), alias = new File(temporary.newFolder(), "app-files");
        Files.createSymbolicLink(alias.toPath(), parent.toPath());
        File requested = new File(alias, "gezel");
        File expected = new File(parent, "gezel").getCanonicalFile();
        assertEquals(expected, MobileModelStore.validatedRoot(requested));
        new MobileModelStore(requested);
        File partial = new File(expected, "models/interrupted.partial");
        Files.write(partial.toPath(), new byte[] {7});
        new MobileModelStore(requested, false);
        assertTrue(partial.exists());
        new MobileModelStore(requested);
        assertFalse(partial.exists());
    }
}
