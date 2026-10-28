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
  await map().locator('a[href="#/domain/payments"]').first().click();
  await map().locator('a[href="#/module/transfers"]').first().click();
  assert.equal(await title(), 'transfers.ts');
  assert.match(await page.locator('[data-inspector]').innerText(), /runGate|gate/i, 'module purpose comes from its source header');
  await map().locator(`a[href="#/op/${encodeURIComponent('POST /transfers')}"]`).first().click();
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
  const policies = [...new Set(await map().locator('a[href^="#/policy/"]').evaluateAll(as => as.map(a => a.getAttribute('href'))))];
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
  await map().locator('a[href="#/control/bsa:BSA-06"]').first().click();
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

test('every other edge function drills file by file, and every file is reachable', async () => {
  for (const fn of ['aggregator', 'blnk-webhook', 'blnk-reconcile', 'drill', '_shared', 'analytics']) {
    await open('#/container/' + fn);
    const dir = fn === 'analytics' ? join(ROOT, 'analytics') : join(ROOT, 'core/supabase/functions', fn);
    const want = readdirSync(dir).filter(f => fn === 'analytics' ? /\.(sh|sql)$/.test(f) : f.endsWith('.ts'));
    const shown = await map().locator('a[href^="#/file/"]').evaluateAll(as => as.map(a => decodeURIComponent(a.getAttribute('href').slice('#/file/'.length))));
    assert.deepEqual(want.filter(f => !shown.includes(fn + '/' + f)), [], `every ${fn} file is on the map`);
  }
  await open('#/container/drill');
  await map().locator(`a[href="#/file/${encodeURIComponent('drill/run.ts')}"]`).first().click();
  assert.equal(await title(), 'drill/run.ts');
  assert.match(await page.locator('[data-inspector]').innerText(), /Drill runner/i, 'file purpose comes from its source header');
  await crumbs().getByRole('button', {name: 'Control drill'}).click();
  assert.equal(await title(), 'Control drill');
});

test('Postgres drills to a table\'s columns and a state machine\'s states', async () => {
  await open('#/container/postgres');
  await map().locator(`a[href="#/table/${encodeURIComponent('core.account')}"]`).first().click();
  assert.equal(await title(), 'core.account');
  const cols = await map().innerText();
  for (const col of ['blnk_ledger_id', 'lock_type', 'maturity_date']) assert.ok(cols.includes(col), `table leaf shows column ${col}`);
  assert.match(await page.locator('.maphint').innerText(), /boundary reached/i);
  await crumbs().getByRole('button', {name: 'Postgres'}).click();
  await map().locator(`a[href="#/machine/${encodeURIComponent('Account')}"]`).first().click();
  assert.match(await map().innerText(), /open[\s\S]*frozen[\s\S]*closed/, 'machine leaf lists its declared states');
});

test('the staff console drills page by page, and every page is reachable', async () => {
  await open('#/container/ui');
  const want = readdirSync(join(ROOT, 'ui/src/pages'), {recursive: true})
    .map(String).filter(f => f.endsWith('.jsx') && !f.split('/').pop().startsWith('_')).map(f => f.replaceAll('\\', '/'));
  const shown = await map().locator('a[href^="#/page/"]').evaluateAll(as => as.map(a => decodeURIComponent(a.getAttribute('href').slice('#/page/'.length))));
  assert.deepEqual(want.filter(f => !shown.includes(f)), [], 'every ui/src/pages/*.jsx is on the map');
  await map().locator(`a[href="#/page/${encodeURIComponent('compliance.jsx')}"]`).first().click();
  await map().locator(`a[href="#/op/${encodeURIComponent('GET /governance/obligations')}"]`).first().waitFor();
  await crumbs().getByRole('button', {name: 'Staff console'}).click();
  assert.equal(await title(), 'Staff console');
});

test('a control\'s event drills to its emit site, and the pipeline to a concrete step', async () => {
  await open('#/control/bsa:BSA-06');
  await map().locator(`a[href="#/event/${encodeURIComponent('bsa_alert.created')}"]`).first().click();
  assert.equal(await title(), 'bsa_alert.created');
  assert.match(await map().innerText(), /bsa\.ts/, 'event leaf names its emit site');
  await open('#/pipeline');
  await map().locator(`a[href="#/step/${encodeURIComponent('scripts/gen_architecture.py')}"]`).first().click();
  assert.match(await page.locator('[data-inspector]').innerText(), /rebuild_artifacts/, 'step leaf explains its place in the order');
});

// Every kind of view, by a representative permalink: the map must be a drawn
// flow diagram (boxes joined by rendered edges), and Engineering detail must
// change what it shows.
const EVERY_VIEW = ['#/overview', '#/api', '#/domain/payments', '#/module/transfers', `#/op/${encodeURIComponent('POST /transfers')}`,
  '#/policy', '#/policy/bsa', '#/control/bsa:BSA-06', '#/event/bsa_alert.created', '#/container/aggregator', '#/container/blnk-webhook',
  '#/container/blnk-reconcile', '#/container/drill', '#/container/_shared', '#/container/analytics', `#/file/${encodeURIComponent('drill/run.ts')}`,
  '#/container/postgres', '#/table/core.account', '#/machine/Account', '#/container/ui', `#/page/${encodeURIComponent('compliance.jsx')}`,
  '#/container/blnk', '#/pipeline', `#/step/${encodeURIComponent('scripts/gen_architecture.py')}`,
  '#/routing', '#/rails', '#/control', '#/process/detect', '#/process/triage', '#/process/decide', '#/implementation/threshold'];
const toggle = async on => { const box = page.locator('[data-engineering]'); if (await box.isChecked() !== on) await box.click(); };

test('every view is a flow diagram: boxes joined by drawn, labeled edges', async () => {
  await toggle(false);
  for (const hash of EVERY_VIEW) {
    await open(hash);
    const d = await map().evaluate(el => ({
      diagrams: el.querySelectorAll('[data-diagram]').length,
      boxes: el.querySelectorAll('[data-diagram] .dnode').length,
      edges: [...el.querySelectorAll('path.dedge')].filter(p => p.getTotalLength() > 8).length,
      labels: el.querySelectorAll('.dlabel').length,
      // an edge must start and end on real boxes in the diagram
      dangling: [...el.querySelectorAll('path.dedge')].filter(p => !el.querySelector(`[data-dnode="${CSS.escape(p.dataset.from)}"],[data-dgroup="${CSS.escape(p.dataset.from)}"]`) || !el.querySelector(`[data-dnode="${CSS.escape(p.dataset.to)}"],[data-dgroup="${CSS.escape(p.dataset.to)}"]`)).length,
    }));
    assert.ok(d.diagrams >= 1, `${hash} draws a diagram`);
    assert.ok(d.boxes >= 3, `${hash} has at least three boxes (${d.boxes})`);
    assert.ok(d.edges >= 2, `${hash} draws at least two edges (${d.edges})`);
    assert.ok(d.labels >= 1, `${hash} labels its edges`);
    assert.equal(d.dangling, 0, `${hash} has no edge to a missing box`);
  }
});

test('a drawn edge never passes through a box it does not connect', async () => {
  for (const hash of ['#/overview', '#/module/transfers', '#/domain/payments', '#/routing', '#/process/detect', '#/container/postgres']) {
    await open(hash);
    const crossings = await map().evaluate(el => {
      const boxes = [...el.querySelectorAll('[data-diagram] .dnode')].map(n => [n.dataset.dnode, n.getBoundingClientRect()]);
      const hits = [];
      for (const p of el.querySelectorAll('path.dedge')) {
        const len = p.getTotalLength(), m = p.getScreenCTM();
        for (let s = 6; s < len - 6; s += 4) {
          const q = p.getPointAtLength(s), x = m.a * q.x + m.e, y = m.d * q.y + m.f;
          for (const [id, r] of boxes) if (id !== p.dataset.from && id !== p.dataset.to && x > r.left + 2 && x < r.right - 2 && y > r.top + 2 && y < r.bottom - 2) hits.push(`${p.dataset.from}→${p.dataset.to} crosses ${id}`);
        }
      }
      return [...new Set(hits)];
    });
    assert.deepEqual(crossings, [], hash);
  }
});

test('Engineering detail changes every view, adding identifiers to the boxes', async () => {
  for (const hash of EVERY_VIEW) {
    await toggle(false);
    await open(hash);
    const plain = await page.locator('.workspace').innerText();
    await toggle(true);
    const eng = await page.locator('.workspace').innerText();
    assert.notEqual(eng, plain, `${hash}: Engineering detail changes nothing`);
    assert.ok(await map().locator('.dnode .tech').count() > 0, `${hash}: boxes gain identifiers`);
    await page.reload();
    assert.ok(await page.locator('[data-engineering]').isChecked(), 'the choice survives a reload');
  }
  await toggle(false);
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
