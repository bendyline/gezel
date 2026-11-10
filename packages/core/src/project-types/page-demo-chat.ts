const DEMO_CHAT_CSS =
  '.dc{display:flex;flex-direction:column;height:100%;min-height:0;gap:10px}.log{position:relative;flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:12px;padding:2px 4px 4px 2px;overscroll-behavior:contain}.msg{display:flex;flex-direction:column;gap:6px;min-width:0}.who{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted);user-select:none}.who b{font-weight:600;color:var(--gezel-component-text,inherit)}.avatar{width:28px;height:28px;flex:none;border-radius:50%;overflow:hidden;display:grid;place-items:center;background:color-mix(in srgb,var(--accent) 20%,var(--surface));color:var(--accent);font-weight:600;font-size:13px}.avatar img{width:100%;height:100%;object-fit:cover}.body{font:15px/1.5 var(--font-heading,Georgia,serif);overflow-wrap:anywhere;user-select:text}.body p{margin:0 0 8px}.body p:last-child,.body ul:last-child{margin-bottom:0}.body ul{margin:2px 0 8px;padding-left:20px}.body li{margin:2px 0}.you{align-self:flex-end;max-width:86%}.you .body{padding:8px 12px;border-radius:10px;background:color-mix(in srgb,var(--accent) 15%,transparent);border:1px solid color-mix(in srgb,var(--accent) 32%,transparent)}.step{display:flex;align-items:flex-start;gap:8px;font-size:13px;color:var(--muted);padding:6px 10px;border:1px solid var(--line);border-radius:6px;background:color-mix(in srgb,var(--line) 14%,transparent)}.step svg{flex:none;width:14px;height:14px;margin-top:2px}.step b{font-weight:600;color:var(--gezel-component-text,inherit)}.step.failed b{text-decoration:line-through}.step.running svg{opacity:.5}.typing{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted)}.dots{display:inline-flex;gap:3px}.dots i{width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.35;animation:dc-dot 1.1s ease-in-out infinite}.dots i:nth-child(2){animation-delay:.18s}.dots i:nth-child(3){animation-delay:.36s}@keyframes dc-dot{40%{opacity:1}}.ideas{display:flex;flex-wrap:wrap;gap:6px}.ideas button{font-size:13px;line-height:1.3;padding:6px 10px;text-align:left;max-width:100%}.ideas button:hover:not(:disabled){border-color:var(--accent)}.composer{display:flex;gap:8px;align-items:flex-end}textarea{flex:1;min-width:0;min-height:44px;max-height:140px;resize:none;box-sizing:border-box;padding:10px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:inherit;font:15px/1.4 var(--font-ui,system-ui,sans-serif)}textarea::placeholder{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}textarea:focus-visible{outline:3px solid var(--accent);outline-offset:1px}.send{min-height:44px;background:var(--action,var(--accent));border-color:var(--action,var(--accent));color:var(--on-action,var(--surface));font-weight:600}.note{margin:0;font-size:12px;color:var(--muted)}@media(max-width:900px){.ideas{flex-wrap:nowrap;overflow-x:auto;padding-bottom:2px;scrollbar-width:thin}.ideas button{flex:none;white-space:nowrap}}@media(prefers-reduced-motion:reduce){.dots i{animation:none;opacity:.7}}';

/**
 * The sample conversation a standalone demo draws where the host's chat would
 * be. The page scripts it through `makeDemoGezel({ chat })`: replies, the
 * tools they call (the page's own demo handlers, so the page visibly changes),
 * and reactions to page actions. Nothing leaves the page, and the composer
 * says the replies are scripted.
 */
export function pageDemoChatSource(): string {
  return String.raw`function installDemoConversation(api,script,config){
  script=script&&typeof script==='object'?script:{};
  var known=config&&config.companion||{},name=script.name||known.name||'',role=script.role||known.role||'',avatar=script.avatar||known.avatar||'';
  var label=name||role||'Your companion',css=__DEMO_CHAT_CSS__;
  var reduced=!!(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches);
  var log=[],views=[],ideas=Array.isArray(script.suggestions)?script.suggestions.slice():[],used={},busy=false,typing=false,tail=Promise.resolve(),etag=0,watchers=[];
  var invoke=api.tools.invoke.bind(api.tools),watch=api.data.watch.bind(api.data),read=api.data.read.bind(api.data);
  function el(tag,text){var e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;}
  // A live read or tool result is fresh JSON; sample handlers often hand back the very object their tools mutate.
  function copy(value){var proto=value&&typeof value==='object'?Object.getPrototypeOf(value):null;if(proto!==Object.prototype&&proto!==Array.prototype)return value;try{return JSON.parse(JSON.stringify(value));}catch(_){return value;}}
  api.data.read=function(path,opts){return read(path,opts).then(copy);};
  function pause(ms){return new Promise(function(done){setTimeout(done,reduced?0:ms);});}
  // The live host repaints watchers after a write; the demo does the same for the companion's writes.
  api.data.watch=function(path,cb,opts){var stop=watch(path,cb,opts),entry={path:String(path),cb:cb};watchers.push(entry);return function(){var i=watchers.indexOf(entry);if(i>=0)watchers.splice(i,1);stop();};};
  function changed(){etag++;watchers.slice().forEach(function(w){try{w.cb({path:w.path,etag:'demo-'+etag});}catch(_){}});window.dispatchEvent(new Event('gezel-app-data-changed'));}
  // A visitor watches the conversation, so point at what the companion's tool changed on the page.
  function texts(){var seen=new Map();document.querySelectorAll('body *').forEach(function(node){if(seen.size>4000||node.closest('[data-gezel-demo-banner],script,style,template'))return;var own=Array.from(node.childNodes).filter(function(c){return c.nodeType===3;}).map(function(c){return c.data;}).join('').trim();if(own)seen.set(node,own);});return seen;}
  function highlight(before){
    if(reduced)return;var old=new Set(before.values()),fresh=[];
    texts().forEach(function(text,node){if(!old.has(text)&&node.getClientRects().length)fresh.push(node);});
    if(!fresh.length||fresh.length>16)return;
    fresh.forEach(function(node){if(node.animate)node.animate([{backgroundColor:'rgba(176,114,76,.32)',boxShadow:'0 0 0 3px rgba(176,114,76,.32)'},{backgroundColor:'rgba(176,114,76,0)',boxShadow:'0 0 0 3px rgba(176,114,76,0)'}],{duration:1800,easing:'ease-out'});});
    // Only beside a sticky companion: stacked below the page, scrolling would carry the conversation away.
    var hidden=fresh.find(function(node){var box=node.getBoundingClientRect();return box.bottom<0||box.top>innerHeight;});
    if(innerWidth>900&&hidden&&!fresh.some(function(node){var box=node.getBoundingClientRect();return box.top>=0&&box.bottom<=innerHeight&&node.closest('main')&&node.offsetHeight>40;}))window.scrollBy({top:hidden.getBoundingClientRect().top-innerHeight/3,behavior:'smooth'});
  }
  // A page action may summon the companion, as a manifest reaction does in Gezel.
  api.tools.invoke=function(tool,input){return invoke(tool,input).then(function(result){var react=script.reactions&&script.reactions[tool];if(typeof react==='function')turn(null,function(ctx){return react(input||{},result.output,ctx);});return result;});};
  function emit(method,entry){views.forEach(function(view){view[method](entry);});}
  function add(entry){log.push(entry);emit('render',entry);return entry;}
  function setBusy(on){busy=on;views.forEach(function(view){view.sync();});}
  function setTyping(on){typing=on;views.forEach(function(view){view.sync();});}
  function speak(text){
    text=String(text==null?'':text).trim();if(!text)return Promise.resolve();
    var entry=add({kind:'gezel',text:reduced?text:''});
    if(reduced)return Promise.resolve();
    var words=text.split(/(\s+)/),shown=0,step=Math.max(1,Math.ceil(words.length/70));
    return new Promise(function(done){(function next(){shown=Math.min(words.length,shown+step);entry.text=words.slice(0,shown).join('');emit('render',entry);if(shown<words.length)setTimeout(next,22);else done();})();});
  }
  function context(){
    return {
      page:api.page,
      read:function(path,opts){return api.data.read(path,opts);},
      say:speak,
      suggest:function(next){suggest(next);views.forEach(function(view){view.sync();});},
      invoke:function(tool,input,summary){
        return Promise.resolve(api.tools.list()).catch(function(){return [];}).then(function(names){
          var target=names.indexOf(tool)<0&&names.indexOf('page_'+tool)>=0?'page_'+tool:tool;
          var entry=add({kind:'step',tool:String(tool).replace(/^page_/,''),summary:summary||'',state:'running'});
          var before=texts(),was;
          return watched().then(function(snapshot){was=snapshot;return pause(420);}).then(function(){return invoke(target,input||{});}).then(function(result){
            entry.state='done';emit('render',entry);
            // A read (a status or board tool) leaves the watched files as they were: nothing to repaint.
            return watched().then(function(now){if(!watchers.length||now!==was){changed();setTimeout(function(){highlight(before);},140);}return copy(result.output);});
          },function(error){entry.state='failed';entry.error=error&&error.message||String(error);emit('render',entry);throw error;});
        });
      },
    };
  }
  function watched(){var paths=Array.from(new Set(watchers.map(function(w){return w.path;})));return Promise.all(paths.map(function(path){return api.data.read(path).then(function(value){try{return JSON.stringify(value);}catch(_){return String(Math.random());}},function(){return '';});})).then(function(all){return all.join('\u0000');});}
  // Fresh suggestions may repeat wording used earlier in the conversation.
  function suggest(next){ideas=next.slice();used={};}
  function deliver(reply,asked){
    if(reply&&typeof reply==='object'&&!Array.isArray(reply)){if(Array.isArray(reply.suggestions))suggest(reply.suggestions);reply=reply.reply||reply.text||'';}
    if(Array.isArray(reply))return reply.reduce(function(chain,line){return chain.then(function(){return pause(260).then(function(){return speak(line);});});},Promise.resolve());
    if(!reply&&asked)reply='I can only follow a few sample requests in this preview'+(remaining().length?', like the ones below':'')+'. In Gezel I work on anything in this project, with the model you choose.';
    return speak(reply);
  }
  function turn(asked,produce){
    tail=tail.then(function(){
      setBusy(true);setTyping(true);
      return pause(asked?560+Math.min(700,asked.length*7):380).then(function(){return produce(context());})
        .then(function(reply){setTyping(false);return deliver(reply,asked);},function(error){setTyping(false);return speak('That did not work in this preview. '+(error&&error.message||'Try another request.'));})
        .then(function(){setBusy(false);});
    });
    return tail;
  }
  function remaining(){var left=ideas.filter(function(idea){return !used[idea];});return left;}
  function send(text){
    text=String(text||'').trim();if(!text||busy)return false;
    used[text]=1;add({kind:'you',text:text});
    turn(text,function(ctx){return typeof script.respond==='function'?script.respond(text,ctx):null;});
    return true;
  }
  function inline(target,text){text.split(/(\*\*[^*\n]+\*\*)/).forEach(function(part){if(/^\*\*[^*\n]+\*\*$/.test(part))target.append(el('strong',part.slice(2,-2)));else if(part)target.append(document.createTextNode(part));});}
  // Paragraphs, and runs of "- " lines as lists, so "Bring these:" may sit directly above its bullets.
  function rich(target,text){
    target.replaceChildren();
    text.split(/\n{2,}/).forEach(function(block){
      var node=null;
      block.split('\n').forEach(function(line){
        var bullet=/^\s*[-*]\s+/.test(line),kind=bullet?'UL':'P';
        if(!node||node.tagName!==kind){node=el(kind.toLowerCase());target.append(node);}else if(!bullet)node.append(el('br'));
        if(bullet){var item=el('li');inline(item,line.replace(/^\s*[-*]\s+/,''));node.append(item);}else inline(node,line);
      });
    });
  }
  function humanize(tool){var words=tool.replace(/[_-]+/g,' ').trim();return words.charAt(0).toUpperCase()+words.slice(1);}
  function mark(state){var ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg'),path=document.createElementNS(ns,'path');svg.setAttribute('viewBox','0 0 16 16');svg.setAttribute('aria-hidden','true');path.setAttribute('fill','none');path.setAttribute('stroke','currentColor');path.setAttribute('stroke-width','1.8');path.setAttribute('stroke-linecap','round');path.setAttribute('d',state==='failed'?'M4 4l8 8M12 4l-8 8':state==='running'?'M3 8h2M7 8h2M11 8h2':'M3 8.5l3.2 3L13 4.5');svg.append(path);return svg;}
  function face(){var badge=el('span');badge.className='avatar';if(avatar){var img=el('img');img.alt='';img.src=avatar;img.onerror=function(){badge.replaceChildren(label.charAt(0).toUpperCase());};badge.append(img);}else badge.textContent=label.charAt(0).toUpperCase();return badge;}
  function mount(opts,root){
    opts=Object.assign({},opts);
    var style=el('style',css),wrap=el('div'),list=el('div'),pending=el('div'),dots=el('span'),choices=el('div'),composer=el('div'),input=el('textarea'),button=el('button','Send'),note=el('p','Sample conversation. In Gezel, replies come from the model you choose.'),nodes=new Map();
    wrap.className='dc';list.className='log';list.setAttribute('role','log');list.setAttribute('aria-live','polite');list.setAttribute('aria-label','Conversation with '+label);list.tabIndex=0;
    pending.className='typing';dots.className='dots';dots.append(el('i'),el('i'),el('i'));pending.append(dots,el('span',label+' is working…'));pending.hidden=true;
    choices.className='ideas';choices.setAttribute('role','group');choices.setAttribute('aria-label','Try asking');
    composer.className='composer';input.rows=1;input.setAttribute('aria-label','Message '+label);button.type='button';button.className='send';note.className='note';
    composer.append(input,button);list.append(pending);wrap.append(list,choices,composer,note);root.append(style,wrap);
    function placeholder(){input.placeholder=opts.placeholder||'Message '+label+'…';}
    // Follow the conversation, but never past the start of a message taller than the view. Every new
    // entry answers the visitor's own send or page action, so it always comes into view; only a reply
    // still streaming respects a reader who has scrolled away.
    function follow(force){var near=force||list.scrollHeight-list.scrollTop-list.clientHeight<120;return function(anchor){if(!near)return;var end=list.scrollHeight-list.clientHeight;list.scrollTop=anchor?Math.min(end,anchor.offsetTop-8):end;};}
    function lastMessage(){for(var i=log.length-1;i>=0;i--)if(log[i].kind!=='step')return nodes.get(log[i]);return null;}
    function render(entry){
      var node=nodes.get(entry),fresh=!node,keep=follow(fresh);
      if(fresh){
        if(entry.kind==='step'){node=el('div');node.className='step';}
        else{node=el('div');node.className='msg '+(entry.kind==='you'?'you':'gezel');var before=log[log.indexOf(entry)-1];if(entry.kind==='gezel'&&!(before&&before.kind==='gezel')){var who=el('div');who.className='who';who.append(face(),el('b',name||role||label));if(name&&role)who.append(el('span',role));node.append(who);}var body=el('div');body.className='body';node.append(body);}
        nodes.set(entry,node);list.insertBefore(node,pending);
      }
      if(entry.kind==='step'){node.className='step '+entry.state;var text=el('span'),title=el('b',humanize(entry.tool));text.append(title);if(entry.summary)text.append(document.createTextNode(' · '+entry.summary));if(entry.state==='failed')text.append(document.createTextNode(' — '+entry.error));node.title=entry.tool;node.replaceChildren(mark(entry.state),text);}
      else{var target=node.querySelector('.body');if(entry.kind==='you')target.textContent=entry.text;else rich(target,entry.text);}
      keep(entry.kind==='step'?null:node);
    }
    function sync(){
      var keep=follow(typing);pending.hidden=!typing;button.disabled=busy;
      choices.replaceChildren();var left=remaining();choices.hidden=!left.length;
      left.forEach(function(idea){var key=el('button',idea);key.type='button';key.disabled=busy;key.onclick=function(){if(send(idea))list.focus({preventScroll:true});};choices.append(key);});
      keep(typing?null:lastMessage());
    }
    function grow(){input.style.height='auto';input.style.height=Math.min(140,input.scrollHeight)+'px';}
    function submit(){if(send(input.value)){input.value='';grow();}}
    button.onclick=submit;input.oninput=grow;
    input.onkeydown=function(event){if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();submit();}};
    var view={render:render,sync:sync};views.push(view);placeholder();
    if(!log.length){var hello=script.greeting||('Hello. I’m '+(name?name+(role?', your '+role.toLowerCase():''):role?'your '+role.toLowerCase():label.toLowerCase())+'. Ask me about this sample project.');log.push({kind:'gezel',text:String(hello)});}
    log.forEach(render);sync();
    return Promise.resolve({position:function(){},update:function(next){opts=Object.assign({},opts,next);placeholder();},destroy:function(){var i=views.indexOf(view);if(i>=0)views.splice(i,1);wrap.remove();style.remove();}});
  }
  return {mount:mount,send:send};
}`.replace('__DEMO_CHAT_CSS__', JSON.stringify(DEMO_CHAT_CSS));
}
