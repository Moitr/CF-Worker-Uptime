const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const root = process.env.PROJECT_ROOT || path.resolve(__dirname,'..');

test('index migration preserves history, is repeatable, and supports bounded cleanup',()=>{
  const db=new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(root,'schema.sql'),'utf8').replace('CREATE INDEX idx_history_timestamp ON check_history(timestamp);',''));
  const insert=db.prepare('INSERT INTO check_history (monitor_id,timestamp,status,latency) VALUES (?,?,?,?)');
  for(let i=0;i<1200;i++) insert.run('old',i,'UP',10);
  insert.run('keep',2000,'DOWN',20);
  const original=db.prepare('SELECT * FROM check_history ORDER BY id').all();
  const migration=fs.readFileSync(path.join(root,'migrations/0001_history_timestamp_index.sql'),'utf8');
  db.exec(migration);db.exec(migration);
  assert.deepEqual(db.prepare('SELECT * FROM check_history ORDER BY id').all(),original);
  const details=db.prepare('EXPLAIN QUERY PLAN SELECT * FROM check_history WHERE timestamp >= ? ORDER BY timestamp').all(1000);
  assert.match(details.map(row=>row.detail).join(' '),/USING INDEX idx_history_timestamp/);
  const source=fs.readFileSync(path.join(root,'src/db.ts'),'utf8');
  const sql=source.match(/'(DELETE FROM check_history WHERE id IN [^']+)'/)[1];
  assert.equal(db.prepare(sql).run(1200).changes,500);
  assert.equal(db.prepare(sql).run(1200).changes,500);
  assert.equal(db.prepare(sql).run(1200).changes,200);
  assert.equal(db.prepare(sql).run(1200).changes,0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM check_history').get().n,1);
  assert.equal(db.prepare('SELECT status FROM check_history').get().status,'DOWN');
  db.close();
});
