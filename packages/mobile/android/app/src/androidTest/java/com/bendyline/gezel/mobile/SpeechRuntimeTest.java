package com.bendyline.gezel.mobile;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class SpeechRuntimeTest {
    @Test public void bundledKokoroVoicesProduceSpeechWhisperCanTranscribe() throws Exception {
        SpeechAssets assets = new SpeechAssets(InstrumentationRegistry.getInstrumentation().getTargetContext());
        assertTrue("The offline speech pack must be bundled", assets.bundled());
        assertTrue("Offer diverse named voices", assets.voices().length() >= 30);
        File root = assets.ensure();
        for (int voice : new int[]{3, 26}) {
            long engine = SpeechRuntime.create();
            try {
                byte[] wav = SpeechRuntime.synthesize(engine, new File(root, "kokoro").getPath(), "The blue bicycle is beside the window.", voice, 1);
                assertEquals("RIFF", new String(wav, 0, 4, StandardCharsets.US_ASCII));
                assertTrue(wav.length > 24000);
                ByteBuffer source = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN);
                int frames = (wav.length - 44) / 2;
                ByteBuffer pcm = ByteBuffer.allocate((frames * 2 / 3) * 2).order(ByteOrder.LITTLE_ENDIAN);
                for (int i = 0; i < pcm.capacity() / 2; i++) pcm.putShort(source.getShort(44 + (i * 3 / 2) * 2));
                String transcript = new String(SpeechRuntime.transcribe(engine, new File(root, "whisper-tiny.bin").getPath(), pcm.array(), "en", null), StandardCharsets.UTF_8).toLowerCase();
                assertTrue(transcript, transcript.contains("bicycle"));
                assertTrue(transcript, transcript.contains("window"));
            } finally { SpeechRuntime.destroy(engine); }
        }
    }
    @Test public void cancellationAndInvalidVoicesFailBeforeLoadingModels() {
        long engine = SpeechRuntime.create();
        try {
            assertThrows(IllegalStateException.class, () -> SpeechRuntime.synthesize(engine, "/missing", "Hello", -1, 1));
            SpeechRuntime.cancel(engine);
            assertThrows(IllegalStateException.class, () -> SpeechRuntime.transcribe(engine, "/missing", new byte[]{0, 0}, "en", null));
        } finally { SpeechRuntime.destroy(engine); }
    }
}
