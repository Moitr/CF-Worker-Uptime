const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = process.env.STATUS_HTML || path.resolve(__dirname, '../frontend/status.html');

function page(responder, hidden = false) {
  let now = 1789304400000, sequence = 0;
  const timers = new Map(), nodes = new Map(), events = new Map(), requests = [];
  const element = () => ({dataset:{}, textContent:'', innerHTML:'', children:[], addEventListener(){}, appendChild(child){this.children.push(child);}});
  const document = {hidden,
    getElementById(id){if(!nodes.has(id)) nodes.set(id,element());return nodes.get(id);},
    createElement:element, addEventListener(name,callback){events.set(name,callback);},
  };
  const context = vm.createContext({document, URL, AbortController,
    Date:class extends Date {static now(){return now;}},
    setTimeout(callback,ms){const id=++sequence;timers.set(id,{callback,ms});return id;},
    clearTimeout(id){timers.delete(id);},
    fetch:async url=>{requests.push(url);return responder(url,now);},
  });
  vm.runInContext(fs.readFileSync(source,'utf8').match(/<script>([\s\S]*?)<\/script>/)[1],context);
  return {nodes,timers,requests,document,events, advance(ms){now+=ms;},
    api:vm.runInContext('({state,fetchData})',context),
    async settle(){for(let i=0;i<4;i++) await new Promise(resolve=>setImmediate(resolve));},
  };
}
const config = () => Response.json({settings:{title:'Test'},incidents:[]});
const groups = [{id:'g',name:'Group',monitors:[{id:'m',name:'Monitor',display:{},recent_checks:[]}]}];

test('hidden page does not fetch; visible page refreshes immediately and pauses again', async()=>{
  const p=page(url=>url==='/api/config'?config():Response.json(groups),true);
  assert.equal(p.requests.length,0);
  p.document.hidden=false;p.events.get('visibilitychange')();await p.settle();
  assert.equal(p.requests.length,2);assert.equal(p.api.state.loaded,true);
  assert.equal(p.timers.size,1);
  p.document.hidden=true;p.events.get('visibilitychange')();assert.equal(p.timers.size,0);
});
test('quota error shows reset time and prevents foreground or manual retry storms',async()=>{
  const p=page((url,now)=>url==='/api/config'?config():Response.json({error:'D1_DAILY_LIMIT',retryAt:now+3600000},{status:503,headers:{'Retry-After':'3600'}}));
  await p.settle();
  assert.equal(p.api.state.loaded,false);
  assert.match(p.nodes.get('error').textContent,/Daily monitoring data quota reached.*Next attempt/);
  assert.equal(p.nodes.get('error').children.at(-1).disabled,true);
  await p.api.fetchData();p.events.get('visibilitychange')();await p.settle();
  assert.equal(p.requests.length,2);
  assert.equal([...p.timers.values()][0].ms,3600000);
});
test('stale successful response renders actual saved time and a warning',async()=>{
  const p=page((url,now)=>url==='/api/config'?config():Response.json(groups,{headers:{'X-Status-Stale':'true','X-Status-Updated-At':String(now-3600000),'X-Status-Error':'D1_DAILY_LIMIT','Retry-After':'3600'}}));
  await p.settle();
  assert.equal(p.api.state.loaded,true);assert.equal(p.nodes.get('systems').hidden,false);
  assert.match(p.nodes.get('error').textContent,/Showing saved data from/);
  assert.equal(p.api.state.updatedAt-p.api.state.dataUpdatedAt,3600000);
});
test('transient errors back off and successful refresh clears error and backoff',async()=>{
  let fail=true;
  const p=page(url=>url==='/api/config'?config():fail?Response.json({error:'STATUS_UNAVAILABLE'},{status:503}):Response.json(groups));
  await p.settle();assert.equal([...p.timers.values()][0].ms,60000);
  p.advance(60000);await p.api.fetchData();assert.equal([...p.timers.values()][0].ms,120000);
  p.advance(120000);fail=false;await p.api.fetchData();
  assert.equal(p.api.state.failures,0);assert.equal(p.api.state.retryAt,0);
  assert.equal(p.nodes.get('error').hidden,true);
});
