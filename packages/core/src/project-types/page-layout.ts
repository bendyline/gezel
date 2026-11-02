/** Shared by the live shim and the generated offline demo bootstrap. */
export function pageLayoutSource(): string {
  // A standalone demo is the whole window, so it may present as expanded without the Fullscreen API.
  return String.raw`function installPageLayout(api,hosted,whole){
  var subs=[],full=false,current;
  function refresh(){
    var next=Object.freeze({fullscreen:hosted?full:!!whole||!!document.fullscreenElement,width:window.innerWidth,height:window.innerHeight});
    if(current&&current.fullscreen===next.fullscreen&&current.width===next.width&&current.height===next.height)return;
    current=next;
    document.documentElement.setAttribute('data-gezel-fullscreen',String(next.fullscreen));
    subs.slice().forEach(function(cb){try{cb(next);}catch(_){}});
  }
  Object.defineProperty(api.ui,'layout',{get:function(){return current;}});
  api.ui.onLayout=function(cb){subs.push(cb);return function(){var i=subs.indexOf(cb);if(i>=0)subs.splice(i,1);};};
  window.addEventListener('resize',refresh);
  document.addEventListener('fullscreenchange',refresh);
  refresh();
  return function(value){if(value&&typeof value.fullscreen==='boolean'){full=value.fullscreen;refresh();}};
}`;
}
