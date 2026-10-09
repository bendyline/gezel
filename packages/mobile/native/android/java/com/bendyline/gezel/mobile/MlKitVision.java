package com.bendyline.gezel.mobile;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.ImageDecoder;
import android.os.Build;
import com.google.android.gms.tasks.Task;
import com.google.android.gms.tasks.Tasks;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.mlkit.genai.common.DownloadCallback;
import com.google.mlkit.genai.common.FeatureStatus;
import com.google.mlkit.genai.common.GenAiException;
import com.google.mlkit.genai.imagedescription.ImageDescriber;
import com.google.mlkit.genai.imagedescription.ImageDescriberOptions;
import com.google.mlkit.genai.imagedescription.ImageDescription;
import com.google.mlkit.genai.imagedescription.ImageDescriptionRequest;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.label.ImageLabel;
import com.google.mlkit.vision.label.ImageLabeler;
import com.google.mlkit.vision.label.ImageLabeling;
import com.google.mlkit.vision.label.defaults.ImageLabelerOptions;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/** ML Kit's bundled image labeler and Latin text recognizer, which every phone
 * has, plus Gemini Nano's image describer (genai-image-description
 * 1.0.0-beta1), which only AICore phones have. Every call blocks; the plugin
 * runs them on its worker. cancel() may run concurrently. */
final class MlKitVision implements AutoCloseable {
    /** Labeling and text recognition read small images well; Nano resizes its own. */
    static final int MAX_EDGE = 1024;
    /** Below this the default model pads its list with guesses ("Bicycle" for a skier). */
    private static final float MIN_LABEL_CONFIDENCE = 0.7f;
    private static final int MAX_TEXT_CHARS = 4000;
    private final Context context;
    private ImageDescriber describer;
    private ListenableFuture<?> pending;
    private boolean stopped;

    static final class Unavailable extends Exception {
        Unavailable(String message) { super(message); }
    }
    static final class Image {
        final Bitmap bitmap; final int width, height;
        Image(Bitmap bitmap, int width, int height) { this.bitmap = bitmap; this.width = width; this.height = height; }
    }
    static final class Label {
        final String text; final float confidence;
        Label(String text, float confidence) { this.text = text; this.confidence = confidence; }
    }

    MlKitVision(Context context) { this.context = context.getApplicationContext(); }

    /** ImageDecoder applies EXIF orientation while it decodes, so labels read the picture upright. */
    static Image decode(byte[] bytes) throws Exception {
        int[] size = new int[2];
        Bitmap bitmap = ImageDecoder.decodeBitmap(ImageDecoder.createSource(ByteBuffer.wrap(bytes)), (decoder, info, source) -> {
            // ML Kit reads pixels from the CPU; a hardware bitmap cannot be read.
            decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE);
            int width = info.getSize().getWidth(), height = info.getSize().getHeight();
            size[0] = width; size[1] = height;
            int longest = Math.max(width, height);
            if (longest > MAX_EDGE) {
                float scale = MAX_EDGE / (float) longest;
                decoder.setTargetSize(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
            }
        });
        return new Image(bitmap, size[0], size[1]);
    }

    List<Label> labels(Image image) throws Exception {
        ImageLabeler labeler = ImageLabeling.getClient(new ImageLabelerOptions.Builder().setConfidenceThreshold(MIN_LABEL_CONFIDENCE).build());
        try {
            List<Label> found = new ArrayList<>();
            for (ImageLabel label : await(labeler.process(InputImage.fromBitmap(image.bitmap, 0)), 20))
                found.add(new Label(label.getText(), label.getConfidence()));
            return found;
        } finally { labeler.close(); }
    }

    String text(Image image) throws Exception {
        TextRecognizer recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
        try {
            Text found = await(recognizer.process(InputImage.fromBitmap(image.bitmap, 0)), 20);
            String text = found.getText().trim();
            return text.length() > MAX_TEXT_CHARS ? text.substring(0, MAX_TEXT_CHARS) : text;
        } finally { recognizer.close(); }
    }

    /** One of FeatureStatus' values. Probing never downloads. */
    int describerStatus() throws Exception {
        if (Build.VERSION.SDK_INT < 31) return FeatureStatus.UNAVAILABLE;
        return await(describer().checkFeatureStatus(), 15);
    }

    String describe(Image image) throws Exception {
        if (describerStatus() != FeatureStatus.AVAILABLE) throw new Unavailable("Gemini Nano cannot describe images on this phone yet");
        return await(describer().runInference(ImageDescriptionRequest.builder(image.bitmap).build()), 60).getDescription().trim();
    }

    /** The only download this class starts, reached from an explicit Settings action. */
    void prepare() throws Exception {
        int status = describerStatus();
        if (status == FeatureStatus.AVAILABLE) return;
        if (status != FeatureStatus.DOWNLOADABLE && status != FeatureStatus.DOWNLOADING)
            throw new Unavailable("Gemini Nano is unavailable on this phone");
        await(describer().downloadFeature(new DownloadCallback() {
            @Override public void onDownloadStarted(long bytes) {}
            @Override public void onDownloadProgress(long bytes) {}
            @Override public void onDownloadCompleted() {}
            @Override public void onDownloadFailed(GenAiException error) {}
        }), 600);
    }

    private synchronized ImageDescriber describer() {
        if (stopped) throw new CancellationException();
        if (describer == null) describer = ImageDescription.getClient(ImageDescriberOptions.builder(context).build());
        return describer;
    }

    synchronized void cancel() {
        stopped = true;
        if (pending != null) pending.cancel(true);
    }

    private synchronized void check() { if (stopped) throw new CancellationException(); }

    private <T> T await(Task<T> task, long timeoutSeconds) throws Exception {
        check();
        try { return Tasks.await(task, timeoutSeconds, TimeUnit.SECONDS); }
        catch (TimeoutException error) { throw new IllegalStateException("Reading the photo timed out", error); }
        catch (ExecutionException error) { throw unwrap(error); }
        finally { check(); }
    }

    private <T> T await(ListenableFuture<T> future, long timeoutSeconds) throws Exception {
        synchronized (this) {
            if (stopped) { future.cancel(true); throw new CancellationException(); }
            pending = future;
        }
        try { return future.get(timeoutSeconds, TimeUnit.SECONDS); }
        catch (TimeoutException error) { future.cancel(true); throw new IllegalStateException("Describing the photo timed out", error); }
        catch (ExecutionException error) { throw unwrap(error); }
        finally { synchronized (this) { if (pending == future) pending = null; } }
    }

    private static Exception unwrap(ExecutionException error) {
        Throwable cause = error.getCause();
        if (cause instanceof OutOfMemoryError) throw (OutOfMemoryError) cause;
        return cause instanceof Exception ? (Exception) cause : new IllegalStateException("On-device vision failed", cause);
    }

    @Override public void close() {
        ImageDescriber current;
        synchronized (this) { current = describer; describer = null; }
        if (current != null) current.close();
    }
}
