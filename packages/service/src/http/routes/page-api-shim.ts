import type { PageApiBootstrap } from '@bendyline/gezel';

/**
 * Output Pane API v1 — the `window.gezel` shim injected into served
 * project-type pages.
 *
 * Delivery: `preparePreviewHtml` splices this <script> into every
 * `text/html` response served from the `type` preview source, after the
 * log shim (so shim errors are captured) and before any page script (so
 * `window.gezel` exists by the time page code runs). Injection is
 * unconditional for type pages — v0 pages that hand-roll the legacy
 * sentinels simply never touch the object.
 *
 * Modes:
 *  - `embedded` (Output pane iframe): every call relays over the v1
 *    postMessage envelope (core/schemas/page-bridge.ts) to the parent,
 *    which holds the ui bearer. The page never sees a credential.
 *  - `browser` ("Open in browser" tab, no parent): data reads fall back
 *    to same-origin capability fetches (the capability is in the
 *    document URL; `pages.reads` scopes were folded at mint), tool
 *    invokes reject with code 'unavailable', refresh() reloads.
 *  - `serve` (app-serve mini-site; selected by `bootstrap.serve`): every
 *    call rides the SAME queue/ceiling machinery but travels as a
 *    same-origin fetch against the head API under the visitor cookie —
 *    invoke and read hit `/app/api/*`, `data.url()` maps to `/data/*`,
 *    watch polls stats with a post-invoke kick, refresh() reloads. No
 *    credential ever reaches the page; the parent relay is not involved.
 *  - `demo` is NOT this shim: raw files opened outside gezel have no
 *    server. Gilde ships a paste-in stub that defines `window.gezel`
 *    only when the real one is absent.
 *
 * The static bootstrap (identity, params, declared tools) is baked in at
 * serve time, so shim and daemon can never skew and pages stop parsing
 * their own URLs. Dynamic facts (theme, limits) arrive via the parent's
 * `init` reply to `hello` — the API works before init with defaults, so
 * there is no blocking handshake.
 *
 * Security posture inherited from the page bridge: the message listener
 * requires `event.source === window.parent`; ids are minted here (pages
 * never choose them); `window.gezel` is installed non-writable and
 * non-configurable before any page script can shadow it.
 */

export const PAGE_API_SHIM_VERSION = 1 as const;

/** Client-side ceilings; the parent advertises its own via init.limits. */
const DEFAULTS = {
  invokeTimeoutMs: 35_000,
  readTimeoutMs: 20_000,
  maxInflight: 4,
  maxQueued: 16,
  watchIntervalMs: 2_500,
};

export function buildPageApiShim(bootstrap: PageApiBootstrap): string {
  return `<script>(function(){
if (window.gezel) return;
var B=${JSON.stringify(bootstrap)};
var D=${JSON.stringify(DEFAULTS)};
var embedded=window.parent!==window;
var S=B.serve||null;
var mode=S?'serve':(embedded?'embedded':'browser');
var seq=0;var sid=Math.random().toString(36).slice(2,8);
var pending={};var inflight=0;var queue=[];
var watches={};var themeSubs=[];
var theme={mode:(matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'light'};
var limits={maxInflight:D.maxInflight,maxReadBytes:2*1024*1024};

function err(code,message,runId){var e=new Error(message||code);e.code=code;if(runId)e.runId=runId;return e;}
function mintId(){seq+=1;return 'g'+sid+'-'+seq;}

// Capability plumbing for browser-mode reads and data.url(): the document
// was served from /preview/<capability>/type/<projectId>/<entry>.
function capabilityBase(){
  var parts=location.pathname.split('/').filter(Boolean);
  var i=parts.indexOf('preview');
  if(i===-1||parts.length<i+4)return null;
  return {prefix:'/'+parts.slice(0,i+2).join('/'),projectId:parts[i+3]};
}
function capabilityUrl(source,path){
  var cap=capabilityBase();
  if(!cap)return null;
  var enc=String(path).split('/').map(encodeURIComponent).join('/');
  return cap.prefix+'/'+source+'/'+encodeURIComponent(cap.projectId)+'/'+enc;
}

function post(msg){window.parent.postMessage(msg,'*');}

function dispatch(){
  while(inflight<limits.maxInflight&&queue.length>0){
    var job=queue.shift();
    inflight+=1;
    pending[job.id]=job;
    job.timer=setTimeout((function(j){return function(){
      delete pending[j.id];inflight-=1;dispatch();
      j.reject(err('timeout','gezel: '+j.kindLabel+' timed out'));
    };})(job),job.timeoutMs);
    if(S)serveSend(job.msg);else post(job.msg);
  }
}

// Serve transport: the same queue/ceiling machinery, but each job travels as
// a same-origin fetch against the head API (visitor cookie auth) and settles
// itself. A job the timeout already rejected settles into nothing.
function serveStatusCode(code){
  if(code===401||code===403||code===404)return 'not-allowed';
  if(code===429)return 'rate-limited';
  if(code===400||code===413||code===422)return 'invalid-input';
  return 'unavailable';
}
function serveSend(m){
  var url,payload;
  if(m.kind==='invoke'){
    url=S.apiBase+'/invoke';payload={tool:m.tool};
    if(m.input)payload.input=m.input;
  }else{
    url=S.apiBase+'/read';payload={op:m.op,source:m.source,path:m.path};
    if(m.as)payload.as=m.as;
    if(m.maxBytes)payload.maxBytes=m.maxBytes;
  }
  fetch(url,{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',cache:'no-store',body:JSON.stringify(payload)}).then(function(res){
    return res.json().catch(function(){return {};}).then(function(body){
      settle(m.id,function(job){
        if(m.kind==='invoke'){
          if(!res.ok){job.reject(err(body.errorCode||serveStatusCode(res.status),body.error||('gezel: invoke failed ('+res.status+')'),body.runId));return;}
          if(body.status&&body.status!=='ok'){job.reject(err(body.errorCode||'script-error',body.error||'tool invoke failed',body.runId));return;}
          job.resolve({output:body.output,runId:body.runId,reaction:body.reaction});
          kickPollers();
        }else{
          if(!res.ok){job.reject(err(body.errorCode||serveStatusCode(res.status),body.error||('gezel: read failed ('+res.status+')')));return;}
          job.resolve(body);
        }
      });
    });
  }).catch(function(e){
    settle(m.id,function(job){job.reject(err('unavailable','gezel: network error ('+((e&&e.message)||e)+')'));});
  });
}
// Read-your-write: after a successful serve invoke, sweep active watches
// soon instead of waiting out the polling interval.
var pollers=[];
function kickPollers(){
  for(var i=0;i<pollers.length;i++){try{pollers[i]();}catch(_){}}
}
function enqueue(kindLabel,msg,timeoutMs){
  return new Promise(function(resolve,reject){
    if(!embedded&&!S){reject(err('unavailable','gezel: not embedded in Gezel'));return;}
    if(queue.length>=D.maxQueued){reject(err('rate-limited','gezel: too many queued calls'));return;}
    queue.push({id:msg.id,msg:msg,resolve:resolve,reject:reject,timeoutMs:timeoutMs,kindLabel:kindLabel,timer:0});
    dispatch();
  });
}
function settle(id,fn){
  var job=pending[id];
  if(!job)return;
  delete pending[id];clearTimeout(job.timer);inflight-=1;dispatch();
  fn(job);
}

addEventListener('message',function(event){
  // Identity check: only the embedding parent may drive this page.
  if(event.source!==window.parent)return;
  var d=event.data;
  if(!d||d.__gezelPage!==1||typeof d.kind!=='string')return;
  if(d.kind==='init'){
    if(d.theme&&d.theme.mode)setTheme(d.theme.mode);
    if(d.limits&&typeof d.limits.maxInflight==='number')limits.maxInflight=d.limits.maxInflight;
    if(d.limits&&typeof d.limits.maxReadBytes==='number')limits.maxReadBytes=d.limits.maxReadBytes;
    dispatch();
    return;
  }
  if(d.kind==='theme'){if(d.theme&&d.theme.mode)setTheme(d.theme.mode);return;}
  if(d.kind==='change'){
    var w=watches[d.watchId];
    if(w)try{w.cb({path:d.path,etag:d.etag});}catch(_){/* page callback errors are the page's problem */}
    return;
  }
  if(d.kind==='result'){
    settle(d.id,function(job){
      if(d.ok)job.resolve({output:d.output,runId:d.runId,reaction:d.reaction});
      else job.reject(err(d.errorCode||'script-error',d.error||'tool invoke failed',d.runId));
    });
    return;
  }
  if(d.kind==='read-result'){
    settle(d.id,function(job){
      if(!d.ok){job.reject(err(d.errorCode||'unavailable',d.error||'read failed'));return;}
      job.resolve(d);
    });
  }
});

function setTheme(mode){
  if(theme.mode===mode)return;
  theme={mode:mode};
  for(var i=0;i<themeSubs.length;i++){try{themeSubs[i](theme);}catch(_){}}
}

function decodeRead(d,as,path){
  if(as==='bytes'){
    var bin=atob(d.content||'');
    var bytes=new Uint8Array(bin.length);
    for(var i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
    return bytes;
  }
  if(as==='json'){
    try{return JSON.parse(d.content||'');}
    catch(e){throw err('script-error','gezel: '+path+' is not valid JSON: '+e.message);}
  }
  return d.content||'';
}
function defaultAs(path,as){return as||(/\\.json$/i.test(String(path))?'json':'text');}

// Browser-mode fallback transport: same-origin capability fetch. The
// capability was minted for this document and already carries the
// manifest's pages.reads scopes.
function browserRead(op,source,path,as){
  var url=capabilityUrl(source,path);
  if(!url)return Promise.reject(err('unavailable','gezel: no capability in document URL'));
  return fetch(url,{cache:'no-store'}).then(function(res){
    if(!res.ok)throw err(res.status===403?'not-allowed':'unavailable','gezel: read failed ('+res.status+')');
    return res.text().then(function(text){
      var etag='w'+text.length+'-'+(text.length?text.charCodeAt(0).toString(36)+text.charCodeAt(text.length-1).toString(36):'0');
      if(op==='stat')return {etag:etag};
      if(op==='list'){
        try{return {entries:JSON.parse(text),etag:etag};}
        catch(_){throw err('unavailable','gezel: directory listing is not available in browser mode');}
      }
      return {content:text,etag:etag,decodedAs:'text'};
    });
  });
}

function readOp(op,path,opts){
  opts=opts||{};
  var source=opts.source||'workspace';
  if(embedded||S){
    var msg={__gezelPage:1,kind:'read',id:mintId(),op:op,source:source,path:String(path)};
    if(op==='read'){
      if(opts.as==='bytes')msg.as='bytes';
      if(opts.maxBytes)msg.maxBytes=opts.maxBytes;
    }
    return enqueue('read',msg,D.readTimeoutMs);
  }
  return browserRead(op,source,String(path),opts.as);
}

var api={
  page:{api:1,projectId:B.projectId,source:'type',entry:B.entry,typeName:B.typeName,params:B.params,mode:mode},
  tools:{
    list:function(){return B.tools.slice();},
    invoke:function(tool,input){
      if(!embedded&&!S)return Promise.reject(err('unavailable','gezel: tools require the Gezel app (open this page in Gezel)'));
      var msg={__gezelPage:1,kind:'invoke',id:mintId(),tool:String(tool)};
      if(input&&typeof input==='object'&&!Array.isArray(input))msg.input=input;
      return enqueue('invoke',msg,D.invokeTimeoutMs);
    },
  },
  data:{
    read:function(path,opts){
      var as=defaultAs(path,(opts||{}).as);
      return readOp('read',path,Object.assign({},opts,{as:as})).then(function(d){return decodeRead(d,as,path);});
    },
    list:function(path,opts){
      return readOp('list',path,opts).then(function(d){return d.entries||[];});
    },
    watch:function(path,cb,opts){
      opts=opts||{};
      var source=opts.source||'workspace';
      var id=mintId();
      if(embedded){
        watches[id]={cb:cb};
        post({__gezelPage:1,kind:'watch',id:id,source:source,path:String(path)});
        return function(){delete watches[id];post({__gezelPage:1,kind:'unwatch',id:id});};
      }
      // Serve + browser modes: local polling (serve stats ride the head API).
      var last=null;var stopped=false;
      var interval=Math.max(1000,opts.intervalMs||D.watchIntervalMs);
      var statOnce=S?function(){return readOp('stat',path,{source:source});}:function(){return browserRead('stat',source,String(path));};
      function tick(){
        if(stopped)return;
        statOnce().then(function(d){
          if(!stopped&&last!==null&&d.etag!==last)try{cb({path:String(path),etag:d.etag});}catch(_){}
          last=d.etag;
        }).catch(function(){}).then(function(){if(!stopped)timer=setTimeout(tick,interval);});
      }
      var timer=setTimeout(tick,interval);
      var kick=function(){if(!stopped){clearTimeout(timer);timer=setTimeout(tick,150);}};
      if(S)pollers.push(kick);
      return function(){
        stopped=true;clearTimeout(timer);
        var i=pollers.indexOf(kick);if(i>=0)pollers.splice(i,1);
      };
    },
    url:function(path,opts){
      var source=(opts&&opts.source)||'workspace';
      if(S){
        var enc=String(path).split('/').map(encodeURIComponent).join('/');
        return S.dataBase+'/'+source+'/'+enc;
      }
      var u=capabilityUrl(source,String(path));
      if(!u)throw err('unavailable','gezel: no capability in document URL');
      return u;
    },
  },
  ui:{
    get theme(){return theme;},
    onTheme:function(cb){themeSubs.push(cb);return function(){var i=themeSubs.indexOf(cb);if(i>=0)themeSubs.splice(i,1);};},
  },
  refresh:function(){
    if(embedded)post({__gezelPage:1,kind:'refresh'});
    else location.reload();
  },
};

if(S&&typeof matchMedia==='function'){
  try{matchMedia('(prefers-color-scheme: dark)').addEventListener('change',function(e){setTheme(e.matches?'dark':'light');});}catch(_){}
}
Object.defineProperty(window,'gezel',{value:api,writable:false,configurable:false});
if(embedded)post({__gezelPage:1,kind:'hello'});
})();</script>`;
}
