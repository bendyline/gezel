/** Shared application furniture. Data and tool authority stay with the page API. */
export function pageAppComponentsSource(): string {
  return String.raw`
  // minItems hides the search box until the collection is long enough to need one; a typed query keeps it.
  function collectionFilter(target,options){
    var opts=options,s=setup(target,'gezel-collection-filter'),label=el('label'),caption=el('span',opts.label||'Search'),input=el('input'),status=el('p'),stopped=false;
    var container=typeof opts.container==='string'?document.querySelector(opts.container):opts.container;
    if(!container)throw new Error('Search collection not found.');
    input.type='search';input.placeholder=opts.placeholder||'';input.setAttribute('aria-label',opts.label||'Search');input.style.cssText='width:100%;min-height:44px;box-sizing:border-box;padding:10px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:inherit;font:inherit';caption.style.cssText='display:block;font-size:14px;margin-bottom:6px';status.style.cssText='font-size:13px;color:var(--muted)';status.setAttribute('role','status');status.setAttribute('aria-live','polite');label.append(caption,input);s.root.append(label,status);
    function normalize(value){return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();}
    function filter(){if(stopped)return;var query=normalize(input.value.trim()),items=Array.from(container.querySelectorAll(opts.selector)),found=0;items.forEach(function(item){var matches=!query||normalize(item.textContent).includes(query);item.hidden=!matches;if(matches)found++;});s.host.hidden=!query&&opts.minItems>0&&items.length<opts.minItems;status.textContent=query?found+' of '+items.length+' matches':'';}
    input.oninput=filter;var observer=new MutationObserver(filter);observer.observe(container,{subtree:true,childList:true,characterData:true});filter();
    return {element:s.host,update:function(next){opts=Object.assign({},opts,next);filter();},destroy:function(){stopped=true;observer.disconnect();container.querySelectorAll(opts.selector).forEach(function(item){item.hidden=false;});s.host.remove();s.host.disconnect();}};
  }
  function appLayout(target,options){
    var content=typeof target==='string'?document.querySelector(target):target;
    if(!content||!content.parentElement)throw new Error('Application content not found.');
    var parent=content.parentElement,next=content.nextSibling,oldSlot=content.getAttribute('slot'),oldMaxWidth=content.style.maxWidth,oldMargin=content.style.margin,opts=options||{},stopped=false,conversation=null,collapsed=false;
    // Layout wraps authored content: its fonts, colors, and custom properties must
    // inherit from the page, not the component theme. Theme only our own furniture.
    var furnitureCss=css.replace(':host{','.companion,.toolbar{').replace(':host([data-theme="dark"]){',':host([data-theme="dark"]) .companion,:host([data-theme="dark"]) .toolbar{');
    var s=setup(parent,'gezel-app-layout',furnitureCss);parent.insertBefore(s.host,content);content.slot='content';s.host.append(content);
    var style=el('style',':host{display:block;max-width:1680px;margin:auto;--conversation-width:360px}.layout{display:block;min-width:0}.content{min-width:0}::slotted(main){min-width:0;box-sizing:border-box}.companion{display:none;min-width:0;margin:24px 24px 24px 0;padding:16px;border:1px solid var(--line);border-radius:10px;background:var(--surface);position:sticky;top:24px;height:calc(100dvh - 112px);max-height:960px;box-sizing:border-box}.intro{margin:0 0 12px}.intro h2{font:400 22px var(--font-heading,Georgia,serif);margin:0}.intro p{font-size:14px;color:var(--muted);margin:6px 0}.chat{flex:1;min-height:0}.toolbar{display:none;justify-content:flex-end;padding:12px 24px 0;gap:8px}.toolbar button{font-size:14px;min-height:36px}.toolbar[hidden]{display:none!important}.intro-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.intro-head button{flex-shrink:0;min-height:32px;padding:4px 10px;font-size:13px;color:var(--muted)}.unavailable{padding:20px 0;line-height:1.6}.expanded .toolbar{display:flex}.expanded.with-chat .layout{display:grid;grid-template-columns:minmax(0,1fr) var(--conversation-width);align-items:start}.expanded.with-chat .companion{display:flex;flex-direction:column}.expanded ::slotted(main){max-width:none;margin:0;padding:24px}.expanded:not(.with-chat) ::slotted(main){max-width:1280px;margin:auto}.companion[hidden]{display:none!important}@media(max-width:900px){.expanded.with-chat .layout{grid-template-columns:minmax(0,1fr)}.companion{position:relative;top:auto;margin:0 16px 24px;height:520px;max-height:80dvh}.expanded ::slotted(main){padding:16px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto}}');
    var wrapper=el('div'),toolbar=el('div'),toggle=el('button'),layout=el('div'),work=el('div'),slot=el('slot'),aside=el('aside'),intro=el('div'),introHead=el('div'),heading=el('h2'),description=el('p'),chatRegion=el('div'),chatSlot=el('slot'),unavailable=el('p');
    toolbar.className='toolbar';toggle.type='button';layout.className='layout';work.className='content';slot.name='content';aside.className='companion';intro.className='intro';introHead.className='intro-head';chatRegion.className='chat';chatSlot.name='conversation';unavailable.className='unavailable';unavailable.setAttribute('role','status');
    var mount=el('div');mount.slot='conversation';mount.style.cssText='display:block;height:100%;min-height:0;min-width:0';s.host.append(mount);
    introHead.append(heading);intro.append(introHead,description);chatRegion.append(chatSlot);aside.append(intro,unavailable,chatRegion);work.append(slot);layout.append(work,aside);toolbar.append(toggle);wrapper.append(toolbar,layout);s.root.append(style,wrapper);
    // A page dialog dims the host-drawn conversation rather than emptying its panel: the chat component reports the modal (see chat()).
    function render(){
      if(stopped)return;
      var full=!!(api.ui.layout&&api.ui.layout.fullscreen),enabled=opts.chat!==false,visible=full&&enabled&&!collapsed;
      content.style.maxWidth=full?'none':oldMaxWidth;content.style.margin=full?'0':oldMargin;
      wrapper.className=(full?'expanded':'')+(visible?' with-chat':'');toolbar.hidden=!enabled||visible;aside.hidden=!visible;
      heading.textContent=opts.title||'Your companion';description.textContent=opts.description||'';description.hidden=!opts.description;
      // While the conversation shows, its Hide key sits in the panel header instead of costing a row above the page.
      if(visible){toggle.textContent='Hide';toggle.setAttribute('aria-label','Hide conversation');if(toggle.parentNode!==introHead)introHead.append(toggle);}else{toggle.textContent='Show conversation';toggle.removeAttribute('aria-label');if(toggle.parentNode!==toolbar)toolbar.append(toggle);}toggle.setAttribute('aria-expanded',String(!collapsed));
      var supported=(api.page.mode==='embedded'||demo&&!!transport.chat)&&typeof chat==='function';
      unavailable.hidden=supported;unavailable.textContent='Open this app in Gezel to talk with your companion.'+(api.page.mode==='demo'?' This preview keeps your sample work in this page.':' Your project work stays in its existing files.');
      if(visible&&supported&&!conversation){
        conversation=chat(mount,Object.assign({lockRecipient:true,showAddress:false,showThreads:false},opts.chat||{}));
        conversation.ready.catch(function(error){if(!stopped){unavailable.hidden=false;unavailable.textContent='Conversation could not open. '+(error.message||'Restore the page to use the project chat.');}});
      }
    }
    toggle.onclick=function(){collapsed=!collapsed;render();};
    var stopLayout=api.ui.onLayout?api.ui.onLayout(render):function(){};
    function destroy(){if(stopped)return;stopped=true;stopLayout();if(conversation)conversation.destroy();window.removeEventListener('pagehide',destroy);content.style.maxWidth=oldMaxWidth;content.style.margin=oldMargin;if(s.host.parentElement){parent.insertBefore(content,next&&next.parentNode===parent?next:s.host);if(oldSlot===null)content.removeAttribute('slot');else content.slot=oldSlot;}s.host.remove();s.host.disconnect();}
    window.addEventListener('pagehide',destroy,{once:true});render();
    return {element:s.host,update:function(next){opts=Object.assign({},opts,next);if(conversation&&opts.chat!==false)conversation.update(opts.chat||{});render();},destroy:destroy};
  }
  // presentation: 'disclosure' (the original expando), 'dialog' (a key that opens a modal) or 'inline' (an always-open form, for settings).
  function actionForm(target,options){
    var opts=options,mode=opts.presentation==='dialog'||opts.presentation==='inline'?opts.presentation:'disclosure';
    var s=setup(target,'gezel-action-form'),description=el('p'),fields=el('div'),submit=el('button'),status=el('p'),busy=false,stopped=false,pendingUpdate=false,controls=[];
    var box=null,summary=null,heading=null,trigger=null,dialog=null,cancel=null,flash=null,flashTimer=0,returnFocus=null,pressed=null;
    var style=el('style','details{border:1px solid var(--line);border-radius:10px;padding:14px;background:var(--surface)}summary{cursor:pointer;font-weight:600;min-height:24px;list-style-position:inside}summary:focus-visible{outline:2px solid var(--accent);outline-offset:4px}.fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:12px;margin:16px 0}label{display:flex;flex-direction:column;gap:6px;font-size:14px}input,select,textarea{box-sizing:border-box;min-width:0;width:100%;font:inherit;color:inherit;background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:10px;min-height:44px}textarea{min-height:90px;resize:vertical}.description{color:var(--muted);font-size:14px}button{min-height:44px}button:disabled{cursor:wait;opacity:.65}output{display:block;margin-top:10px}'
      +'input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:1px}.primary{background:var(--action);border-color:var(--action);color:var(--on-action);font-weight:600}:host([data-presentation="dialog"]){display:inline-block;position:relative;vertical-align:top}.trigger{font-weight:600;white-space:nowrap}.flash{position:absolute;left:0;top:calc(100% + 6px);z-index:2;margin:0;padding:4px 8px;border:1px solid var(--line);border-radius:4px;background:var(--surface);font-size:13px;white-space:nowrap;opacity:0;pointer-events:none;transition:opacity 160ms ease-out}.flash.show{opacity:1}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}'
      +'dialog{box-sizing:border-box;width:min(560px,calc(100vw - 32px));max-height:calc(100dvh - 32px);padding:0;border:1px solid var(--line);border-radius:12px;background:var(--surface);color:inherit;box-shadow:0 18px 48px rgba(28,24,20,.24)}dialog::backdrop{background:rgba(28,24,20,.36)}:host([data-theme="dark"]) dialog::backdrop{background:rgba(0,0,0,.56)}dialog[open]{animation:gezel-dialog-in 150ms ease-out}@keyframes gezel-dialog-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}@media(prefers-reduced-motion:reduce){dialog[open]{animation:none}.flash{transition:none}}.sheet{box-sizing:border-box;max-height:calc(100dvh - 34px);overflow:auto;padding:20px 24px}dialog h2{margin:0;font:400 22px/1.25 var(--font-heading,Georgia,serif)}dialog .description{margin:6px 0 0}dialog .fields{grid-template-columns:minmax(0,1fr);margin:18px 0 8px}.buttons{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-top:12px}'
      +'.inline{border:1px solid var(--line);border-radius:10px;padding:16px 18px;background:var(--surface)}.inline h3{margin:0;font:400 18px/1.3 var(--font-heading,Georgia,serif)}.inline .description{margin:4px 0 0}');
    fields.className='fields';description.className='description';submit.type='button';status.setAttribute('role','status');status.setAttribute('aria-live','polite');s.host.setAttribute('data-presentation',mode);
    if(mode==='dialog'){
      var sheet=el('div'),buttons=el('div');trigger=el('button');flash=el('p');dialog=el('dialog');heading=el('h2');cancel=el('button','Cancel');
      trigger.type='button';trigger.setAttribute('aria-haspopup','dialog');flash.className='flash';flash.setAttribute('role','status');flash.setAttribute('aria-live','polite');
      sheet.className='sheet';buttons.className='buttons';heading.id='title';dialog.setAttribute('aria-labelledby','title');cancel.type='button';submit.classList.add('primary');
      buttons.append(cancel,submit);sheet.append(heading,description,fields,status,buttons);dialog.append(sheet);box=sheet;s.root.append(style,trigger,flash,dialog);
      trigger.onclick=function(){show(undefined,trigger);};cancel.onclick=function(){close();};
      dialog.addEventListener('cancel',function(event){if(busy)event.preventDefault();});
      dialog.addEventListener('close',function(){s.host.removeAttribute('data-gezel-dialog-open');var back=returnFocus;returnFocus=null;if(back&&back.isConnected&&typeof back.focus==='function')back.focus();});
      // Close on a backdrop click only when the press also began there, so a text selection dragged outside keeps the form.
      dialog.addEventListener('mousedown',function(event){pressed=event.target;});
      dialog.addEventListener('click',function(event){if(event.target===dialog&&pressed===dialog)close();pressed=null;});
    }else if(mode==='inline'){
      box=el('section');heading=el('h3');heading.id='title';box.className='inline';box.setAttribute('aria-labelledby','title');submit.classList.add('primary');box.append(heading,description,fields,submit,status);s.root.append(style,box);
    }else{
      box=el('details');summary=el('summary');box.append(summary,description,fields,submit,status);s.root.append(style,box);
    }
    function render(){
      if(summary)summary.textContent=opts.title;if(heading)heading.textContent=opts.title;
      if(trigger){trigger.textContent=opts.buttonLabel||opts.title;trigger.className='trigger'+(opts.primary?' primary':'');trigger.hidden=opts.trigger===false;flash.classList.toggle('sr',opts.trigger===false);}
      description.textContent=opts.description||'';description.hidden=!opts.description;submit.textContent=opts.submitLabel||'Save';fields.replaceChildren();controls=[];
      (opts.fields||[]).forEach(function(field){
        var label=el('label'),caption=el('span',field.label+(field.required||mode==='inline'?'':' (optional)')),input=el(field.options?'select':field.multiline?'textarea':'input');
        if(field.options){if(!field.required){var blank=el('option','Choose…');blank.value='';input.append(blank);}field.options.forEach(function(value){var option=el('option',typeof value==='string'?value:value.label);option.value=typeof value==='string'?value:value.value;input.append(option);});}
        else if(!field.multiline)input.type=field.type||'text';
        input.name=field.name;input.required=!!field.required;input.setAttribute('aria-label',field.label);if(field.placeholder)input.placeholder=field.placeholder;if(field.min!==undefined)input.min=String(field.min);if(field.max!==undefined)input.max=String(field.max);if(field.type==='number')input.step=String(field.step||'any');if(field.value!==undefined)input.value=String(field.value);if(!field.options&&field.type!=='number'&&field.type!=='date')input.maxLength=field.maxLength||4000;
        label.append(caption,input);fields.append(label);controls.push({field:field,input:input,label:label});
      });
      visibility();
    }
    function visibility(){controls.forEach(function(control){var when=control.field.when,source=when&&controls.find(function(c){return c.field.name===when.field;}),visible=!when||!!source&&source.input.value===when.equals;control.label.hidden=!visible;control.input.required=visible&&!!control.field.required;});}
    function update(next){opts=Object.assign({},opts,next);if(busy){pendingUpdate=true;return;}var values={};controls.forEach(function(c){values[c.field.name]=c.input.value;});render();controls.forEach(function(c){var value=values[c.field.name];if(value!==undefined&&(!c.field.options||Array.from(c.input.options).some(function(option){return option.value===value;})))c.input.value=value;});visibility();}
    function initial(c){return c.field.value===undefined?(c.field.options&&c.field.required&&c.input.options.length?c.input.options[0].value:''):String(c.field.value);}
    function fill(values){controls.forEach(function(c){var given=values&&values[c.field.name],value=given===undefined||given===null?initial(c):String(given);if(c.field.options&&!Array.from(c.input.options).some(function(option){return option.value===value;}))value=initial(c);c.input.value=value;});visibility();}
    function reset(values){if(busy||stopped)return;fill(values);}
    function deepActive(){var active=document.activeElement;while(active&&active.shadowRoot&&active.shadowRoot.activeElement)active=active.shadowRoot.activeElement;return active;}
    function firstField(){var first=controls.find(function(c){return !c.label.hidden&&!c.input.disabled;});if(first)first.input.focus();}
    function open(values){show(values,null);}
    // Focus goes back to whatever opened the dialog: the key, or a row action that called open(). WebKit does not focus a clicked button, so the key passes itself and a body-focused open falls back to the key.
    function show(values,from){
      if(stopped)return;if(values)reset(values);
      if(mode==='dialog'){if(!dialog.open){var active=deepActive();returnFocus=from||(active&&active!==document.body?active:trigger&&!trigger.hidden?trigger:null);if(!busy)status.textContent='';s.host.setAttribute('data-gezel-dialog-open','');try{dialog.showModal();}catch(_){dialog.setAttribute('open','');}}}
      else if(mode==='disclosure')box.open=true;
      firstField();
    }
    function close(){if(stopped||busy)return;if(mode==='dialog'){if(dialog.open)dialog.close();}else if(mode==='disclosure')box.open=false;}
    function announce(message){if(!flash)return;flash.textContent=message;flash.classList.add('show');clearTimeout(flashTimer);flashTimer=setTimeout(function(){flash.classList.remove('show');},4000);}
    async function save(){
      if(busy||stopped)return;var values={},saved=false,message='';
      for(var control of controls){if(control.label.hidden)continue;if(!control.input.reportValidity())return;var value=control.input.value.trim();if(control.field.required&&!value){control.input.setCustomValidity('Enter a value.');control.input.reportValidity();control.input.setCustomValidity('');return;}if(value!=='')values[control.field.name]=control.field.type==='number'?Number(value):value;}
      busy=true;submit.disabled=true;if(cancel)cancel.disabled=true;controls.forEach(function(c){c.input.disabled=true;});box.setAttribute('aria-busy','true');status.textContent='Saving…';
      try{var input=opts.mapInput?opts.mapInput(values):values;var result=await api.tools.invoke(opts.tool,input);if(stopped)return;message=opts.successMessage||'Saved.';status.textContent=message;if(opts.onSaved){try{await opts.onSaved(result);}catch(error){message='Saved, but the view could not refresh. '+(error.message||'Try refreshing the page.');status.textContent=message;}}if(opts.clearOnSave!==false)fill();saved=true;}
      catch(error){if(!stopped)status.textContent='Could not save. '+(error.message||'Try again.');}
      finally{busy=false;if(!stopped){if(pendingUpdate){pendingUpdate=false;update({});}submit.disabled=false;if(cancel)cancel.disabled=false;controls.forEach(function(c){c.input.disabled=false;});visibility();box.removeAttribute('aria-busy');if(saved&&mode==='dialog'){status.textContent='';close();announce(message);}}}
    }
    submit.onclick=save;fields.oninput=visibility;fields.onchange=visibility;fields.onkeydown=function(event){if(event.key==='Enter'&&event.target.tagName==='INPUT'){event.preventDefault();void save();}};
    render();if(mode==='disclosure')box.open=!!opts.open;
    return {element:s.host,update:update,open:open,close:close,reset:reset,destroy:function(){if(stopped)return;stopped=true;clearTimeout(flashTimer);returnFocus=null;if(dialog&&dialog.open)dialog.close();s.host.removeAttribute('data-gezel-dialog-open');s.host.remove();s.host.disconnect();}};
  }
  // Underline tabs for peer destinations. The panels stay page-owned light DOM; this only labels and shows/hides them.
  function tabs(target,options){
    var opts=options||{},s=setup(target,'gezel-tabs',css+':host{display:block}[role=tablist]{display:flex;gap:4px;border-bottom:1px solid var(--line);overflow-x:auto;scrollbar-width:none}[role=tablist]::-webkit-scrollbar{display:none}[role=tab]{flex:0 0 auto;display:inline-flex;align-items:center;gap:8px;min-height:44px;margin:0 0 -1px;padding:8px 14px;border:0;border-bottom:2px solid transparent;border-radius:6px 6px 0 0;background:transparent;color:var(--muted);font-weight:500;white-space:nowrap}[role=tab]:hover:not([aria-selected=true]){color:inherit;background:color-mix(in srgb,var(--line) 24%,transparent)}[role=tab][aria-selected=true]{color:inherit;border-bottom-color:var(--accent)}[role=tab]:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}.badge{min-width:12px;padding:1px 6px;border-radius:4px;background:color-mix(in srgb,var(--accent) 16%,transparent);color:inherit;font-size:12px;font-weight:600;line-height:1.5;text-align:center}');
    var list=el('div'),buttons=[],selected=null,stopped=false;list.setAttribute('role','tablist');s.root.append(list);
    function items(){return Array.isArray(opts.tabs)?opts.tabs:[];}
    function panelOf(tab){return typeof tab.panel==='string'?document.querySelector(tab.panel):tab.panel||null;}
    function remembered(){try{var match=/(?:^#|&)tab=([^&]+)/.exec(location.hash);return match?decodeURIComponent(match[1]):null;}catch(_){return null;}}
    // replaceState keeps the choice across a reload without adding history entries the host's back button would walk.
    function remember(id){if(opts.remember===false)return;try{history.replaceState(history.state,'','#tab='+encodeURIComponent(id));}catch(_){}}
    function apply(){
      var all=items();if(!all.some(function(tab){return tab.id===selected;}))selected=all.length?all[0].id:null;
      all.forEach(function(tab,index){var on=tab.id===selected,panel=panelOf(tab);buttons[index].setAttribute('aria-selected',String(on));buttons[index].tabIndex=on?0:-1;if(panel)panel.hidden=!on;});
    }
    // Patch in place when the same tabs come back with new labels or badges, so a count changing never drops keyboard focus.
    function render(){
      var all=items(),same=buttons.length===all.length&&all.every(function(tab,index){return buttons[index].getAttribute('data-tab')===tab.id;});
      list.setAttribute('aria-label',opts.label||'Sections');
      if(!same){list.replaceChildren();buttons=all.map(function(tab){var button=el('button'),badge=el('span');button.type='button';button.setAttribute('role','tab');button.setAttribute('data-tab',tab.id);badge.className='badge';button.append(el('span'),badge);button.onclick=function(){select(tab.id);};list.append(button);return button;});}
      all.forEach(function(tab,index){
        var button=buttons[index],count=tab.badge,badge=button.lastChild,panel=panelOf(tab);button.firstChild.textContent=tab.label;
        badge.textContent=count===undefined||count===null||count===''||count===0?'':String(count);badge.hidden=!badge.textContent;
        if(panel){panel.setAttribute('role','tabpanel');panel.setAttribute('aria-label',tab.label);}
      });
      apply();
    }
    function select(id){if(stopped||!items().some(function(tab){return tab.id===id;}))return;var changed=id!==selected;selected=id;apply();remember(id);if(changed&&opts.onChange)opts.onChange(id);}
    list.onkeydown=function(event){var index=buttons.indexOf(s.root.activeElement),count=buttons.length;if(index<0||!count)return;var next=event.key==='ArrowRight'?(index+1)%count:event.key==='ArrowLeft'?(index+count-1)%count:event.key==='Home'?0:event.key==='End'?count-1:-1;if(next<0)return;event.preventDefault();buttons[next].focus();select(items()[next].id);};
    var hashed=opts.remember===false?null:remembered();selected=items().some(function(tab){return tab.id===hashed;})?hashed:opts.selected||null;render();
    function release(panels){panels.forEach(function(panel){if(panel){panel.hidden=false;panel.removeAttribute('role');panel.removeAttribute('aria-label');}});}
    return {element:s.host,select:select,selected:function(){return selected;},
      update:function(next){var before=items().map(panelOf);opts=Object.assign({},opts,next);if(next&&next.selected)selected=next.selected;render();var after=items().map(panelOf);release(before.filter(function(panel){return after.indexOf(panel)<0;}));},
      destroy:function(){if(stopped)return;stopped=true;release(items().map(panelOf));s.host.remove();s.host.disconnect();}};
  }`;
}
