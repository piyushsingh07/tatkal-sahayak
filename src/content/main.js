/*
 * Content-script entry point. Guards against double injection (Angular SPA
 * navigations never reload the document, but Chrome may re-inject on
 * extension reload) and wires engine + panel together.
 */
(function (root) {
  'use strict';
  if (root.__tatkalSahayakBooted) return;
  root.__tatkalSahayakBooted = true;

  const TA = root.TA;
  if (!TA || !TA.Engine || !TA.Panel) return;

  const boot = async () => {
    const engine = new TA.Engine();
    await engine.init();
    // eslint-disable-next-line no-new
    new TA.Panel(engine);
    engine.badge();
    root.__tatkalSahayak = engine; // handy for debugging from DevTools (content-script context)
  };

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot, { once: true });
})(typeof globalThis !== 'undefined' ? globalThis : this);
