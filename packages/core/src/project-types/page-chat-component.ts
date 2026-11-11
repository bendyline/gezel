/** The page owns only a slot; the trusted parent owns the actual chat and input. */
export function pageChatComponentSource(): string {
  return String.raw`function chat(target,options){
    var s=setup(target,'gezel-chat'),opts=Object.assign({},options),stopped=false,frame=0,last='',remote=null,watched=new WeakSet();
    s.host.style.height='100%';s.host.style.minHeight='0';
    var status=el('p','Opening chat…');status.setAttribute('role','status');s.root.append(status);
    var ready=transport.chat?transport.chat(opts,s.root):Promise.reject(new Error(demo?'Chat is available in Gezel. This demo does not send messages.':'Chat is unavailable in this host. Open this app in Gezel.'));
    // A page modal dims everything behind it, and the conversation the host draws above the frame is behind it too.
    // Name the modal's area and backdrop so the host dims the conversation to match and leaves the modal uncovered.
    // A component's own modal lives in its shadow root, so its host carries a marker.
    function modal(){
      var found=null,scrim='';
      function add(node){
        if(node.contains(s.host)||!node.getClientRects().length)return;
        // A dialog can grow while open. Observing again re-reports its size, which would reschedule this every frame.
        if(!watched.has(node)){watched.add(node);resize.observe(node);}
        found=found||[];var b=node.getBoundingClientRect();
        if(found.length<8)found.push({x:Math.round(b.left)-12,y:Math.round(b.top)-12,width:Math.round(b.width)+24,height:Math.round(b.height)+24});
        if(!scrim&&node.tagName==='DIALOG'){try{scrim=getComputedStyle(node,'::backdrop').backgroundColor||'';}catch(_){}}
      }
      document.querySelectorAll('dialog[open],[aria-modal="true"]').forEach(function(node){
        if(node.tagName==='DIALOG'){try{if(!node.matches(':modal'))return;}catch(_){}}
        add(node);
      });
      document.querySelectorAll('[data-gezel-dialog-open]').forEach(function(host){
        var dialog=host.shadowRoot&&host.shadowRoot.querySelector('dialog[open]');
        if(dialog)add(dialog);
      });
      if(!found)return null;
      var result={areas:found};if(/^rgba?\([0-9.,\s%/]+\)$/.test(scrim))result.scrim=scrim;
      return result;
    }
    function position(){
      frame=0;
      if(stopped||!s.host.isConnected)return;
      var r=s.host.getBoundingClientRect(),x=r.left,y=r.top,right=r.right,bottom=r.bottom;
      for(var p=s.host.parentElement;p;p=p.parentElement){
        var style=getComputedStyle(p),box=p.getBoundingClientRect();
        if(style.overflowX!=='visible'){x=Math.max(x,box.left);right=Math.min(right,box.right);}
        if(style.overflowY!=='visible'){y=Math.max(y,box.top);bottom=Math.min(bottom,box.bottom);}
      }
      x=Math.max(0,x);y=Math.max(0,y);right=Math.min(innerWidth,right);bottom=Math.min(innerHeight,bottom);
      var rect={x:x,y:y,width:Math.max(0,right-x),height:Math.max(0,bottom-y)};
      if(!s.host.getClientRects().length||getComputedStyle(s.host).visibility==='hidden')rect.width=rect.height=0;
      var dim=rect.width&&rect.height?modal():null;
      var next=JSON.stringify([rect,dim]);if(remote&&next!==last){last=next;remote.position(rect,dim);}
    }
    function schedule(){if(!stopped&&!frame)frame=requestAnimationFrame(position);}
    var resize=new ResizeObserver(schedule),mutation=new MutationObserver(schedule);
    resize.observe(s.host);
    mutation.observe(document.documentElement,{subtree:true,childList:true,attributes:true});
    window.addEventListener('resize',schedule);
    document.addEventListener('scroll',schedule,true);
    ready=ready.then(function(handle){
      remote=handle;
      if(stopped){remote.destroy();return;}
      status.hidden=true;remote.update(opts);position();
    });
    ready.catch(function(error){if(!stopped)status.textContent=error.message||String(error);});
    var disconnect=s.host.disconnect;
    function destroy(){if(stopped)return;stopped=true;cancelAnimationFrame(frame);resize.disconnect();mutation.disconnect();window.removeEventListener('resize',schedule);window.removeEventListener('pagehide',destroy);document.removeEventListener('scroll',schedule,true);if(remote)remote.destroy();disconnect();s.host.remove();}
    window.addEventListener('pagehide',destroy);
    s.host.disconnect=destroy;
    return {element:s.host,ready:ready,update:function(next){if(stopped)return;opts=Object.assign({},opts,next);if(remote)remote.update(opts);},destroy:destroy};
  }`;
}
