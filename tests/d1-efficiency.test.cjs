const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');
const root = process.env.PROJECT_ROOT || path.resolve(__dirname, '..');

function loadModule(name, extra = {}) {
  const filename = path.join(root, 'src', name + '.ts');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, Response, Request, URL, console: {log() {}, warn() {}, error() {}}, Date, ...extra }, { filename });
  return exports;
}

function fakeDB(changes = []) {
  const calls = [];
  return { calls, prepare(sql) {
    let args = [];
    return {
      bind(...values) { args = values; return this; },
      async run() { calls.push({sql,args}); return {success:true, results:[], meta:{changes:changes.shift() || 0, rows_read:1, rows_written:1, duration:1}}; },
    };
  }};
}

if (process.argv[2] === '--probe') {
  (async () => {
    const { Database } = loadModule('db');
    const db = fakeDB();
    await new Database(db).addCheckHistory({monitor_id:'test',timestamp:1789304400000,status:'UP',latency:20,message:'OK'});
    console.log(JSON.stringify({input:'one history insert',queries:db.calls.map(c=>c.sql),cleanupQueries:db.calls.filter(c=>c.sql.startsWith('DELETE')).length}));
  })().catch(error => { console.error(error); process.exitCode=1; });
} else {
  test('history insert never triggers cleanup', async () => {
    const { Database } = loadModule('db'); const db = fakeDB();
    await new Database(db).addCheckHistory({monitor_id:'test',timestamp:1,status:'UP',latency:20});
    assert.equal(db.calls.length, 1);
    assert.match(db.calls[0].sql, /^INSERT/);
    assert.equal(db.calls[0].args.at(-1), null);
  });
  test('cleanup is bounded to four 500-row batches and stops on a short batch', async () => {
    const { Database } = loadModule('db');
    for (const counts of [[500,500,500,500,500], [500,12], [0]]) {
      const expected = counts.slice(0,4).reduce((a,b)=>a+b,0); const db = fakeDB([...counts]);
      assert.equal(await new Database(db).cleanupHistory(1789304400000), expected);
      assert.equal(db.calls.length, Math.min(counts.length,4));
      for (const call of db.calls) {
        assert.match(call.sql, /ORDER BY timestamp LIMIT 500/);
        assert.equal(call.args[0],1789304400000-14*86400000);
      }
    }
  });

  function cacheFixture() {
    let now = 1789304400000;
    const { StatusCache } = loadModule('status-cache', { Date: class extends Date { static now() { return now; } } });
    const entries = new Map();
    const cache = {
      async match(key) { return entries.get(key)?.clone(); },
      async put(key,response) { entries.set(key,response.clone()); },
    };
    return { StatusCache, instance:new StatusCache(), cache, advance(ms) { now+=ms; }, now:()=>now };
  }
  test('simultaneous requests share one query and warm cache survives a new isolate', async () => {
    const f=cacheFixture(); let loads=0;
    const load=async()=>{loads++;return [{id:'test'}];};
    const responses=await Promise.all(Array.from({length:20},()=>f.instance.get('https://test/cache?v=1',f.cache,load)));
    assert.equal(loads,1);
    for(const response of responses) assert.deepEqual(await response.json(),[{id:'test'}]);
    const cached=await new f.StatusCache().get('https://test/cache?v=1',f.cache,load);
    assert.equal(cached.headers.get('X-Status-Cache'),'HIT'); assert.equal(loads,1);
    f.advance(60001);
    await f.instance.get('https://test/cache?v=1',f.cache,load); assert.equal(loads,2);
  });
  test('quota failure retains old data and blocks further reads until reset', async () => {
    const f=cacheFixture();const key='https://test/cache?v=1'; let attempts=0;
    const fresh=await f.instance.get(key,f.cache,async()=>[1]);
    const updatedAt=fresh.headers.get('X-Status-Updated-At'); f.advance(61000);
    const fail=async()=>{attempts++;throw new Error("D1_ERROR: exceeded D1's free tier daily row read limit");};
    const stale=await f.instance.get(key,f.cache,fail);
    assert.equal(stale.status,200);assert.deepEqual(await stale.json(),[1]);
    assert.equal(stale.headers.get('X-Status-Stale'),'true');
    assert.equal(stale.headers.get('X-Status-Updated-At'),updatedAt);
    assert.equal(stale.headers.get('X-Status-Error'),'D1_DAILY_LIMIT');
    await new f.StatusCache().get(key,f.cache,fail); assert.equal(attempts,1);
    f.advance(86400000);
    const recovered=await f.instance.get(key,f.cache,async()=>[2]);
    assert.equal(recovered.headers.get('X-Status-Stale'),'false'); assert.deepEqual(await recovered.json(),[2]);
  });
  test('cold quota failure returns structured 503; generic errors retry after 60 seconds', async () => {
    const f=cacheFixture();
    const response=await f.instance.get('https://test/cache?v=1',f.cache,async()=>{throw new Error('daily row read limit');});
    assert.equal(response.status,503);assert.equal((await response.json()).error,'D1_DAILY_LIMIT');
    const generic=await f.instance.get('https://test/cache?v=2',f.cache,async()=>{throw new Error('private database detail');});
    assert.equal(generic.headers.get('Retry-After'),'60');
    assert.doesNotMatch(await generic.text(),/private database detail/);
  });
  test('cache storage failure does not fail a successful live read', async () => {
    const f=cacheFixture();
    const broken={async match(){throw Error('cache');},async put(){throw Error('cache');}};
    const response=await f.instance.get('https://test/cache?v=1',broken,async()=>[1]);
    assert.equal(response.status,200);assert.deepEqual(await response.json(),[1]);
  });
}
