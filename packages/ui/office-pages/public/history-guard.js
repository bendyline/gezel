// Loaded before office.js. Some Office hosts null out history.pushState and
// replaceState when office.js initializes; the pane restores these originals
// once Office is ready, because the chat UI navigates with them.
(() => {
  const h = window.history;
  window.__gezelHistory = { pushState: h.pushState, replaceState: h.replaceState };
})();
