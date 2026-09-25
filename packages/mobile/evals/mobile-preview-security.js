// Test-only fixture loaded by both native test targets. No production route.
globalThis.runMobilePreviewSecurity = async (options = {}) => {
  const p = window.Capacitor.Plugins.GezelMobile;
  const check = (condition, message) => {
    if (!condition) throw Error(message);
  };
  check(
    (await p.previewAvailability()).available,
    'Every-frame preview isolation must be installed',
  );
  const marker = `preview-denied-${crypto.randomUUID()}.txt`;
  check((await p.readProductFile({ path: marker })).data === null, 'Test marker starts absent');
  const script = `
    addEventListener('error',event=>parent.postMessage({scriptErrorReceipt:true,message:event.message},'*'));
    const message={callbackId:'preview-forgery',pluginId:'GezelMobile',methodName:'writeProductFile',options:{path:${JSON.stringify(marker)},data:'YmFk'}};
    try{window.webkit.messageHandlers.bridge.postMessage(message)}catch{}
    try{window.androidBridge.postMessage(JSON.stringify(message))}catch{}
    try{parent.Capacitor.Plugins.GezelMobile.writeProductFile(message.options)}catch{}
    let parentAccess=false;try{parentAccess=!!parent.document}catch{}
    parent.postMessage({previewReceipt:true,parentAccess,rtc:typeof RTCPeerConnection,blob:typeof URL.createObjectURL,cookies:typeof window.CapacitorCookiesAndroidInterface,http:typeof window.CapacitorHttpAndroidInterface},'*');
    addEventListener('securitypolicyviolation',event=>parent.postMessage({policyReceipt:true,directive:event.effectiveDirective,blocked:event.blockedURI},'*'));
    const button=document.createElement('button');button.textContent='Play';button.onclick=()=>{button.textContent='Played';parent.postMessage({clickedReceipt:true},'*')};document.body.append(button);button.click();
    const nested=document.createElement('iframe');nested.srcdoc='<script src="data:text/javascript;base64,'+btoa("top.postMessage({nestedReceipt:true,rtc:typeof RTCPeerConnection,blob:typeof URL.createObjectURL},'*')")+'"></script>';document.body.append(nested);
    fetch('https://outside.invalid/no-network').then(()=>parent.postMessage({networkEscape:true},'*')).catch(()=>{});
    window.open('https://outside.invalid/no-popup');
  `;
  const html = `<!doctype html><meta charset="utf-8"><body><script src="data:text/javascript;base64,${btoa(script)}"></script>`;
  const snapshot = await p.publishHtmlPreview({ html });
  const frame = document.createElement('iframe');
  frame.sandbox = 'allow-scripts';
  const receipts = {};
  const receive = (event) => {
    if (event.data?.previewReceipt && event.source === frame.contentWindow)
      receipts.main = event.data;
    if (event.data?.nestedReceipt) receipts.nested = event.data;
    if (event.data?.clickedReceipt && event.source === frame.contentWindow) receipts.clicked = true;
    if (event.data?.networkEscape) receipts.network = true;
    if (event.data?.scriptErrorReceipt) receipts.error = event.data;
    if (event.data?.policyReceipt && event.source === frame.contentWindow) {
      receipts.policies ??= [];
      receipts.policies.push(event.data);
    }
  };
  addEventListener('message', receive);
  try {
    frame.src = snapshot.url;
    document.body.append(frame);
    const until = Date.now() + 10000;
    while (Date.now() < until && (!receipts.main || !receipts.nested || !receipts.clicked))
      await new Promise((r) => setTimeout(r, 50));
    check(receipts.main, 'Preview JavaScript did not run');
    check(receipts.clicked, `Interactive preview button did not work: ${JSON.stringify(receipts)}`);
    check(receipts.main.parentAccess === false, 'Preview reached privileged parent');
    check(
      receipts.main.rtc === 'undefined' && receipts.main.blob === 'undefined',
      'Preview regained unrestricted networking or object URLs',
    );
    check(
      receipts.main.cookies === 'undefined' && receipts.main.http === 'undefined',
      'Legacy cookie/HTTP interfaces leaked into the frame',
    );
    check(
      (receipts.nested?.rtc === 'undefined' && receipts.nested?.blob === 'undefined') ||
        (!receipts.nested &&
          (options.verifyNativeFrameDenial === true ||
            receipts.policies?.some((event) => event.directive === 'frame-src'))),
      `Nested srcdoc isolation was not proven: ${JSON.stringify(receipts)}`,
    );
    await new Promise((r) => setTimeout(r, 300));
    check(
      (await p.readProductFile({ path: marker })).data === null,
      'Subframe native bridge mutated product files',
    );
    check(
      !receipts.network && receipts.policies?.some((event) => event.directive === 'connect-src'),
      'Preview network denial was not proven',
    );
    check(
      Array.isArray((await p.listModels()).models),
      'Packaged main document lost its native bridge',
    );
    await p.removeHtmlPreview({ id: snapshot.id });
    return { ok: true, checks: 10, receipts };
  } finally {
    frame.remove();
    removeEventListener('message', receive);
    await p.removeHtmlPreview({ id: snapshot.id });
    if ((await p.readProductFile({ path: marker })).data !== null)
      await p.removeProductPath({ path: marker });
  }
};
