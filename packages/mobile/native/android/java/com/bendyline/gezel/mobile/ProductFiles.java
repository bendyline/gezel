package com.bendyline.gezel.mobile;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.*;
import java.util.stream.Stream;

/** Confined product tree, separate from legacy state and model storage. */
final class ProductFiles {
    static final int MAX_FILE = 16 * 1024 * 1024;
    private final Path root;
    static final class Entry {
        final String name;
        final boolean isDirectory;
        final long size, mtime;
        Entry(String name, boolean isDirectory, long size, long mtime) {
            this.name = name; this.isDirectory = isDirectory; this.size = size; this.mtime = mtime;
        }
    }

    ProductFiles(File folder) throws IOException {
        root = folder.getAbsoluteFile().toPath();
        if (!folder.getCanonicalFile().equals(folder.getAbsoluteFile())) throw new IOException("Unsafe product root");
        BasicFileAttributes attributes = attributes(root);
        if (attributes != null && !attributes.isDirectory()) throw new IOException("Unsafe product root");
        Files.createDirectories(root);
    }

    private static BasicFileAttributes attributes(Path path) throws IOException {
        try { return Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS); }
        catch (NoSuchFileException error) { return null; }
    }

    private Path resolve(String path, boolean allowRoot) throws IOException {
        if (path == null || (!allowRoot && path.isEmpty()) || path.getBytes(StandardCharsets.UTF_8).length > 4096
                || path.indexOf('\\') >= 0 || path.indexOf('\0') >= 0) throw new IOException("Invalid product path");
        BasicFileAttributes base = attributes(root);
        if (base == null || !base.isDirectory() || base.isSymbolicLink()) throw new IOException("Unsafe product root");
        if (path.isEmpty()) return root;
        String[] parts = path.split("/", -1);
        if (parts.length > 128) throw new IOException("Invalid product path");
        Path current = root;
        for (int index = 0; index < parts.length; index++) {
            String part = parts[index];
            if (part.isEmpty() || part.equals(".") || part.equals("..") || part.getBytes(StandardCharsets.UTF_8).length > 255)
                throw new IOException("Invalid product path");
            current = current.resolve(part);
            BasicFileAttributes attributes = attributes(current);
            if (attributes != null) {
                if (!attributes.isDirectory() && !attributes.isRegularFile()) throw new IOException("Symbolic links and special files are not allowed");
                if (index < parts.length - 1 && !attributes.isDirectory()) throw new IOException("Parent is not a directory");
            }
        }
        return current;
    }

    synchronized byte[] read(String path) throws IOException {
        Path file = resolve(path, false);
        BasicFileAttributes attributes = attributes(file);
        if (attributes == null) return null;
        if (!attributes.isRegularFile()) throw new IOException("Not a product file");
        if (attributes.size() > MAX_FILE) throw new IOException("Product files are limited to 16 MiB");
        try (InputStream input = Files.newInputStream(file, LinkOption.NOFOLLOW_LINKS); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count, total = 0;
            while ((count = input.read(buffer)) != -1) {
                total += count;
                if (total > MAX_FILE) throw new IOException("Product files are limited to 16 MiB");
                output.write(buffer, 0, count);
            }
            return output.toByteArray();
        }
    }

    synchronized void write(String path, byte[] data) throws IOException {
        if (data.length > MAX_FILE) throw new IOException("Product files are limited to 16 MiB");
        Path file = resolve(path, false);
        BasicFileAttributes existing = attributes(file), parent = attributes(file.getParent());
        if (existing != null && !existing.isRegularFile()) throw new IOException("Not a product file");
        if (parent == null || !parent.isDirectory()) throw new IOException("Parent directory does not exist");
        Path temporary = Files.createTempFile(file.getParent(), ".gezel-write-", ".tmp");
        try {
            try (FileOutputStream output = new FileOutputStream(temporary.toFile())) {
                output.write(data); output.getFD().sync();
            }
            Files.move(temporary, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } finally { Files.deleteIfExists(temporary); }
    }

    synchronized List<Entry> list(String path) throws IOException {
        Path folder = resolve(path, true);
        BasicFileAttributes parent = attributes(folder);
        if (parent == null || !parent.isDirectory()) throw new IOException("Product directory does not exist");
        List<Entry> result = new ArrayList<>();
        try (DirectoryStream<Path> children = Files.newDirectoryStream(folder)) {
            for (Path child : children) {
                if (result.size() >= 10000) throw new IOException("Directory contains too many entries");
                String name = child.getFileName().toString();
                resolve(path.isEmpty() ? name : path + "/" + name, false);
                BasicFileAttributes attributes = attributes(child);
                if (attributes == null) throw new IOException("Product file changed while listing");
                result.add(new Entry(name, attributes.isDirectory(), attributes.isDirectory() ? 0 : attributes.size(), attributes.lastModifiedTime().toMillis()));
            }
        }
        result.sort(Comparator.comparing(entry -> entry.name));
        return result;
    }

    synchronized void mkdir(String path) throws IOException { Files.createDirectories(resolve(path, true)); }

    private List<Path> tree(String path) throws IOException {
        Path from = resolve(path, false);
        if (attributes(from) == null) return Collections.emptyList();
        List<Path> paths = new ArrayList<>();
        try (Stream<Path> children = Files.walk(from)) {
            Iterator<Path> iterator = children.iterator();
            while (iterator.hasNext()) {
                if (paths.size() >= 10000) throw new IOException("Directory contains too many entries");
                Path child = iterator.next();
                resolve(root.relativize(child).toString(), false);
                paths.add(child);
            }
        }
        return paths;
    }

    synchronized void remove(String path) throws IOException {
        List<Path> paths = tree(path);
        paths.sort(Comparator.reverseOrder());
        for (Path child : paths) Files.delete(child);
    }

    synchronized void rename(String from, String to) throws IOException {
        Path source = resolve(from, false), destination = resolve(to, false);
        if (to.startsWith(from + "/")) throw new IOException("Cannot move a directory inside itself");
        if (attributes(destination) != null) throw new FileAlreadyExistsException(to);
        BasicFileAttributes parent = attributes(destination.getParent());
        if (parent == null || !parent.isDirectory()) throw new IOException("Parent directory does not exist");
        tree(from);
        // No REPLACE_EXISTING: native rename cannot silently destroy a sibling.
        Files.move(source, destination);
    }
}
