/*
 * Minimal Chrome DevTools Protocol harness (no puppeteer). Launches headless
 * Chrome with the remote-debugging pipe, loads the unpacked extension through
 * Extensions.loadUnpacked (the --load-extension flag is ignored by branded
 * Chrome builds since 137) and exposes tiny helpers for the e2e test.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

function findChrome() {
  return CANDIDATES.find((p) => fs.existsSync(p)) || null;
}

class PipeCDP {
  constructor(child) {
    this.child = child;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.buffer = '';
    child.stdio[4].setEncoding('utf8');
    child.stdio[4].on('data', (chunk) => {
      this.buffer += chunk;
      let idx;
      while ((idx = this.buffer.indexOf('\0')) >= 0) {
        const raw = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (raw) this.dispatch(JSON.parse(raw));
      }
    });
  }

  dispatch(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject, method } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ''}`));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const fn of this.listeners) fn(msg);
    }
  }

  send(method, params = {}, sessionId, timeoutMs = 15000) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.child.stdio[3].write(`${JSON.stringify(msg)}\0`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method}: no response after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(fn, { timeoutMs = 15000, intervalMs = 100, what = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(intervalMs);
  }
}

/**
 * Launch Chrome, load the extension, return a session object.
 * hostRules: e.g. 'MAP www.irctc.co.in 127.0.0.1:8443,MAP timeapi.io 127.0.0.1:8443'
 */
async function launch({ extensionPath, hostRules, headless = true }) {
  const bin = findChrome();
  if (!bin) throw new Error('Chrome not found');
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tatkal-e2e-'));
  const args = [
    headless ? '--headless=new' : '',
    // Chrome's own sandbox cannot start from a sandboxed shell (network service crash-loops);
    // this is a throw-away profile pointed at a local mock, so it is acceptable for tests.
    '--no-sandbox', '--disable-gpu',
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    `--user-data-dir=${userDataDir}`,
    `--host-resolver-rules=${hostRules}`,
    '--ignore-certificate-errors',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--mute-audio', '--disable-features=Translate,OptimizationHints',
    '--window-size=1280,900',
    'about:blank',
  ].filter(Boolean);
  const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-20000); });
  const cdp = new PipeCDP(child);

  const exited = new Promise((resolve) => child.on('exit', resolve));
  const close = async () => {
    try { await Promise.race([cdp.send('Browser.close'), sleep(2000)]); } catch (_) { /* already gone */ }
    child.kill('SIGKILL');
    await Promise.race([exited, sleep(3000)]);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  };

  try {
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    const { id: extensionId } = await cdp.send('Extensions.loadUnpacked', { path: extensionPath });

    const targets = async () => (await cdp.send('Target.getTargets')).targetInfos;
    const worker = await waitUntil(async () => (await targets()).find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extensionId}/`)),
      { what: 'extension service worker', timeoutMs: 20000 });
    const { sessionId: workerSession } = await cdp.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, workerSession);

    async function evalIn(sessionId, expression) {
      const res = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (res.exceptionDetails) {
        const d = res.exceptionDetails;
        throw new Error(`eval failed: ${(d.exception && d.exception.description) || d.text}`);
      }
      return res.result.value;
    }

    async function openPage(url) {
      // create on about:blank, enable domains, then navigate: attaching to a
      // target that is already mid-navigation can leave Runtime.evaluate hanging.
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Runtime.enable', {}, sessionId);
      cdp.on((msg) => {
        if (msg.sessionId === sessionId && msg.method === 'Page.javascriptDialogOpening') {
          cdp.send('Page.handleJavaScriptDialog', { accept: true }, sessionId).catch(() => {});
        }
      });
      const loaded = new Promise((resolve) => {
        const off = cdp.on((msg) => { if (msg.sessionId === sessionId && msg.method === 'Page.loadEventFired') { off(); resolve(); } });
      });
      await cdp.send('Page.navigate', { url }, sessionId);
      await Promise.race([loaded, sleep(10000)]);
      return { targetId, sessionId, eval: (expr) => evalIn(sessionId, expr) };
    }

    return {
      cdp, child, extensionId, userDataDir, close,
      stderr: () => stderr,
      evalInWorker: (expr) => evalIn(workerSession, expr),
      openPage,
      targets,
    };
  } catch (e) {
    await close();
    e.message += `\n--- chrome stderr ---\n${stderr.slice(-4000)}`;
    throw e;
  }
}

module.exports = { findChrome, launch, sleep, waitUntil };
