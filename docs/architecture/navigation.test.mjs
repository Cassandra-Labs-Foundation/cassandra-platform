import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {decodeRoute} from './navigation.mjs';
const model=JSON.parse(readFileSync(new URL('./model.json',import.meta.url),'utf8'));
const system=JSON.parse(readFileSync(new URL('./system.json',import.meta.url),'utf8'));
test('every implementation permalink restores its actual enclosing process',()=>{
 for(const [id,node] of Object.entries(model.nodes))assert.deepEqual(decodeRoute('#/implementation/'+id),{view:'node',group:node.stage,node:id,id:null});
});
test('process permalinks restore their boundary rather than a previous node',()=>{
 for(const id of Object.keys(model.groups))assert.deepEqual(decodeRoute('#/process/'+id),{view:'group',group:id,node:null,id:null});
});
test('every generated item has a permalink that decodes back to it',()=>{
 const cases=[['domain',system.domains.map(d=>d.id)],['module',Object.keys(system.modules)],['op',Object.keys(system.operations)],['policy',Object.keys(system.policies)],['control',Object.keys(system.controls)],['container',system.containers.map(c=>c.id)],['file',Object.keys(system.files)],['table',Object.keys(system.tables)],['machine',Object.keys(system.machines)],['page',Object.keys(system.pages)],['event',Object.keys(system.events)],['step',system.steps.map(s=>s.script)]];
 for(const [view,ids] of cases)for(const id of ids)assert.deepEqual(decodeRoute(`#/${view}/${encodeURIComponent(id)}`),{view,group:null,node:null,id});
});
test('old architecture URLs remain navigable',()=>{
 assert.equal(decodeRoute('#/overview').view,'overview');
 assert.equal(decodeRoute('#/containers').view,'overview');
 assert.equal(decodeRoute('#/components').view,'api');
 assert.equal(decodeRoute('#/walkthroughs').view,'control');
 assert.equal(decodeRoute('#/control').view,'control');
 assert.equal(decodeRoute('#/policy').view,'policy');
});
test('unknown or malformed routes fall back safely',()=>{
 for(const hash of ['','#/implementation/missing','#/process/missing','#/%E0%A4%A','#/<script>','#/module/%E0%A4%A','#/module/<img onerror=x>','#/api/extra'])assert.deepEqual(decodeRoute(hash),{view:'overview',group:null,node:null,id:null});
});
