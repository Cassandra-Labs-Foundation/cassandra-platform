import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {decodeRoute} from './navigation.mjs';
const model=JSON.parse(readFileSync(new URL('./model.json',import.meta.url),'utf8'));
test('every implementation permalink restores its actual enclosing process',()=>{
 for(const [id,node] of Object.entries(model.nodes))assert.deepEqual(decodeRoute('#/implementation/'+id),{view:'node',group:node.stage,node:id});
});
test('process permalinks restore their boundary rather than a previous node',()=>{
 for(const id of Object.keys(model.groups))assert.deepEqual(decodeRoute('#/process/'+id),{view:'group',group:id,node:null});
});
test('old architecture URLs remain navigable',()=>{
 assert.equal(decodeRoute('#/overview').view,'overview');
 assert.equal(decodeRoute('#/containers').view,'overview');
 assert.equal(decodeRoute('#/components').view,'api');
 assert.equal(decodeRoute('#/walkthroughs').view,'control');
});
test('unknown or malformed routes fall back safely',()=>{
 for(const hash of ['','#/implementation/missing','#/process/missing','#/%E0%A4%A','#/<script>'])assert.deepEqual(decodeRoute(hash),{view:'overview',group:null,node:null});
});
