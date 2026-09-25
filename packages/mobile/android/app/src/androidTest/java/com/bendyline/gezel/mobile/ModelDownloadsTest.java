package com.bendyline.gezel.runtime;

import static org.junit.Assert.*;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.JSObject;
import java.io.*;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public final class ModelDownloadsTest {
    private File root;
    private MobileModelStore store;
    private ModelDownloads manager;
    private final byte[] bytes="GGUFverified model fixture".getBytes(StandardCharsets.UTF_8);
    private interface Reply { ModelDownloads.Connection open(String method,Map<String,String> fields) throws Exception; }
    private volatile Reply reply;
    private volatile CountDownLatch blocked;
    private final ModelDownloads.Transport transport=new ModelDownloads.Transport(){
        public ModelDownloads.Connection open(URI uri,String method,Map<String,String> fields)throws Exception{return reply.open(method,fields);}
        public void cancel(Thread thread){CountDownLatch latch=blocked;if(latch!=null)latch.countDown();}
    };
    @Before public void setup()throws Exception{
        root=Files.createTempDirectory(InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir().toPath(),"downloads-").toFile();
        store=new MobileModelStore(root);manager=new ModelDownloads(store,transport);
    }
    @After public void cleanup()throws Exception{
        manager.close();
        try(java.util.stream.Stream<Path> paths=Files.walk(root.toPath())){for(Path path:paths.sorted(Comparator.reverseOrder()).toArray(Path[]::new))Files.delete(path);}
    }
    private JSONObject source()throws Exception{
        StringBuilder hash=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(bytes))hash.append(String.format(Locale.ROOT,"%02x",b));
        return new JSONObject().put("catalogId","fixture").put("catalogVersion","1.0.0").put("sourceId","q4").put("huggingfaceRepo","example/model").put("revision","a".repeat(40)).put("filename","fixture.gguf").put("sha256",hash.toString()).put("sizeBytes",bytes.length);
    }
    private ModelDownloads.Connection response(byte[] body,int status,Map<String,String> extras,boolean fail){
        Map<String,String> headers=new HashMap<>(Map.of("Content-Length",Integer.toString(body.length),"ETag","\"fixed\""));headers.putAll(extras);
        return new ModelDownloads.Connection(){
            public int status(){return status;}
            public String header(String name){return headers.get(name);}
            public InputStream body(){return new ByteArrayInputStream(body){
                @Override public synchronized int read(byte[] b,int off,int len){
                    if(available()==0&&fail)throw new java.io.UncheckedIOException(new IOException("Connection lost"));
                    return super.read(b,off,len);
                }
            };}
            public void close(){}
        };
    }
    private JSONObject waitFor(String id,String state)throws Exception{
        for(int n=0;n<500;n++){
            JSONArray rows=manager.list().getJSONArray("downloads");
            for(int i=0;i<rows.length();i++){JSONObject row=rows.getJSONObject(i);if(row.getString("id").equals(id)&&row.getString("state").equals(state))return row;}
            Thread.sleep(10);
        }
        throw new AssertionError("Expected "+state+": "+manager.list());
    }
    private JSONObject partial()throws Exception{
        reply=(method,fields)->response(Arrays.copyOf(bytes,8),200,Map.of("Content-Length",Integer.toString(bytes.length)),true);
        String id=manager.start(source(),"Fixture").getJSONObject("download").getString("id");
        return waitFor(id,"failed");
    }
    @Test public void installsVerifiedModelAndDismissesOnlyJournal()throws Exception{
        reply=(method,fields)->response(bytes,200,Map.of(),false);
        String id=manager.start(source(),"Fixture").getJSONObject("download").getString("id");
        assertEquals(id,waitFor(id,"complete").getString("modelId"));
        NativeObject inventory=new MobileModelStore(root).listModels();
        assertFalse(inventory.has("selectedModelId"));
        assertEquals(source().getString("sha256"),inventory.getJSONArray("models").getJSONObject(0).getJSONObject("source").getString("sha256"));
        manager.remove(id);
        assertEquals(0,manager.list().getJSONArray("downloads").length());assertEquals(1,store.listModels().getJSONArray("models").length());
    }
    @Test public void resumesInterruptedTransferAcrossRestartWithStrongValidator()throws Exception{
        JSONObject part=partial();String id=part.getString("id");assertEquals(8,part.getLong("downloadedBytes"));
        manager.close();manager=new ModelDownloads(store,transport);
        reply=(method,fields)->{assertEquals("bytes=8-",fields.get("Range"));assertEquals("\"fixed\"",fields.get("If-Range"));return response(Arrays.copyOfRange(bytes,8,bytes.length),206,Map.of("Content-Range","bytes 8-"+(bytes.length-1)+"/"+bytes.length),false);};
        manager.resume(id);assertEquals(bytes.length,waitFor(id,"complete").getLong("downloadedBytes"));
    }
    @Test public void rejectsChangedValidatorWithoutAppendingOrActivating()throws Exception{
        String id=partial().getString("id");
        reply=(method,fields)->response(Arrays.copyOfRange(bytes,8,bytes.length),206,Map.of("ETag","\"changed\"","Content-Range","bytes 8-"+(bytes.length-1)+"/"+bytes.length),false);
        manager.resume(id);JSONObject failed=waitFor(id,"failed");
        assertTrue(failed.getString("error").contains("resume identity"));assertEquals(8,failed.getLong("downloadedBytes"));assertEquals(0,store.listModels().getJSONArray("models").length());
    }
    @Test public void rangeIgnoredRestartsBeforeHashingWholeFile()throws Exception{
        String id=partial().getString("id");reply=(method,fields)->response(bytes,200,Map.of("ETag","\"new\""),false);
        manager.resume(id);waitFor(id,"complete");assertArrayEquals(bytes,Files.readAllBytes(store.downloadModelPath(id).toPath()));
    }
    @Test public void hashMismatchDiscardsUntrustedBytesAndNeverActivates()throws Exception{
        reply=(method,fields)->response(bytes,200,Map.of(),false);
        String id=manager.start(source().put("sha256","0".repeat(64)),"Fixture").getJSONObject("download").getString("id");
        JSONObject failed=waitFor(id,"failed");assertTrue(failed.getString("error").contains("SHA-256"));assertEquals(0,failed.getLong("downloadedBytes"));assertEquals(0,store.listModels().getJSONArray("models").length());
    }
    @Test public void rejectsLengthMismatchBeforePublication()throws Exception{
        reply=(method,fields)->response(bytes,200,Map.of("Content-Length","999"),false);
        String id=manager.start(source(),"Fixture").getJSONObject("download").getString("id");
        assertTrue(waitFor(id,"failed").getString("error").contains("length"));assertEquals(0,store.listModels().getJSONArray("models").length());
    }
    @Test public void suspendCancelsPendingHeadersAndReopenStaysPaused()throws Exception{
        CountDownLatch started=new CountDownLatch(1);blocked=new CountDownLatch(1);
        reply=(method,fields)->{started.countDown();assertTrue(blocked.await(3,TimeUnit.SECONDS));throw new IOException("Cancelled");};
        String id=manager.start(source(),"Fixture").getJSONObject("download").getString("id");assertTrue(started.await(3,TimeUnit.SECONDS));
        manager.cancel(UUID.randomUUID().toString());assertEquals(1,blocked.getCount());
        manager.suspend();waitFor(id,"paused");manager.close();
        reply=(method,fields)->{throw new AssertionError("Restart must not resume");};manager=new ModelDownloads(store,transport);assertEquals("paused",manager.list().getJSONArray("downloads").getJSONObject(0).getString("state"));
    }
    @Test public void recoversPublicationCrashWindowWithoutNetwork()throws Exception{
        String id=partial().getString("id");Path part=new File(new File(store.downloadsRoot(),id),"model.part").toPath();
        Files.write(part,bytes);Files.move(part,store.downloadModelPath(id).toPath());
        reply=(method,fields)->{throw new AssertionError("Full candidate verifies offline");};
        manager.resume(id);waitFor(id,"complete");manager.resume(id);assertEquals(1,store.listModels().getJSONArray("models").length());
    }
    @Test public void sourceResolutionUsesOnlyHeadAndCanCancelBeforeHeaders()throws Exception{
        CountDownLatch done=new CountDownLatch(1);List<Exception> failures=new CopyOnWriteArrayList<>();
        reply=(method,fields)->{assertEquals("HEAD",method);return response(new byte[0],200,Map.of("Content-Length","1234"),false);};
        manager.resolveSource(source(),(value,error)->{try{if(error!=null)throw error;assertEquals(1234,value.getLong("sizeBytes"));}catch(Exception e){failures.add(e);}finally{done.countDown();}});
        assertTrue(done.await(3,TimeUnit.SECONDS));assertTrue(failures.toString(),failures.isEmpty());
        CountDownLatch started=new CountDownLatch(1),cancelled=new CountDownLatch(1);blocked=new CountDownLatch(1);
        reply=(method,fields)->{started.countDown();assertTrue(blocked.await(3,TimeUnit.SECONDS));return response(new byte[0],200,Map.of("Content-Length","1234"),false);};
        manager.resolveSource(source(),(value,error)->{assertNull(value);assertNotNull(error);cancelled.countDown();});
        assertTrue(started.await(3,TimeUnit.SECONDS));manager.cancelSourceResolution();assertTrue(cancelled.await(3,TimeUnit.SECONDS));
    }
    @Test public void wrongRangeNeverActivates()throws Exception{
        String id=partial().getString("id");
        reply=(method,fields)->response(Arrays.copyOfRange(bytes,8,bytes.length),206,Map.of("Content-Range","bytes 0-17/26"),false);
        manager.resume(id);assertTrue(waitFor(id,"failed").getString("error").contains("byte range"));assertEquals(0,store.listModels().getJSONArray("models").length());
    }
    @Test public void recoveryPausesActiveJournalAndRejectsDanglingPartialLink()throws Exception{
        String id=partial().getString("id");manager.close();
        File folder=new File(store.downloadsRoot(),id),journal=new File(folder,"download.json");
        JSONObject record=new JSONObject(new String(Files.readAllBytes(journal.toPath()),StandardCharsets.UTF_8));record.put("state","downloading");Files.write(journal.toPath(),record.toString().getBytes(StandardCharsets.UTF_8));
        reply=(method,fields)->{throw new AssertionError("Reopening cannot resume");};manager=new ModelDownloads(store,transport);assertEquals("paused",manager.list().getJSONArray("downloads").getJSONObject(0).getString("state"));
        Path part=new File(folder,"model.part").toPath(),outside=new File(root,"must-not-exist").toPath();Files.delete(part);Files.createSymbolicLink(part,outside);
        try{manager.resume(id);fail("Staging symlink accepted");}catch(IOException expected){}
        assertFalse(Files.exists(outside));
    }
    @Test public void confinesPinnedSourceAndRedirects()throws Exception{
        for(String filename:List.of("../a.gguf","/a.gguf","a/../b.gguf","a\\b.gguf")){try{ModelDownloadSource.validate(source().put("filename",filename),true);fail("Unsafe filename");}catch(IOException expected){}}
        try{ModelDownloadSource.validate(source().put("revision","main"),true);fail("Mutable revision");}catch(IOException expected){}
        for(String url:List.of("http://huggingface.co/file","https://evil.test/file","https://huggingface.co.evil.test/file","https://user@hf.co/file","https://hf.co:444/file")){try{ModelDownloadSource.validateURL(new URI(url));fail("Unsafe URL");}catch(IOException expected){}}
        ModelDownloadSource.validateURL(new URI("https://cas-bridge.xethub.hf.co/file"));
    }
}
