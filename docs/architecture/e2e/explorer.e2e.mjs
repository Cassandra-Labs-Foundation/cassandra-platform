// End-to-end walk of the architecture explorer, the way a reviewer uses it:
// open the overview, drill from the Core API down to one operation, drill from
// the policy catalogue down to one control and into its hand-traced path, and
// climb back out through the breadcrumbs.
//
// The expected totals are read from sources the explorer does NOT render from
// (STATE.md and the api/ directory itself), so a generator that silently drops
// a module, an operation or a control fails here instead of shipping a map
// that only looks complete.
//
//   cd docs/architecture/e2e && npm ci && npx playwright install chromium
//   npm test                                   # serves docs/ locally
//   BASE_URL=https://cassandra-labs-foundation.github.io/cassandra-platform npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync, readdirSync} from 'node:fs';
import {extname, join, normalize} from 'node:path';
import {chromium} from 'playwright';

const ROOT = new URL('../../../', import.meta.url).pathname;
const DOCS = join(ROOT, 'docs');
const state = readFileSync(join(ROOT, 'STATE.md'), 'utf8');
const stat = label => Number(state.match(new RegExp(`\\| ${label} \\| (\\d+)`))[1]);
const ENDPOINTS = stat('endpoints'), CONTROLS = stat('controls'), POLICIES = stat('policies in the catalogue');
const MODULES = readdirSync(join(ROOT, 'core/supabase/functions/api'))
  .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.gen.ts'))
  .map(f => f.slice(0, -3));

const TYPES = {'.html': 'text/html', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.md': 'text/markdown'};
let server, base, browser, page;
const errors = [];

test.before(async () => {
  base = process.env.BASE_URL;
  if (!base) {
    server = createServer((req, res) => {
      const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
      const file = join(DOCS, path.endsWith('/') ? path + 'index.html' : path);
      try { res.writeHead(200, {'content-type': TYPES[extname(file)] || 'application/octet-stream'}); res.end(readFileSync(file)); }
      catch { res.writeHead(404); res.end(); }
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  browser = await chromium.launch();
  page = await browser.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
});
test.after(async () => { await browser?.close(); server?.close(); });

const open = hash => page.goto(`${base}/architecture/${hash}`);
const title = () => page.locator('[data-title]').innerText();
const map = () => page.locator('[data-flow]');
const crumbs = () => page.locator('[data-breadcrumb]');

test('the overview names every runtime container and the policy catalogue', async () => {
  await open('#/overview');
  for (const name of ['Core API', 'Postgres', 'Blnk ledger', 'Staff console', 'Policies & controls', 'Specification & evidence'])
    await map().getByRole('link', {name: new RegExp(name)}).first().waitFor();
});

test('every API module and every operation is reachable from the Core API', async () => {
  await open('#/overview');
  await map().getByRole('link', {name: /Core API/}).first().click();
  assert.equal(await title(), 'Core API');
  const text = await map().innerText();
  assert.match(text, new RegExp(`${ENDPOINTS} operations`), 'Core API reports the spec\'s full operation count');
  const domains = await map().locator('a[href^="#/domain/"]').evaluateAll(as => as.map(a => a.getAttribute('href')));
  assert.ok(domains.length >= 5, 'modules are grouped into domains');
  const seenModules = new Set(), seenOps = new Set();
  for (const href of domains) {
    await open(href);
    for (const m of await map().locator('a[href^="#/module/"]').evaluateAll(as => as.map(a => a.getAttribute('href').split('/')[2]))) {
      seenModules.add(m);
    }
  }
  assert.deepEqual([...MODULES].filter(m => !seenModules.has(m)), [], 'no api/ module is missing from the map');
  for (const m of seenModules) {
    await open('#/module/' + m);
    for (const op of await map().locator('a[href^="#/op/"]').evaluateAll(as => as.map(a => a.getAttribute('href'))))
      seenOps.add(op);
  }
  assert.equal(seenOps.size, ENDPOINTS, 'every spec operation appears under exactly one module');
});

test('a reviewer drills Core API → Payments → transfers → POST /transfers and climbs back', async () => {
  await open('#/api');
  await map().locator('a[href="#/domain/payments"]').click();
  await map().locator('a[href="#/module/transfers"]').click();
  assert.equal(await title(), 'transfers.ts');
  assert.match(await page.locator('[data-inspector]').innerText(), /runGate|gate/i, 'module purpose comes from its source header');
  await map().locator(`a[href="#/op/${encodeURIComponent('POST /transfers')}"]`).click();
  const leaf = await page.locator('[data-inspector]').innerText();
  for (const fact of ['transfers.', 'partner', 'write', 'transfers.test.ts']) assert.ok(leaf.includes(fact), `operation leaf shows ${fact}`);
  assert.match(await page.locator('.maphint').innerText(), /boundary reached/i);
  await crumbs().getByRole('button', {name: 'transfers.ts'}).click();
  assert.equal(await title(), 'transfers.ts');
  await crumbs().getByRole('button', {name: 'Payments'}).click();
  await crumbs().getByRole('button', {name: 'Core API'}).click();
  assert.equal(await title(), 'Core API');
});

test('every policy and every control is reachable from Policies & controls', async () => {
  await open('#/overview');
  await page.locator('.topnav').getByRole('link', {name: 'Policies & controls'}).click();
  const policies = await map().locator('a[href^="#/policy/"]').evaluateAll(as => as.map(a => a.getAttribute('href')));
  assert.equal(policies.length, POLICIES);
  const controls = new Set();
  for (const href of policies) {
    await open(href);
    for (const c of await map().locator('a[href^="#/control/"]').evaluateAll(as => as.map(a => a.getAttribute('href')))) controls.add(c);
  }
  assert.equal(controls.size, CONTROLS);
});

test('a reviewer drills BSA policy → BSA-06 → its traced path → one decision, and back', async () => {
  await open('#/policy/bsa');
  await map().locator('a[href="#/control/bsa:BSA-06"]').click();
  assert.match(await title(), /Transaction Monitoring/i);
  const leaf = await page.locator('[data-flow]').innerText() + await page.locator('[data-inspector]').innerText();
  for (const fact of ['bsa_alert.created', 'Hermetic', 'Live', 'In scope']) assert.ok(leaf.includes(fact), `control leaf shows ${fact}`);
  await map().locator('a[href="#/module/bsa"]').first().waitFor();
  await map().getByRole('link', {name: /traced implementation path/i}).click();
  await map().locator('[data-open-group="detect"]').click();
  await map().locator('[data-open-node="threshold"]').click();
  assert.equal(await title(), 'Movement greater than $10,000?');
  await crumbs().getByRole('button', {name: 'BSA-06'}).click();
  await crumbs().getByRole('button', {name: /Bank Secrecy Act|bsa/i}).click();
  assert.ok((await page.url()).endsWith('#/policy/bsa'));
});

test('old permalinks still land on the traced BSA-06 views', async () => {
  for (const [hash, want] of [['#/control', 'Transaction monitoring & case management'], ['#/walkthroughs', 'Transaction monitoring & case management'], ['#/process/triage', 'Alert triage & investigation'], ['#/components', 'Core API']]) {
    await open(hash);
    assert.equal(await title(), want, hash);
  }
});

test('no script or console errors along the way', () => {
  assert.deepEqual(errors, []);
});
