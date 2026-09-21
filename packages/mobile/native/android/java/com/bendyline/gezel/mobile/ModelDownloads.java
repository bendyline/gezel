package com.bendyline.gezel.mobile;

import android.util.AtomicFile;
import com.getcapacitor.JSObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import java.util.regex.*;
import java.util.function.BooleanSupplier;
import org.json.*;

/** Foreground, resumable verified acquisition. Never publishes partial weights. */
final class ModelDownloads {
    interface Connection extends AutoCloseable {
        int status() throws Exception;
        String header(String name);
        InputStream body() throws Exception;
        void close();
    }
    interface Transport {
        Connection open(URI url, String method, Map<String,String> headers) throws Exception;
        default Connection open(URI url,String method,Map<String,String> headers,BooleanSupplier cancelled) throws Exception {
            if(cancelled.getAsBoolean())throw new IOException("Download paused");
            return open(url,method,headers);
        }
        default void cancel(Thread thread) {}
    }
    interface SourceResult { void complete(JSONObject source, Exception error); }
    private static final class HttpTransport implements Transport {
        private final ConcurrentHashMap<Thread,HttpURLConnection> pending = new ConcurrentHashMap<>();
        public void cancel(Thread thread) { if (thread != null) { HttpURLConnection value=pending.get(thread); if(value!=null)value.disconnect(); } }
        public Connection open(URI initial,String method,Map<String,String> headers)throws Exception {return open(initial,method,headers,()->false);}
        public Connection open(URI initial, String method, Map<String,String> headers,BooleanSupplier cancelled) throws Exception {
            URI url = initial;
            for (int redirects=0; redirects<6; redirects++) {
                ModelDownloadSource.validateURL(url);
                HttpURLConnection connection = (HttpURLConnection) url.toURL().openConnection();
                connection.setInstanceFollowRedirects(false);
                connection.setRequestMethod(method);
                connection.setConnectTimeout(20_000); connection.setReadTimeout(30_000);
                connection.setRequestProperty("Accept-Encoding", "identity");
                for (Map.Entry<String,String> header : headers.entrySet()) connection.setRequestProperty(header.getKey(), header.getValue());
                Thread owner=Thread.currentThread(); pending.put(owner,connection);
                int status;
                try { if(cancelled.getAsBoolean())throw new IOException("Download paused"); status = connection.getResponseCode(); }
                catch (Exception error) { pending.remove(owner,connection); connection.disconnect(); throw error; }
                if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                    String location = connection.getHeaderField("Location"); pending.remove(owner,connection); connection.disconnect();
                    if (location == null) throw new IOException("Model source omitted its redirect location");
                    url = url.resolve(location); continue;
                }
                return new Connection() {
                    public int status() { return status; }
                    public String header(String name) { return connection.getHeaderField(name); }
                    public InputStream body() throws Exception { return connection.getInputStream(); }
                    public void close() { pending.remove(owner,connection); connection.disconnect(); }
                };
            }
            throw new IOException("Model source redirected too many times");
        }
    }
    private final MobileStore store;
    private final File root;
    private final Transport transport;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ExecutorService metadataWorker = Executors.newSingleThreadExecutor();
    private volatile Thread downloadThread, sourceThread;
    private volatile boolean sourceCancelled;
    private boolean sourcePending;
    private String activeId;
    private volatile boolean cancelled;
    private volatile Connection connection;
    private Future<?> active;

    ModelDownloads(MobileStore store) throws Exception { this(store, new HttpTransport()); }
    ModelDownloads(MobileStore store, Transport transport) throws Exception {
        this.store = store; this.root = store.downloadsRoot(); this.transport = transport;
        for (JSONObject record : records()) {
            String state = record.getString("state");
            if (state.equals("queued") || state.equals("downloading") || state.equals("verifying")) {
                record.put("state", "paused").put("error", "Download paused when the app closed. Resume when ready.");
                record.put("downloadedBytes", candidate(record).isFile() ? candidate(record).length() : 0);
                save(record);
            }
        }
    }
    private static String id(String value) throws IOException {
        try { if (UUID.fromString(value).toString().equals(value)) return value; } catch (Exception ignored) {}
        throw new IOException("Invalid download identity");
    }
    private File folder(String value) throws Exception {
        File folder = new File(root, id(value));
        if (Files.isSymbolicLink(folder.toPath()) || !folder.getCanonicalFile().equals(folder.getAbsoluteFile())) throw new IOException("Invalid download storage");
        return folder;
    }
    private File partial(JSONObject record) throws Exception {
        File file=new File(folder(record.getString("id")),"model.part");
        if(Files.isSymbolicLink(file.toPath())||!file.getCanonicalFile().equals(file.getAbsoluteFile()))throw new IOException("Invalid model staging file");
        return file;
    }
    private File candidate(JSONObject record) throws Exception {
        File part = partial(record);
        return part.isFile() ? part : store.downloadModelPath(record.getString("id"));
    }
    private JSONObject read(String value) throws Exception {
        File path = new File(folder(value), "download.json");
        if (Files.isSymbolicLink(path.toPath())) throw new IOException("Invalid download record");
        JSONObject record;
        try (FileInputStream file = new AtomicFile(path).openRead()) {
            long size=file.getChannel().size(); if(size>32*1024)throw new IOException("Download record exceeds its limit");
            byte[] bytes=new byte[(int)size]; new DataInputStream(file).readFully(bytes);
            record=new JSONObject(new String(bytes,StandardCharsets.UTF_8));
        }
        if (!value.equals(record.getString("id"))) throw new IOException("Download identity changed");
        record.put("source", ModelDownloadSource.validate(record.getJSONObject("source"), true));
        if (!Set.of("queued","downloading","paused","verifying","complete","failed").contains(record.getString("state"))) throw new IOException("Invalid download state");
        if (!record.getString("state").equals("complete")) {
            File file=candidate(record);
            record.put("downloadedBytes",Math.min(file.isFile()?file.length():0,record.getJSONObject("source").getLong("sizeBytes")));
        }
        return record;
    }
    private List<JSONObject> records() throws Exception {
        List<JSONObject> result = new ArrayList<>();
        File[] paths = root.listFiles();
        if (paths == null) throw new IOException("Download storage is unavailable");
        for (File path : paths) if (path.isDirectory()) { result.add(read(path.getName())); if (result.size()>16) throw new IOException("Download library exceeds its limit"); }
        return result;
    }
    private void save(JSONObject record) throws Exception {
        File directory = folder(record.getString("id"));
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Cannot save download state");
        AtomicFile file = new AtomicFile(new File(directory, "download.json"));
        FileOutputStream output = null;
        try { output = file.startWrite(); output.write(record.toString().getBytes(StandardCharsets.UTF_8)); file.finishWrite(output); }
        catch (Exception error) { file.failWrite(output); throw error; }
    }
    private JSObject publicRecord(JSONObject record) throws Exception {
        JSObject result = new JSObject().put("id",record.getString("id")).put("name",record.getString("name"))
            .put("source",record.getJSONObject("source")).put("state",record.getString("state")).put("downloadedBytes",record.getLong("downloadedBytes"));
        if (record.has("error")) result.put("error",record.getString("error"));
        if (record.has("modelId")) result.put("modelId",record.getString("modelId"));
        return result;
    }
    synchronized JSObject list() throws Exception {
        JSONArray downloads = new JSONArray();
        for (JSONObject record : records()) downloads.put(publicRecord(record));
        return new JSObject().put("downloads",downloads);
    }
    synchronized void resolveSource(JSONObject raw, SourceResult completion) throws Exception {
        if(sourcePending)throw new IOException("A model source is already being checked");
        JSONObject source=ModelDownloadSource.validate(raw,false);
        sourcePending=true;sourceCancelled=false;
        metadataWorker.execute(()->{
            JSONObject result=null;Exception failure=null;sourceThread=Thread.currentThread();
            try {
                if(sourceCancelled)throw new IOException("Source lookup cancelled");
                try(Connection response=transport.open(ModelDownloadSource.url(source),"HEAD",Map.of(),()->sourceCancelled)) {
                    if(response.status()!=200)throw new IOException("Model source cannot be inspected (HTTP "+response.status()+"). Gated models must be imported from Files.");
                    long size=parseLength(response.header("Content-Length"));
                    if(size<4||size>MobileStore.MAX_MODEL)throw new IOException("This model exceeds the 4 GiB mobile download limit");
                    result=source.put("sizeBytes",size);
                }
            }catch(Exception error){failure=error;}
            synchronized(this){
                if(sourceCancelled)failure=new IOException("Source lookup cancelled");
                sourceThread=null;sourcePending=false;
            }
            completion.complete(failure==null?result:null,failure);
        });
    }
    void cancelSourceResolution() { sourceCancelled=true;transport.cancel(sourceThread); }
    synchronized JSObject start(JSONObject raw, String name) throws Exception {
        if (activeId != null) throw new IOException("A model download is already running");
        JSONObject source=ModelDownloadSource.validate(raw,true);
        if (name==null || name.isEmpty() || name.length()>200 || name.indexOf(0)>=0) throw new IOException("Invalid model name");
        if (records().size()>=16) throw new IOException("Remove a saved download before starting another");
        if (root.getUsableSpace()<source.getLong("sizeBytes")+64L*1024*1024) throw new IOException("Not enough storage for this model");
        JSONObject record=new JSONObject().put("id",UUID.randomUUID().toString()).put("name",name).put("source",source).put("state","queued").put("downloadedBytes",0);
        save(record); launch(record.getString("id"));
        return new JSObject().put("download",publicRecord(record));
    }
    synchronized JSObject resume(String value) throws Exception {
        if (activeId != null) throw new IOException("A model download is already running");
        JSONObject record=read(value);
        if (record.getString("state").equals("complete")) return new JSObject().put("download",publicRecord(record));
        long remaining=record.getJSONObject("source").getLong("sizeBytes")-(candidate(record).isFile()?candidate(record).length():0);
        if (root.getUsableSpace()<remaining+64L*1024*1024) throw new IOException("Not enough storage to resume this download");
        record.put("state","queued"); record.remove("error"); save(record); launch(value);
        return new JSObject().put("download",publicRecord(record));
    }
    private void launch(String value) {
        activeId=value; cancelled=false;
        active=worker.submit(()->transfer(value));
    }
    void cancel(String value) throws Exception {
        Future<?> pending;
        synchronized(this) { id(value); if (!value.equals(activeId)) return; cancelled=true; pending=active; }
        transport.cancel(downloadThread); Connection current=connection; if (current!=null) current.close();
        if (pending!=null) pending.get(35,TimeUnit.SECONDS);
    }
    void requestPause() { cancelled=true;sourceCancelled=true; }
    void suspend() { requestPause();cancelSourceResolution();transport.cancel(downloadThread);Connection current=connection;if(current!=null)current.close(); }
    void close() { suspend(); worker.shutdown(); metadataWorker.shutdown(); }
    void remove(String value) throws Exception {
        cancel(value);
        synchronized(this) {
            read(value);
            File directory=folder(value);
            for(File file : Objects.requireNonNull(directory.listFiles())) Files.delete(file.toPath());
            Files.delete(directory.toPath());
        }
    }
    private static long parseLength(String raw) throws IOException {
        if(raw==null || !raw.matches("[0-9]{1,12}"))throw new IOException("Model source omitted a valid exact length");
        try{return Long.parseLong(raw);}catch(NumberFormatException error){throw new IOException("Invalid source length");}
    }
    private static String etag(Connection response) {
        String value=response.header("ETag");
        return value!=null && value.length()<=512 && value.matches("\"[^\\r\\n\"]+\"")?value:null;
    }
    private void checkpoint(JSONObject record,String state,long bytes) throws Exception {
        synchronized(this) {record.put("state",state).put("downloadedBytes",bytes);save(record);}
    }
    private void checkCancelled() throws IOException { if(cancelled)throw new IOException("Download paused"); }
    private void transfer(String value) {
        JSONObject record=null;downloadThread=Thread.currentThread();
        try {
            synchronized(this) {record=read(value);}
            JSONObject source=record.getJSONObject("source");long expected=source.getLong("sizeBytes");
            File part=partial(record), candidate=candidate(record);long offset=candidate.isFile()?candidate.length():0;
            if(offset>expected)throw new IOException("Saved partial exceeds expected model length");
            checkCancelled();
            if(offset<expected) {
                // Without a strong validator the old bytes cannot be resumed.
                String prior=record.optString("etag",null);
                if(offset>0 && prior==null) {Files.deleteIfExists(part.toPath());offset=0;}
                Map<String,String> headers=offset>0?Map.of("Range","bytes="+offset+"-","If-Range",prior):Map.of();
                Connection response=transport.open(ModelDownloadSource.url(source),"GET",headers,()->cancelled);connection=response;
                try(response) {
                    checkCancelled();int status=response.status();String current=etag(response);
                    if(status==200) {offset=0;}
                    else if(status==206 && offset>0) {
                        Matcher range=Pattern.compile("bytes ([0-9]+)-([0-9]+)/([0-9]+)").matcher(Objects.toString(response.header("Content-Range"),""));
                        if(current==null || !current.equals(prior) || !range.matches() || Long.parseLong(range.group(1))!=offset || Long.parseLong(range.group(2))!=expected-1 || Long.parseLong(range.group(3))!=expected)
                            throw new IOException("Model source changed its resume identity or byte range; remove this download and try again");
                    } else throw new IOException("Model download failed (HTTP "+status+")");
                    if(parseLength(response.header("Content-Length"))!=expected-offset)throw new IOException("Model source length differs from the verified download source");
                    String encoding=response.header("Content-Encoding");if(encoding!=null && !encoding.equalsIgnoreCase("identity"))throw new IOException("Compressed model transfers are not supported");
                    if(current==null)record.remove("etag");else record.put("etag",current);
                    try(FileOutputStream output=new FileOutputStream(part,offset>0);InputStream input=response.body()) {
                        checkpoint(record,"downloading",offset);long last=offset;byte[] buffer=new byte[64*1024];int count;
                        while((count=input.read(buffer))!=-1) {
                            checkCancelled();if(offset+count>expected)throw new IOException("Model transfer exceeded its expected length");
                            output.write(buffer,0,count);offset+=count;
                            if(offset-last>=1024*1024) {output.getFD().sync();checkpoint(record,"downloading",offset);last=offset;}
                        }
                        output.getFD().sync();checkpoint(record,"verifying",offset);
                    }
                    if(offset!=expected)throw new IOException("Model transfer ended early. Resume to continue.");
                } finally {connection=null;}
                candidate=part;
            }
            checkCancelled();checkpoint(record,"verifying",expected);
            MessageDigest digest=MessageDigest.getInstance("SHA-256");
            try(InputStream input=new FileInputStream(candidate)) {byte[] buffer=new byte[1024*1024];int count;while((count=input.read(buffer))!=-1){checkCancelled();digest.update(buffer,0,count);}}
            StringBuilder hash=new StringBuilder();for(byte b:digest.digest())hash.append(String.format(Locale.ROOT,"%02x",b));
            if(!hash.toString().equals(source.getString("sha256"))) {Files.deleteIfExists(candidate.toPath());record.remove("etag");record.put("downloadedBytes",0);throw new IOException("Model SHA-256 verification failed. No model was installed.");}
            checkCancelled();
            synchronized(this) {
                checkCancelled();store.publishDownloadedModel(value,record.getString("name"),source,candidate);
                record.put("modelId",value);record.remove("error");checkpoint(record,"complete",expected);
            }
        } catch(Exception failure) {
            if(record!=null)try {
                File saved=candidate(record);long bytes=saved.isFile()?saved.length():0;
                String message=cancelled?"Download paused. Resume when ready.":Objects.toString(failure.getMessage(),"Model download failed");
                record.put("error",message.substring(0,Math.min(message.length(),1000)));
                checkpoint(record,cancelled?"paused":"failed",Math.min(bytes,record.getJSONObject("source").getLong("sizeBytes")));
            }catch(Exception ignored) { /* Existing durable checkpoint stays resumable after storage recovers. */ }
        } finally {connection=null;downloadThread=null;synchronized(this){activeId=null;active=null;}}
    }
}
