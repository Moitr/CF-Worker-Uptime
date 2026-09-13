const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const NOW = Date.parse('2026-09-13T04:00:00Z');
const MINUTE = 60000;
const STEP = 10 * MINUTE;
const source = process.env.STATUS_HTML || path.join(__dirname, '../frontend/status.html');

function loadPage(file = source, now = NOW) {
  const html = fs.readFileSync(file, 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const nodes = new Map();
  const context = vm.createContext({
    Date: class extends Date { static now() { return now; } },
    URL, AbortController,
    document: {
      getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, { dataset: {}, addEventListener() {} });
        return nodes.get(id);
      },
      addEventListener() {},
    },
    fetch: () => new Promise(() => {}),
    setTimeout() {}, clearTimeout() {}, setInterval() {},
  });
  vm.runInContext(script, context, { filename: file });
  const page = vm.runInContext('({state, getWindow, getBuckets, getUptime, bars, renderGroups})', context);
  page.state.updatedAt = now;
  return { ...page, nodes };
}

function monitor(minutesAgo = 1, extra = {}) {
  return { id: 'test', name: 'Test', display: {}, recent_checks: [
    { timestamp: NOW - minutesAgo * MINUTE, status: 'UP', latency: 20 },
  ], ...extra };
}

function probe(file) {
  const page = loadPage(file);
  for (const minutesAgo of [1, 420]) {
    const monitors = [monitor(minutesAgo)];
    const buckets = page.getBuckets(monitors);
    const position = buckets.findIndex(bucket => bucket.valid.length) + 1;
    console.log(JSON.stringify({ minutesAgo, total: buckets.length, latestPosition: position,
      emptySlotsOnRight: buckets.length - position,
      delayedWarning: page.bars(monitors).includes('Updates delayed') }));
  }
}

if (process.argv[2] === '--probe') {
  probe(process.argv[3] || source);
} else {
  test('latest record is in capsule 84 even when seven hours old', () => {
    const page = loadPage();
    for (const age of [0, 1, 10, 420, 839]) {
      const monitors = [monitor(age)];
      const buckets = page.getBuckets(monitors);
      assert.equal(buckets.length, 84);
      assert.equal(buckets.at(-1).valid[0].timestamp, monitors[0].recent_checks[0].timestamp);
      assert.equal(page.getWindow(monitors).end, monitors[0].recent_checks[0].timestamp);
    }
  });

  test('left padding and internal missing intervals are preserved', () => {
    const page = loadPage();
    const buckets = page.getBuckets([monitor(1, { recent_checks: [
      { timestamp: NOW - 27 * MINUTE, status: 'DOWN' },
      { timestamp: NOW - MINUTE, status: 'UP' },
    ] })]);
    assert.equal(buckets.slice(0, 81).every(bucket => bucket.status === 'UNKNOWN'), true);
    assert.equal(buckets[81].status, 'DOWN');
    assert.equal(buckets[82].status, 'UNKNOWN');
    assert.equal(buckets[83].status, 'UP');
  });

  test('group uses newest visible history while each monitor has its own endpoint', () => {
    const page = loadPage();
    const old = monitor(420);
    const fresh = monitor(1);
    const disabled = monitor(0, { display: { history: false } });
    const buckets = page.getBuckets([old, fresh, disabled]);
    assert.equal(buckets.at(-1).valid.length, 1);
    assert.equal(page.getWindow([old, fresh, disabled]).end, NOW - MINUTE);
    assert.equal(page.getWindow([old]).end, NOW - 420 * MINUTE);
    assert.equal(page.getBuckets([old]).at(-1).status, 'UP');
  });

  test('empty or disabled history stays all gray with no invented latest check', () => {
    const page = loadPage();
    for (const monitors of [[], [monitor(1, { recent_checks: [] })], [monitor(1, { display: { history: false } })]]) {
      assert.equal(page.getBuckets(monitors).every(bucket => bucket.status === 'UNKNOWN'), true);
      assert.equal(page.getUptime(monitors), 'No data');
      assert.equal(page.getWindow(monitors).latest, null);
      assert.match(page.bars(monitors), /No recorded checks/);
      assert.doesNotMatch(page.bars(monitors), /latest check|Updates delayed/);
    }
  });

  test('unordered, invalid, unknown and future checks do not move the endpoint', () => {
    const page = loadPage();
    const monitors = [monitor(1, { recent_checks: [
      { timestamp: NOW - MINUTE, status: 'UP' },
      { timestamp: NOW - 30 * MINUTE, status: 'DOWN' },
      { timestamp: NOW, status: 'UNKNOWN' },
      { timestamp: NOW + MINUTE, status: 'DOWN' },
      { timestamp: 'invalid', status: 'DOWN' },
      { timestamp: null, status: 'DOWN' },
    ] })];
    assert.equal(page.getWindow(monitors).end, NOW - MINUTE);
    assert.equal(page.getBuckets(monitors).at(-1).status, 'UP');
  });

  test('window crosses midnight and keeps exact boundary checks once', () => {
    const midnight = Date.parse('2026-09-13T00:01:00Z');
    const page = loadPage(source, midnight);
    const latest = midnight - MINUTE;
    const monitors = [monitor(1, { recent_checks: [
      { timestamp: latest, status: 'UP' },
      { timestamp: latest - STEP, status: 'DEGRADED' },
      { timestamp: latest - 84 * STEP, status: 'UP' },
      { timestamp: latest - 84 * STEP - 1, status: 'DOWN' },
    ] })];
    const buckets = page.getBuckets(monitors);
    assert.equal(page.getWindow(monitors).end, latest);
    assert.equal(buckets[0].valid.length, 1);
    assert.equal(buckets.at(-1).valid.length, 2);
    assert.equal(buckets.flatMap(bucket => bucket.valid).length, 3);
  });

  test('severity and availability calculations remain unchanged', () => {
    const page = loadPage();
    const monitors = [monitor(0, { recent_checks: [
      { timestamp: NOW, status: 'UP' },
      { timestamp: NOW - MINUTE, status: 'DEGRADED' },
      { timestamp: NOW - 2 * MINUTE, status: 'DOWN' },
    ] })];
    assert.equal(page.getBuckets(monitors).at(-1).status, 'DOWN');
    assert.equal(page.getUptime(monitors), '66.67% uptime');
  });

  test('labels report actual check time and warn only after ten minutes', () => {
    const page = loadPage();
    assert.doesNotMatch(page.bars([monitor(10)]), /Updates delayed/);
    const html = page.bars([monitor(420)]);
    assert.match(html, /Updates delayed/);
    assert.match(html, /Last checked/);
    assert.match(html, /\(latest check\)/);
    assert.match(html, new RegExp(`data-end="${NOW - 420 * MINUTE}"`));
    assert.doesNotMatch(html, /latest refresh time|latest update/);
  });

  test('refresh alone does not shift old checks; a new check advances the window', () => {
    const page = loadPage();
    const monitors = [monitor(420)];
    const end = page.getWindow(monitors).end;
    page.state.updatedAt += 30 * MINUTE;
    assert.equal(page.getWindow(monitors).end, end);
    monitors[0].recent_checks.push({ timestamp: NOW + 29 * MINUTE, status: 'DOWN' });
    assert.equal(page.getWindow(monitors).end, NOW + 29 * MINUTE);
    assert.equal(page.getBuckets(monitors).at(-1).status, 'DOWN');
  });

  test('group expansion hides the complete group timeline, including its labels', () => {
    const page = loadPage();
    page.state.groups = [{ id: 'group', name: 'Group', monitors: [monitor(420)] }];
    page.renderGroups();
    assert.match(page.nodes.get('service-list').innerHTML, /class="timeline">/);
    assert.equal(page.nodes.get('date-range').textContent, '14-hour history');
    page.state.expanded.add('group');
    page.renderGroups();
    const html = page.nodes.get('service-list').innerHTML;
    assert.match(html, /class="timeline" hidden>/);
    assert.match(html, /class="components" id="group-0" >/);
    assert.match(html, /class="monitor">[\s\S]*class="timeline">/);
  });
}
