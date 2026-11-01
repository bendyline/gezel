/** Shared application furniture. Data and tool authority stay with the page API. */
export function pageAppComponentsSource(): string {
  return String.raw`
  function collectionFilter(target,options){
    var opts=options,s=setup(target,'gezel-collection-filter'),label=el('label'),caption=el('span',opts.label||'Search'),input=el('input'),status=el('p'),stopped=false;
    var container=typeof opts.container==='string'?document.querySelector(opts.container):opts.container;
    if(!container)throw new Error('Search collection not found.');
    input.type='search';input.placeholder=opts.placeholder||'Search this collection';input.setAttribute('aria-label',opts.label||'Search');input.style.cssText='width:100%;min-height:44px;box-sizing:border-box;padding:10px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:inherit;font:inherit';caption.style.cssText='display:block;font-size:14px;margin-bottom:6px';status.style.cssText='font-size:13px;color:var(--muted)';status.setAttribute('role','status');status.setAttribute('aria-live','polite');label.append(caption,input);s.root.append(label,status);
    function normalize(value){return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();}
    function filter(){if(stopped)return;var query=normalize(input.value.trim()),items=Array.from(container.querySelectorAll(opts.selector)),found=0;items.forEach(function(item){var matches=!query||normalize(item.textContent).includes(query);item.hidden=!matches;if(matches)found++;});status.textContent=query?found+' of '+items.length+' matches':items.length+' items';}
    input.oninput=filter;var observer=new MutationObserver(filter);observer.observe(container,{subtree:true,childList:true,characterData:true});filter();
    return {element:s.host,update:function(next){opts=Object.assign({},opts,next);filter();},destroy:function(){stopped=true;observer.disconnect();container.querySelectorAll(opts.selector).forEach(function(item){item.hidden=false;});s.host.remove();s.host.disconnect();}};
  }
  function appLayout(target,options){
    var content=typeof target==='string'?document.querySelector(target):target;
    if(!content||!content.parentElement)throw new Error('Application content not found.');
    var parent=content.parentElement,next=content.nextSibling,oldSlot=content.getAttribute('slot'),oldMaxWidth=content.style.maxWidth,oldMargin=content.style.margin,opts=options||{},stopped=false,conversation=null,collapsed=false;
    var s=setup(parent,'gezel-app-layout');parent.insertBefore(s.host,content);content.slot='content';s.host.append(content);
    var style=el('style',':host{display:block;max-width:1680px;margin:auto;--conversation-width:360px}.layout{display:block;min-width:0}.content{min-width:0}::slotted(main){min-width:0;box-sizing:border-box}.companion{display:none;min-width:0;margin:24px 24px 24px 0;padding:16px;border:1px solid var(--line);border-radius:10px;background:var(--surface);position:sticky;top:24px;height:calc(100dvh - 112px);max-height:960px;box-sizing:border-box}.intro{margin:0 0 12px}.intro h2{font:400 22px var(--font-heading,Georgia,serif);margin:0}.intro p{font-size:14px;color:var(--muted);margin:6px 0}.chat{flex:1;min-height:0}.toolbar{display:none;justify-content:flex-end;padding:12px 24px 0;gap:8px}.toolbar button{font-size:14px;min-height:36px}.unavailable{padding:20px 0;line-height:1.6}.expanded .toolbar{display:flex}.expanded.with-chat .layout{display:grid;grid-template-columns:minmax(0,1fr) var(--conversation-width);align-items:start}.expanded.with-chat .companion{display:flex;flex-direction:column}.expanded ::slotted(main){max-width:none;margin:0;padding:24px}.expanded:not(.with-chat) ::slotted(main){max-width:1280px;margin:auto}.companion[hidden]{display:none!important}@media(max-width:900px){.expanded.with-chat .layout{grid-template-columns:minmax(0,1fr)}.companion{position:relative;top:auto;margin:0 16px 24px;height:520px;max-height:80dvh}.expanded ::slotted(main){padding:16px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto}}');
    var wrapper=el('div'),toolbar=el('div'),toggle=el('button'),layout=el('div'),work=el('div'),slot=el('slot'),aside=el('aside'),intro=el('div'),heading=el('h2'),description=el('p'),chatRegion=el('div'),chatSlot=el('slot'),unavailable=el('p');
    toolbar.className='toolbar';toggle.type='button';layout.className='layout';work.className='content';slot.name='content';aside.className='companion';intro.className='intro';chatRegion.className='chat';chatSlot.name='conversation';unavailable.className='unavailable';unavailable.setAttribute('role','status');
    var mount=el('div');mount.slot='conversation';mount.style.cssText='display:block;height:100%;min-height:0;min-width:0';s.host.append(mount);
    intro.append(heading,description);chatRegion.append(chatSlot);aside.append(intro,unavailable,chatRegion);work.append(slot);layout.append(work,aside);toolbar.append(toggle);wrapper.append(toolbar,layout);s.root.append(style,wrapper);
    function hasDialog(){return Array.from(document.querySelectorAll('dialog[open],[aria-modal="true"]')).some(function(dialog){return dialog.getClientRects().length>0;});}
    function render(){
      if(stopped)return;
      var full=!!(api.ui.layout&&api.ui.layout.fullscreen),enabled=opts.chat!==false,visible=full&&enabled&&!collapsed;
      content.style.maxWidth=full?'none':oldMaxWidth;content.style.margin=full?'0':oldMargin;
      wrapper.className=(full?'expanded':'')+(visible?' with-chat':'');toolbar.hidden=!enabled;aside.hidden=!visible;
      heading.textContent=opts.title||'Your companion';description.textContent=opts.description||'';description.hidden=!opts.description;
      toggle.textContent=collapsed?'Show conversation':'Hide conversation';toggle.setAttribute('aria-expanded',String(!collapsed));
      var supported=api.page.mode==='embedded'&&typeof chat==='function';
      unavailable.hidden=supported;unavailable.textContent='Open this app in Gezel to talk with your companion. This preview keeps your sample work in this page.';
      var visibility=hasDialog()?'hidden':'visible';if(mount.style.visibility!==visibility)mount.style.visibility=visibility;
      if(visible&&supported&&!conversation){
        conversation=chat(mount,Object.assign({lockRecipient:true,showAddress:false,showThreads:false},opts.chat||{}));
        conversation.ready.catch(function(error){if(!stopped){unavailable.hidden=false;unavailable.textContent='Conversation could not open. '+(error.message||'Restore the page to use the project chat.');}});
      }
    }
    toggle.onclick=function(){collapsed=!collapsed;render();};
    var stopLayout=api.ui.onLayout?api.ui.onLayout(render):function(){},dialogs=new MutationObserver(function(){var visibility=hasDialog()?'hidden':'visible';if(mount.style.visibility!==visibility)mount.style.visibility=visibility;});
    dialogs.observe(document.body,{subtree:true,attributes:true,attributeFilter:['open','hidden','aria-hidden','aria-modal','class','style']});
    function destroy(){if(stopped)return;stopped=true;stopLayout();dialogs.disconnect();if(conversation)conversation.destroy();window.removeEventListener('pagehide',destroy);content.style.maxWidth=oldMaxWidth;content.style.margin=oldMargin;if(s.host.parentElement){parent.insertBefore(content,next&&next.parentNode===parent?next:s.host);if(oldSlot===null)content.removeAttribute('slot');else content.slot=oldSlot;}s.host.remove();s.host.disconnect();}
    window.addEventListener('pagehide',destroy,{once:true});render();
    return {element:s.host,update:function(next){opts=Object.assign({},opts,next);if(conversation&&opts.chat!==false)conversation.update(opts.chat||{});render();},destroy:destroy};
  }
  function actionForm(target,options){
    var opts=options,s=setup(target,'gezel-action-form'),box=el('details'),summary=el('summary'),description=el('p'),fields=el('div'),submit=el('button'),status=el('p'),busy=false,stopped=false,pendingUpdate=false,controls=[];
    var style=el('style','details{border:1px solid var(--line);border-radius:10px;padding:14px;background:var(--surface)}summary{cursor:pointer;font-weight:600;min-height:24px;list-style-position:inside}summary:focus-visible{outline:2px solid var(--accent);outline-offset:4px}.fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:12px;margin:16px 0}label{display:flex;flex-direction:column;gap:6px;font-size:14px}input,select,textarea{box-sizing:border-box;min-width:0;width:100%;font:inherit;color:inherit;background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:10px;min-height:44px}textarea{min-height:90px;resize:vertical}.description{color:var(--muted);font-size:14px}button{min-height:44px}button:disabled{cursor:wait;opacity:.65}output{display:block;margin-top:10px}');
    fields.className='fields';description.className='description';submit.type='button';status.setAttribute('role','status');status.setAttribute('aria-live','polite');box.append(summary,description,fields,submit,status);s.root.append(style,box);
    function render(){
      summary.textContent=opts.title;description.textContent=opts.description||'';description.hidden=!opts.description;submit.textContent=opts.submitLabel||'Save';fields.replaceChildren();controls=[];
      (opts.fields||[]).forEach(function(field){
        var label=el('label'),caption=el('span',field.label+(field.required?'':' (optional)')),input=el(field.options?'select':field.multiline?'textarea':'input');
        if(field.options){if(!field.required){var blank=el('option','Choose…');blank.value='';input.append(blank);}field.options.forEach(function(value){var option=el('option',typeof value==='string'?value:value.label);option.value=typeof value==='string'?value:value.value;input.append(option);});}
        else if(!field.multiline)input.type=field.type||'text';
        input.name=field.name;input.required=!!field.required;input.setAttribute('aria-label',field.label);if(field.placeholder)input.placeholder=field.placeholder;if(field.min!==undefined)input.min=String(field.min);if(field.max!==undefined)input.max=String(field.max);if(field.type==='number')input.step=String(field.step||'any');if(field.value!==undefined)input.value=String(field.value);if(!field.options&&field.type!=='number'&&field.type!=='date')input.maxLength=field.maxLength||4000;
        label.append(caption,input);fields.append(label);controls.push({field:field,input:input,label:label});
      });
      visibility();
    }
    function visibility(){controls.forEach(function(control){var when=control.field.when,source=when&&controls.find(function(c){return c.field.name===when.field;}),visible=!when||!!source&&source.input.value===when.equals;control.label.hidden=!visible;control.input.required=visible&&!!control.field.required;});}
    function update(next){opts=Object.assign({},opts,next);if(busy){pendingUpdate=true;return;}var values={};controls.forEach(function(c){values[c.field.name]=c.input.value;});render();controls.forEach(function(c){var value=values[c.field.name];if(value!==undefined&&(!c.field.options||Array.from(c.input.options).some(function(option){return option.value===value;})))c.input.value=value;});visibility();}
    async function save(){
      if(busy||stopped)return;var values={};
      for(var control of controls){if(control.label.hidden)continue;if(!control.input.reportValidity())return;var value=control.input.value.trim();if(control.field.required&&!value){control.input.setCustomValidity('Enter a value.');control.input.reportValidity();control.input.setCustomValidity('');return;}if(value!=='')values[control.field.name]=control.field.type==='number'?Number(value):value;}
      busy=true;submit.disabled=true;controls.forEach(function(c){c.input.disabled=true;});box.setAttribute('aria-busy','true');status.textContent='Saving…';
      try{var input=opts.mapInput?opts.mapInput(values):values;var result=await api.tools.invoke(opts.tool,input);if(stopped)return;status.textContent=opts.successMessage||'Saved.';if(opts.onSaved){try{await opts.onSaved(result);}catch(error){status.textContent='Saved, but the view could not refresh. '+(error.message||'Try refreshing the page.');}}if(opts.clearOnSave!==false)controls.forEach(function(c){c.input.value=c.field.value===undefined?(c.field.options&&c.field.required&&c.input.options.length?c.input.options[0].value:''):String(c.field.value);});}
      catch(error){if(!stopped)status.textContent='Could not save. '+(error.message||'Try again.');}
      finally{busy=false;if(!stopped){if(pendingUpdate){pendingUpdate=false;update({});}submit.disabled=false;controls.forEach(function(c){c.input.disabled=false;});visibility();box.removeAttribute('aria-busy');}}
    }
    submit.onclick=save;fields.oninput=visibility;fields.onchange=visibility;fields.onkeydown=function(event){if(event.key==='Enter'&&event.target.tagName==='INPUT'){event.preventDefault();void save();}};
    render();box.open=!!opts.open;
    return {element:s.host,update:update,destroy:function(){stopped=true;s.host.remove();s.host.disconnect();}};
  }`;
}
