/*
 * Serves the offline IRCTC mock over HTTPS on 127.0.0.1 so that a browser
 * started with --host-resolver-rules="MAP www.irctc.co.in 127.0.0.1:<port>"
 * exercises the extension's real host permissions and content-script matches.
 *
 * Every path returns the same single-page mock (it is an SPA, like IRCTC).
 * A throw-away self-signed certificate is generated with openssl per run.
 */
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const mock = require('../helpers/mock-site');

function makeCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tatkal-cert-'));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1',
    '-subj', '/CN=www.irctc.co.in', '-addext', 'subjectAltName=DNS:www.irctc.co.in'], { stdio: 'ignore' });
  return { dir, key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

function pageHtml() {
  const mockSrc = fs.readFileSync(path.join(__dirname, '..', 'helpers', 'mock-site.js'), 'utf8');
  const bootstrap = `<script>
(function () {
  const module = { exports: {} };
  ${mockSrc}
  window.__mock = module.exports;
  window.__mockState = module.exports.install(window);
})();
</script>`;
  // replacer function: a string replacement would interpret `$$`/`$'` in the mock source
  return mock.HTML.replace('</body>', () => `${bootstrap}\n</body>`);
}

function start() {
  const { dir, key, cert } = makeCert();
  const html = pageHtml();
  const server = https.createServer({ key, cert }, (req, res) => {
    // timeapi.io stand-in so the service worker's clock sync is hermetic
    if (/^\/api\/time\/current\/zone/.test(req.url)) {
      const ist = new Date(Date.now() + 330 * 60000).toISOString().replace('Z', '0000');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ dateTime: ist, timeZone: 'Asia/Kolkata' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ port, close: () => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); } });
    });
  });
}

module.exports = { start };

if (require.main === module) {
  start().then(({ port }) => console.log(`mock IRCTC on https://127.0.0.1:${port}  (map www.irctc.co.in -> 127.0.0.1:${port})`));
}
