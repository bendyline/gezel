const COMPONENT_CSS =
  ' :host{display:block;color:var(--gezel-component-text,#302b25);font:400 15px/1.45 var(--font-ui,system-ui,sans-serif);--surface:var(--gezel-component-surface,#fffcf6);--line:var(--gezel-component-border,#cfc7bc);--muted:var(--gezel-component-muted,#655d53);--accent:var(--gezel-component-accent,#805128)}\n  :host([data-theme="dark"]){--surface:var(--gezel-component-surface,#26292b);--line:var(--gezel-component-border,#555b5d);--muted:var(--gezel-component-muted,#b7b5af);--accent:var(--gezel-component-accent,#e0b78b);color:var(--gezel-component-text,#f0ece5)}\n  *{box-sizing:border-box}button,input{font:inherit;color:inherit}button{cursor:pointer}button:disabled{cursor:default;opacity:.6}button:focus-visible{outline:3px solid var(--accent);outline-offset:3px}button{border:1px solid var(--line);border-radius:6px;background:var(--surface);padding:9px 14px}p{margin:6px 0}small{color:var(--muted)}[hidden]{display:none!important}.error{color:inherit;font-weight:600}\n  .card{width:100%;padding:0;display:flex;flex-direction:column;text-align:left;overflow:hidden;min-width:0}.preview{background:color-mix(in srgb,var(--line) 30%,transparent);height:150px;display:grid;place-items:center;font-size:20px;color:var(--muted);flex-shrink:0}.preview img{width:100%;height:100%;object-fit:cover;min-height:0}.info{padding:12px;min-width:0}.name{font-weight:600;overflow-wrap:anywhere}.meta{color:var(--muted);font-size:13px;overflow-wrap:anywhere}.row{flex-direction:row;align-items:center}.row .preview{width:64px;height:64px;font-size:14px}.row .info{padding:8px 12px}.adder{border:1px dashed var(--line);border-radius:6px;padding:16px;background:var(--surface)}.adder.drag{outline:3px solid var(--accent);outline-offset:2px}.actions{display:flex;gap:8px;flex-wrap:wrap}.results{padding-left:20px;max-height:160px;overflow:auto;font-size:13px}progress{width:100%;accent-color:var(--accent)}';
/** One dependency-free runtime, injected by hosts and bundled by demo publishing/export tooling.
 * Keep it self-contained: neither page assets nor a React/bundler runtime are required.
 */
export function pageComponentsSource(): string {
  return String.raw`(function(){
if(window.installGezelComponents)return;
window.installGezelComponents=function(api,transport){
  if(api.ui.components)return api.ui.components;
  transport=transport||{};
  var demo=api.page.mode==='demo', demoFiles=[], urls=new Map();
  var demoTargets=transport.demoTargets||[];
  var originalUrl=api.data.url.bind(api.data);
  if(demo)api.data.url=function(path,opts){return urls.get(path)||originalUrl(path,opts);};
  api.data.importTargets=demo?async function(){return demoTargets.map(function(t){return Object.assign({},t,{writable:true});});}:(transport.targets||async function(){throw new Error('Add files requires a newer Gezel desktop app.');});
  api.data.importFiles=async function(files,opts){
    opts=opts||{}; files=Array.from(files);
    if(files.length>100)throw new Error('Choose at most 100 files at a time.');
    var targets=await api.data.importTargets(), target=targets.find(function(t){return t.id===opts.target;});
    if(!target||!target.writable)throw new Error(target&&target.reason||'This import destination is unavailable.');
    var results=[];
    for(var i=0;i<files.length;i++){
      var file=files[i], result;
      try{
        if(opts.signal&&opts.signal.aborted)throw new Error('Import cancelled.');
        if(!(file instanceof Blob)||typeof file.name!=='string')throw new Error('Choose a file.');
        if(!/^(?!\.)(?!.*[. ]$)(?!(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$))[^<>:"/\\|?*\x00-\x1f]{1,180}$/i.test(file.name))throw new Error('Unsupported filename.');
        var ext=(file.name.match(/\.[^.]+$/)||[''])[0].toLowerCase();
        if(target.accept&&!target.accept.includes(ext))throw new Error('This file type is not accepted here.');
        if(file.size>Math.min(target.maxFileBytes||268435456,268435456))throw new Error('File exceeds the import size limit.');
        if(opts.onProgress)opts.onProgress({completed:i,total:files.length,name:file.name});
        var saved;
        if(demo){
          var name=file.name, base=target.path==='.'?'':target.path.replace(/\/$/,'')+'/';
          var occupied=(transport.existingPaths||[]).concat(demoFiles.map(function(f){return f.path;}));
          for(var n=1;occupied.includes(base+name);n++)name=file.name.slice(0,file.name.length-ext.length)+' ('+n+')'+ext;
          saved={source:'workspace',path:base+name,name:name,size:file.size,mtime:1700000000000};
          demoFiles.push(saved);urls.set(saved.path,URL.createObjectURL(file));
        }else saved=await transport.file(file,target.id,opts.signal);
        result={ok:true,name:file.name,file:saved};
      }catch(error){result={ok:false,name:file.name||'File',error:error.message||String(error)};}
      results.push(result);
      if(opts.onProgress)opts.onProgress({completed:i+1,total:files.length,name:file.name});
    }
    return results;
  };
  var css=__COMPONENT_CSS__;
  function el(tag,text){var e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;}
  function setup(target,tag){
    var mount=typeof target==='string'?document.querySelector(target):target;
    if(!mount)throw new Error('Component mount element not found.');
    if(!customElements.get(tag))customElements.define(tag,class extends HTMLElement{
      connectedCallback(){if(this.connect)this.connect();}
      disconnectedCallback(){if(this.disconnect)this.disconnect();}
    });
    var host=el(tag),root=host.attachShadow({mode:'open'}),style=el('style',css),unsubscribe;
    root.append(style);
    host.connect=function(){host.setAttribute('data-theme',api.ui.theme.mode);unsubscribe=api.ui.onTheme(function(t){host.setAttribute('data-theme',t.mode);});};
    host.disconnect=function(){if(unsubscribe)unsubscribe();unsubscribe=null;};
    mount.append(host);
    return {host:host,root:root};
  }
  function size(bytes){return bytes===undefined?'':bytes<1024?bytes+' B':bytes<1048576?(bytes/1024).toFixed(1)+' KB':(bytes/1048576).toFixed(1)+' MB';}
  function fileCard(target,options){
    var s=setup(target,'gezel-file-card'),opts=options,button=el('button'),preview=el('span'),info=el('span'),name=el('span'),meta=el('span'),status=el('p');
    button.type='button';preview.className='preview';info.className='info';name.className='name';meta.className='meta';name.style.display=meta.style.display='block';status.setAttribute('role','status');status.hidden=true;
    info.append(name,meta);button.append(preview,info);s.root.append(button,status);
    function render(){
      var f=opts.file,filename=f.name||f.path.split('/').pop(),ext=(filename.split('.').pop()||'file').toUpperCase();
      button.className='card'+(opts.variant==='row'?' row':'');name.textContent=filename;button.setAttribute('aria-label','Open '+filename);
      meta.textContent=[f.path.includes('/')?f.path.slice(0,f.path.lastIndexOf('/')):'',size(f.size),f.mtime?new Date(f.mtime).toLocaleDateString(): ''].filter(Boolean).join(' · ');
      preview.replaceChildren(el('span',ext));status.hidden=true;
      if(opts.thumbnail!==false&&/\.(png|jpe?g|gif|webp|avif|bmp|svg|ico)$/i.test(f.path)){
        try{var img=el('img');img.alt='';img.loading='lazy';img.src=typeof opts.thumbnail==='string'?opts.thumbnail:api.data.url(f.path,{source:f.source||'workspace'});img.onerror=function(){preview.replaceChildren(el('span',ext));};preview.replaceChildren(img);}catch(_){}
      }
    }
    button.onclick=async function(){try{if(opts.onActivate)await opts.onActivate(opts.file);else{if(typeof api.data.open!=='function')throw new Error('Open this file in Gezel to use its viewer.');await api.data.open(opts.file.path,{source:opts.file.source||'workspace'});}}catch(e){status.textContent=e.message||String(e);status.hidden=false;}};
    render();
    return {element:s.host,update:function(next){opts=Object.assign({},opts,next);render();},destroy:function(){s.host.remove();s.host.disconnect();}};
  }
  function fileAdder(target,options){
    var s=setup(target,'gezel-file-adder'),opts=options,box=el('div'),actions=el('div'),pick=el('button','Add files'),cancel=el('button','Cancel'),input=el('input'),description=el('p'),status=el('p'),progress=el('progress'),results=el('ul'),controller=null,destroyed=false,writable=false;
    box.className='adder';actions.className='actions';results.className='results';pick.type=cancel.type='button';input.type='file';input.multiple=true;input.hidden=true;pick.disabled=true;cancel.hidden=progress.hidden=results.hidden=true;status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    actions.append(pick,cancel,input);box.append(actions,description,status,progress,results);s.root.append(box);
    async function refresh(){
      try{var targets=await api.data.importTargets(),t=targets.find(function(t){return t.id===opts.target;});if(destroyed)return;writable=!!(t&&t.writable);pick.disabled=!writable||!!controller;input.accept=t&&t.accept?t.accept.join(','):'';description.textContent=t?'Drop files here or use Add files. Destination: '+(t.path==='.'?'workspace folder':t.path)+(demo?' · Demo only — files stay in this tab.':' · Originals are kept; duplicate names get a number.'):'No import destination is configured.';status.textContent=writable?'':t&&t.reason||'This import destination is unavailable.';}catch(e){if(!destroyed){writable=false;pick.disabled=true;description.textContent='Add files';status.textContent=e.message||String(e);}}
    }
    async function add(files){
      if(!writable||controller||!files.length)return;
      controller=new AbortController();var own=controller;pick.disabled=true;cancel.hidden=false;cancel.disabled=false;progress.hidden=false;progress.value=0;progress.max=files.length;results.replaceChildren();results.hidden=true;box.setAttribute('aria-busy','true');
      try{
        var outcome=await api.data.importFiles(files,{target:opts.target,signal:own.signal,onProgress:function(p){if(!destroyed){progress.value=p.completed;status.textContent='Adding '+p.name+' ('+p.completed+'/'+p.total+')';}}});
        if(destroyed)return;
        outcome.forEach(function(r){results.append(el('li',r.ok?'Added '+r.file.path:r.name+': '+r.error));});results.hidden=false;
        var added=outcome.filter(function(r){return r.ok;}).map(function(r){return r.file;});
        status.textContent=added.length+' of '+outcome.length+' files added'+(demo?' to this demo.':'.');
        if(added.length&&opts.onAdded)await opts.onAdded(added);
      }catch(e){if(!destroyed)status.textContent=e.message||String(e);}
      finally{controller=null;if(!destroyed){cancel.hidden=progress.hidden=true;pick.disabled=!writable;box.removeAttribute('aria-busy');}}
    }
    pick.onclick=function(){input.click();};input.onchange=function(){var files=Array.from(input.files||[]);input.value='';void add(files);};
    cancel.onclick=function(){if(controller)controller.abort();cancel.disabled=true;};
    box.ondragover=function(e){e.preventDefault();if(writable&&!controller){e.dataTransfer.dropEffect='copy';box.classList.add('drag');}};
    box.ondragleave=function(){box.classList.remove('drag');};
    box.ondrop=function(e){e.preventDefault();box.classList.remove('drag');void add(Array.from(e.dataTransfer.files||[]));};
    var disconnect=s.host.disconnect;s.host.disconnect=function(){disconnect();if(controller)controller.abort();};
    void refresh();
    return {element:s.host,refresh:refresh,update:function(next){opts=Object.assign({},opts,next);void refresh();},destroy:function(){destroyed=true;s.host.remove();s.host.disconnect();}};
  }
  var components={version:1,fileCard:fileCard,fileAdder:fileAdder};
  if(demo)components.demo={files:function(){return demoFiles.slice();},reset:function(){urls.forEach(function(url){URL.revokeObjectURL(url);});urls.clear();demoFiles=[];}};
  api.ui.components=components;
  return components;
};
})();`.replace('__COMPONENT_CSS__', JSON.stringify(COMPONENT_CSS));
}
