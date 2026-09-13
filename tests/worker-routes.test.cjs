const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { webcrypto } = require('node:crypto');
const root = process.env.PROJECT_ROOT || path.resolve(__dirname, '..');

function worker() {
  const calls=[],logs=[],notifications=[],cacheEntries=new Map();
  const config={settings:{},incidents:[],groups:[{id:'g',monitors:[{id:'m',name:'Monitor',url:'https://private.test',display:{history:true,public_link:false},grace_period:1}]}]};
  class DB {
    async getAllMonitorStates(){calls.push('states');return [];}
    async getWindowHistory(){calls.push('history');return [];}
    async getHistory(){calls.push('latency');return [];}
    async getMonitorState(){calls.push('previous');return {status:'UP'};}
    async upsertMonitorState(){calls.push('upsert');}
    async addCheckHistory(){calls.push('insert');}
    async cleanupHistory(){calls.push('cleanup');}
  }
  const loaded=new Map();
  function load(name) {
    if(loaded.has(name)) return loaded.get(name);
    const exports={};loaded.set(name,exports);
    const code=ts.transpileModule(fs.readFileSync(path.join(root,'src',name+'.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021}}).outputText;
    vm.runInNewContext(code,{exports,Response,Request,URL,TextEncoder,crypto:webcrypto,
      console:{log:(...args)=>logs.push(args),warn:(...args)=>logs.push(args),error:(...args)=>logs.push(args)},
      caches:{default:{async match(key){return cacheEntries.get(key)?.clone();},async put(key,response){cacheEntries.set(key,response.clone());}}},
      require(id){
        if(id==='./config') return {loadConfig:()=>config};
        if(id==='./db') return {Database:DB};
        if(id==='./monitor') return {checkMonitor:async()=>{calls.push('check');return {status:'DOWN',latency:10,message:'test'};}};
        if(id==='./notifications') return {sendNotification:async(...args)=>notifications.push(args)};
        if(id.endsWith('.html')) return {default:'page'};
        if(id.startsWith('./')) return load(id.slice(2));
        return require(id);
      }}, {filename:name});
    return exports;
  }
  return {app:load('index').default,calls,logs,notifications,config};
}
test('status route normalizes query strings, caches data and preserves public-link privacy',async()=>{
  const w=worker();const env={DB:{}};
  const first=await w.app.fetch(new Request('https://test/api/status?x=1'),env);
  assert.equal(first.status,200);assert.equal(first.headers.get('X-Status-Cache'),'MISS');
  assert.equal((await first.json())[0].monitors[0].url,undefined);
  const second=await w.app.fetch(new Request('https://test/api/status?x=2'),env);
  assert.equal(second.headers.get('X-Status-Cache'),'HIT');
  assert.deepEqual(w.calls,['states','history']);
  w.config.groups[0].monitors[0].name='Changed';
  const changed=await w.app.fetch(new Request('https://test/api/status'),env);
  assert.equal((await changed.json())[0].monitors[0].name,'Changed');
  assert.equal(changed.headers.get('X-Status-Cache'),'MISS');
});
test('hourly cleanup never performs monitoring, minute cron never performs cleanup',async()=>{
  const w=worker(),env={DB:{}};
  await w.app.scheduled({cron:'7 * * * *',scheduledTime:1789304400000},env,{});
  assert.deepEqual(w.calls,['cleanup']);w.calls.length=0;
  await w.app.scheduled({cron:'* * * * *',scheduledTime:1789304400000},env,{});
  assert.deepEqual(w.calls,['previous','check','upsert','insert']);
  assert.equal(w.notifications[0][0],env);
  assert.equal(w.notifications[0][1],w.config);
});
test('unknown and history-disabled monitors do not cause latency reads',async()=>{
  const w=worker();
  assert.equal((await w.app.fetch(new Request('https://test/api/history/unknown'),{DB:{}})).status,404);
  w.config.groups[0].monitors[0].display.history=false;
  assert.equal((await w.app.fetch(new Request('https://test/api/history/m'),{DB:{}})).status,404);
  assert.deepEqual(w.calls,[]);
});
