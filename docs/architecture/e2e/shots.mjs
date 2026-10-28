// Screenshot every kind of view, plain and with Engineering detail, for a
// by-eye review of the diagrams. Tests prove structure; only eyes judge looks.
//
//   npm run shots -- <out-dir> [base-url]     # base defaults to the local docs server
import {mkdirSync} from 'node:fs';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {extname, join, normalize} from 'node:path';
import {chromium} from 'playwright';

const out = process.argv[2] || 'shots';
mkdirSync(out, {recursive: true});
const DOCS = new URL('../../', import.meta.url).pathname;
const types = {'.html': 'text/html', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json'};
let base = process.argv[3], server;
if (!base) {
  server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
    const file = join(DOCS, path.endsWith('/') ? path + 'index.html' : path);
    try { res.writeHead(200, {'content-type': types[extname(file)] || 'application/octet-stream'}); res.end(readFileSync(file)); }
    catch { res.writeHead(404); res.end(); }
  }).listen(0);
  base = `http://localhost:${server.address().port}`;
}
const views = ['overview', 'api', 'domain/payments', 'module/transfers', 'op/' + encodeURIComponent('POST /transfers'), 'policy', 'policy/bsa',
  'control/' + encodeURIComponent('bsa:BSA-06'), 'event/bsa_alert.created', 'container/aggregator', 'file/' + encodeURIComponent('aggregator/handler.ts'),
  'container/postgres', 'table/core.account', 'machine/Account', 'container/ui', 'page/compliance.jsx', 'container/blnk', 'container/_shared',
  'container/analytics', 'pipeline', 'step/' + encodeURIComponent('scripts/gen_architecture.py'), 'process/detect', 'implementation/threshold', 'routing', 'rails'];
const browser = await chromium.launch();
const page = await browser.newPage({viewport: {width: 1280, height: 900}});
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
for (const [i, view] of views.entries()) {
  await page.goto(`${base}/architecture/#/${view}`);
  await page.waitForTimeout(300);
  for (const eng of [false, true]) {
    await page.evaluate(e => { const c = document.querySelector('[data-engineering]'); if (c.checked !== e) c.click(); }, eng);
    await page.waitForTimeout(120);
    await page.locator('.workspace').screenshot({path: `${out}/${String(i).padStart(2, '0')}-${view.split('/')[0]}${eng ? '-eng' : ''}.png`});
  }
}
await browser.close();
server?.close();
console.log(`${views.length * 2} screenshots in ${out}${errors.length ? '\nERRORS ' + errors.join('\n') : ''}`);
