package com.bendyline.gezel.mobile;

import java.io.*;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.stream.Stream;

/** Host-JDK contract test for the same filesystem class used by the Android plugin. */
public final class ProductFilesTest {
    interface Action { void run() throws Exception; }
    static void rejects(Action action) throws Exception {
        try { action.run(); } catch (IOException error) { return; }
        throw new AssertionError("Expected filesystem operation to reject");
    }
    static void check(boolean condition) { if (!condition) throw new AssertionError("Product file contract failed"); }
    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("gezel-product-files-test-").toRealPath();
        try {
            ProductFiles files = new ProductFiles(root.resolve("product").toFile());
            files.mkdir(".transactions/draft/workspace");
            byte[] data = new byte[] {0, (byte) 255, 1, 2};
            files.write(".transactions/draft/workspace/file", data);
            files.mkdir("projects");
            files.rename(".transactions/draft", "projects/new");
            check(Arrays.equals(data, new ProductFiles(root.resolve("product").toFile()).read("projects/new/workspace/file")));
            check(files.list("projects/new/workspace").get(0).size == 4);
            check(files.list("projects/new/workspace").get(0).mtime > 0);
            files.write("config.json", "old".getBytes(StandardCharsets.UTF_8));
            rejects(() -> files.write("config.json", new byte[ProductFiles.MAX_FILE + 1]));
            check(new String(files.read("config.json"), StandardCharsets.UTF_8).equals("old"));
            rejects(() -> files.rename("projects/new/workspace/file", "config.json"));
            for (String path : new String[] {"", "../outside", "/absolute", "x/../y", "x//y", "x\\y", "x\0y", "./x"}) {
                rejects(() -> files.write(path, data));
                rejects(() -> files.remove(path));
            }
            Path outside = root.resolve("outside");
            Files.write(outside, data);
            Files.createSymbolicLink(root.resolve("product/projects/new/link"), outside);
            rejects(() -> files.read("projects/new/link"));
            rejects(() -> files.write("projects/new/link", new byte[0]));
            rejects(() -> files.remove("projects/new"));
            rejects(() -> files.rename("projects/new", "projects/moved"));
            check(Arrays.equals(Files.readAllBytes(outside), data));
            Files.delete(root.resolve("product/projects/new/link"));
            files.remove("projects/new");
            check(files.list("projects").isEmpty());
            files.remove("missing");
            Files.createSymbolicLink(root.resolve("alias"), root.resolve("product"));
            rejects(() -> new ProductFiles(root.resolve("alias").toFile()));
            System.out.println("Android ProductFiles host contract passed: atomic writes, binary reopen, directories, rename, confinement, symlinks, subtree removal");
        } finally {
            try (Stream<Path> files = Files.walk(root)) {
                for (Path file : (Iterable<Path>) files.sorted(Comparator.reverseOrder())::iterator) Files.delete(file);
            }
        }
    }
}
