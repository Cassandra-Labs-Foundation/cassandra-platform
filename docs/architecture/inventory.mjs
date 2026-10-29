// The generated layer: every container, module, operation, policy, control,
// function file, table, state machine, console page, event code and pipeline
// step, rendered from system.json (scripts/gen_architecture.py). Each view
// leads with a flow diagram (diagram.mjs) whose edges come from derived facts:
// imports, table references, foreign keys, emit sites, the spec's audiences,
// the catalogue's triggers, the rebuild order. Where a diagram has to cap a
// long list, the complete listing follows it. The hand-traced BSA-06 slice
// lives in explorer.mjs.
import {diagram} from './diagram.mjs';
const repo='https://github.com/Cassandra-Labs-Foundation/cassandra-platform/blob/main/';
export const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const src=(path,line,label)=>`<a href="${repo+path}${line?'#L'+line:''}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>`;
const gh=(path,line)=>repo+path+(line?'#L'+line:'');
const plural=(n,w)=>`${n} ${w}${n===1?'':'s'}`;
const first=s=>{const m=String(s||'').match(/^.*?[.!?](\s|$)/);return (m?m[0]:String(s||'')).trim().slice(0,180);};
const status=s=>s?`<span class="badge ${s==='green'?'ok':s==='red'?'bad':''}">${esc(s)}</span>`:'<span class="badge">not run</span>';
const card=(href,kind,title,sub,inside='Open ↘',extra='')=>`<a class="node container-node" href="${esc(href)}"><span class="kind">${esc(kind)}</span><strong>${esc(title)}</strong><span class="sub">${sub}</span>${extra}<span class="inside">${inside}</span></a>`;
const grid=items=>`<div class="grid">${items.join('')}</div>`;
const section=(label,body)=>`<div class="subsection"><div class="boundarylabel">${esc(label)}</div>${body}</div>`;
const chips=list=>list.length?`<div class="chips">${list.map(x=>`<code>${esc(x)}</code>`).join('')}</div>`:'<p class="muted">None.</p>';
const verdict=v=>esc(String(v).replace(/_/g,' '));
const enc=encodeURIComponent;
const opHref=key=>'#/op/'+enc(key);
let capped=false;
const index=(label,body)=>`<div class="dindex" data-index><div class="boundarylabel">${esc(label)}</div>${body}</div>`;
const take=(list,n)=>[list.slice(0,n),Math.max(0,list.length-n)];
const more=(key,rest,what)=>rest>0?[{id:'more:'+key,tone:'more',title:`+ ${rest} more`,sub:`${what} · listed below`,scroll:true}]:[];
const views=new Set(['domain','module','op','policy','control','container','file','table','machine','page','event','step']);
const fnDirs=new Set(['aggregator','blnk-webhook','blnk-reconcile','drill','_shared','analytics']);

export function inventory(sys,traced={}){
 const {containers,domains,modules,operations,policies,controls,machines,pages,files,tables,events,steps,blnk,workflows,links,counts}=sys;
 const domainOf=Object.fromEntries(domains.flatMap(d=>d.modules.map(m=>[m,d])));
 const box=Object.fromEntries(containers.map(c=>[c.id,c]));
 const policyRow=id=>{const cs=policies[id].controls.map(u=>controls[u]);const inScope=cs.filter(c=>c.scope==='in');return {cs,inScope,green:inScope.filter(c=>c.hermetic==='green'&&c.live==='green').length};};
 const modLink=m=>`<a class="pill" href="#/module/${esc(m)}">${esc(m)}.ts</a>`;
 const fileLink=f=>`<a class="pill" href="#/file/${esc(enc(f))}">${esc(f)}</a>`;
 const evLink=code=>`<a class="pill" href="#/event/${esc(enc(code))}"><code>${esc(code)}</code></a>`;
 const evChips=list=>list.length?`<div class="chips">${list.map(evLink).join('')}</div>`:'<p class="muted">None.</p>';
 const ctlCard=u=>{const c=controls[u];return card('#/control/'+u,`Control · ${c.id}`,c.title,`${c.scope==='in'?'In scope':'Scoped out'} · ${plural(c.modules.length,'module')}`,'Open control ↘',c.scope==='in'?`<span class="badges">Hermetic ${status(c.hermetic)} Live ${status(c.live)}</span>`:'<span class="badges">Discharged by people and paperwork · not claimed</span>');};
 const opCard=k=>{const o=operations[k];return card(opHref(k),`${o.audience} · ${o.tier}`,`${o.method} ${o.path}`,esc(o.summary||o.handler),'Open operation ↘');};
 const tableCard=key=>{const t=tables[key];const used=t.modules.length+t.functionFiles.length;return card('#/table/'+enc(key),`Table · ${t.schema}`,t.name,`${plural(t.columns.length,'column')}${used?' · referenced by '+plural(used,'source'):' · no static reference'}`,'Open table ↘');};
 const emitSite=([path,line])=>`<div class="eventrow"><code>${esc(path.split('/').pop())}${line>1?':'+line:''}</code><span>${src(path,line>1?line:0,'Read the emit site')}</span></div>`;
 const ctlState=c=>c.scope!=='in'?'Scoped out · paperwork':c.hermetic==='green'&&c.live==='green'?'Green in both tiers':`Hermetic ${c.hermetic||'not run'} · Live ${c.live||'not run'}`;

 // Diagram nodes, one builder per kind of thing, so every diagram names things the same way.
 const N={
  module:(m,extra={})=>{const x=modules[m];return {id:'m:'+m,kind:`Module · ${domainOf[m]?.title||''}`,title:m+'.ts',sub:`${plural(x.ops.length,'operation')} · ${x.lines} lines`,href:'#/module/'+m,tech:x.file,...extra};},
  op:k=>{const o=operations[k];return {id:'o:'+k,kind:`${o.audience} · ${o.tier}`,title:`${o.method} ${o.path}`,sub:o.summary||o.handler,href:opHref(k),tech:`${o.handler} · ${o.operationId}`};},
  control:(u,extra={})=>{const c=controls[u];return {id:'c:'+u,kind:`Control · ${c.id}`,title:c.title,sub:ctlState(c),href:'#/control/'+u,tech:u,...extra};},
  event:(code,extra={})=>{const e=events[code];return {id:'e:'+code,kind:'Event code',title:code,sub:e?plural(e.sites.length,'emit site'):'',href:'#/event/'+enc(code),tech:e?.sites.map(([p,l])=>p.split('/').pop()+(l>1?':'+l:'')).join(', '),...extra};},
  table:(key,extra={})=>{const t=tables[key];return {id:'t:'+key,kind:`Table · ${t.schema}`,title:t.name,sub:plural(t.columns.length,'column'),href:'#/table/'+enc(key),tone:'store',tech:`${t.migration.split('/').pop()}:${t.line}`,...extra};},
  file:(rel,extra={})=>{const f=files[rel];return {id:'f:'+rel,kind:f.test?'Test file':'File',title:rel.split('/').pop(),sub:first(f.about)||plural(f.exports.length,'export'),href:'#/file/'+enc(rel),tech:f.exports.map(([n])=>n).join(', ')||f.file,...extra};},
  container:(id,extra={})=>{const c=box[id];return {id:'k:'+id,kind:c.kind,title:c.title,sub:c.about.length>110?first(c.about):c.about,href:c.href,tone:id==='postgres'?'store':id==='blnk'?'external':'',tech:c.file||'',...extra};},
  domain:(d,extra={})=>({id:'d:'+d.id,kind:'Domain',title:d.title,sub:`${plural(d.modules.length,'module')} · ${plural(d.modules.reduce((n,m)=>n+modules[m].ops.length,0),'operation')}`,href:'#/domain/'+d.id,tech:d.modules.join(', '),...extra}),
  page:(p,extra={})=>({id:'p:'+p,kind:`Page · ${pages[p].lines} lines`,title:p,sub:first(pages[p].about)||plural(pages[p].ops.length,'operation'),href:'#/page/'+enc(p),tech:pages[p].file,...extra}),
  machine:(n,extra={})=>({id:'s:'+n,kind:'State machine',title:n,sub:machines[n].states.join(' → '),href:'#/machine/'+enc(n),tech:`core-api.yaml:${machines[n].specLine}`,...extra}),
  step:(s,extra={})=>({id:'st:'+s.script,kind:s.gate?'Gate · fails the build':'Derivation',title:s.script.split('/').pop(),sub:s.outputs.length?'→ '+s.outputs.join(', '):s.note||first(s.about),href:'#/step/'+enc(s.script),tone:s.gate?'decision':'',tech:`rebuild_artifacts.sh:${s.shLine}`,...extra}),
  workflow:(wf,extra={})=>{const w=workflows[wf];return {id:'w:'+wf,kind:'CI workflow',title:w.name,sub:'on '+w.triggers.join(', '),href:gh(w.file),external:true,tech:w.file,...extra};},
  port:(id,title,sub='',extra={})=>({id,title,sub,tone:'port',...extra}),
  person:(id,title,sub='')=>({id,title,sub,tone:'person',kind:'Person'}),
 };
 const linkOf=(a,b)=>links.find(l=>l.from===a&&l.to===b);
 const audienceCount=a=>Object.values(operations).filter(o=>o.audience===a).length;

 // Which generated view a state shows, or null when the state is a hand view.
 function resolve(state){
  if(state.view==='policy'&&!state.id)return {kind:'policies'};
  if(!views.has(state.view))return null;
  const id=state.id;
  const found={domain:domains.find(d=>d.id===id),module:modules[id],op:operations[id],policy:policies[id],control:controls[id],container:containers.find(c=>c.href==='#/container/'+id),file:files[id],table:tables[id],machine:machines[id],page:pages[id],event:events[id],step:steps.find(s=>s.script===id)}[state.view];
  return found?{kind:state.view,id,item:found}:null;
 }
 function crumbs(r){
  const out=[['#/overview','Architecture']];
  if(r.kind==='policies'||r.kind==='policy'||r.kind==='control')out.push(['#/policy','Policies & controls']);
  if(r.kind==='policy')out.push(['#/policy/'+r.id,policies[r.id].title]);
  if(r.kind==='control'){const c=r.item;out.push(['#/policy/'+c.policy,policies[c.policy].title],['#/control/'+r.id,c.id]);}
  if(['domain','module','op','event'].includes(r.kind))out.push(['#/api','Core API']);
  const mod=r.kind==='module'?r.id:r.kind==='op'?r.item.module:null;
  if(r.kind==='domain')out.push(['#/domain/'+r.id,r.item.title]);
  if(mod){const d=domainOf[mod];out.push(['#/domain/'+d.id,d.title],['#/module/'+mod,mod+'.ts']);}
  if(r.kind==='op')out.push([opHref(r.id),`${r.item.method} ${r.item.path}`]);
  if(r.kind==='container')out.push(['#/container/'+r.id,r.item.title]);
  if(r.kind==='file')out.push(['#/container/'+r.item.fn,box[r.item.fn]?.title||r.item.fn],['#/file/'+enc(r.id),r.id.split('/').pop()]);
  if(r.kind==='table'||r.kind==='machine')out.push(['#/container/postgres','Postgres'],['#/'+r.kind+'/'+enc(r.id),r.kind==='table'?r.item.name:r.id]);
  if(r.kind==='page')out.push(['#/container/ui','Staff console'],['#/page/'+enc(r.id),r.id]);
  if(r.kind==='event')out.push(['#/event/'+enc(r.id),r.id]);
  if(r.kind==='step')out.push(['#/pipeline','Specification & evidence'],['#/step/'+enc(r.item.script),r.id.split('/').pop()]);
  return out;
 }
 function title(r){return {policies:'Policies & controls',domain:r.item?.title,module:r.id+'.ts',op:r.item&&`${r.item.method} ${r.item.path}`,policy:r.item?.title,control:r.item?.title,container:r.item?.title,file:r.id,table:r.item&&`${r.item.schema}.${r.item.name}`,machine:r.id,page:r.id,event:r.id,step:r.id}[r.kind];}
 function scope(r){
  if(r.kind==='policies')return `${plural(counts.policies,'policy')} → ${plural(counts.controls,'control')} → scope review → hermetic and live tiers`;
  if(r.kind==='domain')return `Domain → ${plural(r.item.modules.length,'module')} → what they call and store · a reading boundary, not a deployment`;
  if(r.kind==='module')return `Callers → ${plural(r.item.ops.length,'operation')} → this module → what it calls, stores and emits → the controls it serves`;
  if(r.kind==='op')return 'Caller → route → authentication → handler → what the module stores and emits';
  if(r.kind==='policy')return `Policy → ${plural(r.item.controls.length,'control')} → where each one stands`;
  if(r.kind==='control')return 'Emitting modules → triggering events → control → produced events and evidence';
  if(r.kind==='file')return 'Importers → file → its exports → what it imports and stores';
  if(r.kind==='table')return 'Code that references it → table → the tables it points to';
  if(r.kind==='machine')return 'Writers → backing table → the declared states';
  if(r.kind==='page')return 'Staff → page → read-only proxy → core operations → handlers';
  if(r.kind==='event')return 'Emit sites and producing controls → event → the controls it triggers';
  if(r.kind==='step')return 'Previous step → this step → next step and its outputs';
  if(r.id==='postgres')return `Readers and writers → schemas → ${plural(counts.tables,'table')} · ${plural(counts.machines,'state machine')}`;
  if(r.id==='ui')return `Staff → ${plural(counts.pages,'page')} → read-only proxy → Core API domains`;
  if(r.id==='blnk')return 'Core API → shared Blnk client → ledger → webhook and reconciler → Postgres';
  if(fnDirs.has(r.id))return 'Who starts it → its files, by import depth → what they call and store';
  return 'Deployable or dependency';
 }

 // ---- one diagram per view kind -------------------------------------------------
 function diagramFor(r,eng){
  const D=(label,rows,edges)=>diagram({label,rows,edges},eng);
  const G=(label,nodes,extra={})=>({label,nodes,...extra});
  const P=nodes=>({nodes});

  if(r.kind==='policies'){
   const all=Object.values(controls),inS=all.filter(c=>c.scope==='in'),out=all.length-inS.length;
   const tally=k=>['green','red'].map(s=>inS.filter(c=>c[k]===s).length).concat(inS.filter(c=>!c[k]).length);
   const [hg,hr,hn]=tally('hermetic'),[lg,lr,ln]=tally('live'),both=inS.filter(c=>c.hermetic==='green'&&c.live==='green').length;
   const extract=steps.find(s=>s.script.endsWith('extract_controls.py'));
   return D('How policy text becomes tested controls',[
    [G('Policy text · compliance/policies',[N.port('docs',`${counts.policies} policy documents`,'Markdown, one per policy, each listing its controls')])],
    [P([extract?N.step(extract):N.port('x','extract_controls.py')])],
    [P([{id:'cat',kind:'controls.json',title:`${counts.controls} controls`,sub:'the extracted catalogue: rules, triggers, citations',tech:'controls.json'}])],
    [P([{id:'scope',kind:'Scope review',title:'Does software discharge it?',sub:'control-scope.json, one verdict per control',tone:'decision',tech:'control-scope.json'}])],
    [P([{id:'in',title:`In scope · ${inS.length}`,sub:'claimed by the system: must have a test'},{id:'out',title:`Scoped out · ${out}`,sub:'discharged by people and paperwork; not claimed',tone:'exit'}])],
    [G('Evidence',[{...N.container('drill'),id:'herm',title:'Hermetic tier',sub:`${hg} green · ${hr} red · ${hn} not run`,tech:'control-tests.json'},{id:'live',title:'Live tier',sub:`${lg} green · ${lr} red · ${ln} not run`,href:gh('.github/workflows/live-control-tier.yml'),external:true,tech:'control-tests-live.json'}])],
    [P([{id:'both',title:`Green in both tiers · ${both}`,sub:`of ${inS.length} in-scope controls`,tone:'current'}])],
   ],[
    {from:'docs',to:'st:'+(extract?.script||''),label:'read every rebuild'},{from:'st:'+(extract?.script||''),to:'cat',label:'writes'},{from:'cat',to:'scope'},
    {from:'scope',to:'in',label:'yes'},{from:'scope',to:'out',label:'no'},{from:'in',to:'herm',label:'fake database'},{from:'in',to:'live',label:'the real core'},
    {from:'herm',to:'both'},{from:'live',to:'both'}]);
  }
  if(r.kind==='domain'){const d=r.item,mine=new Set(d.modules);
   const outDom={},inDom={};
   d.modules.forEach(m=>modules[m].imports.forEach(i=>{const o=domainOf[i];if(o&&o.id!==d.id)(outDom[o.id]??=new Set()).add(m);}));
   Object.entries(modules).forEach(([m,x])=>{const o=domainOf[m];if(o&&o.id!==d.id&&x.imports.some(i=>mine.has(i)))(inDom[o.id]??=new Set()).add(m);});
   const tabs=new Set(d.modules.flatMap(m=>modules[m].tables)),evs=new Set(d.modules.flatMap(m=>modules[m].events));
   const ops=d.modules.reduce((n,m)=>n+modules[m].ops.length,0);
   // Per-module edges inside the domain; one edge per outside target from the
   // domain frame, saying how many of its modules make that reference.
   const gid='g:'+d.title,n=d.modules.length,share=(verb,ms)=>({label:`${verb} · ${ms.length} of ${n} modules`,tech:ms.map(m=>m+'.ts').join(', ')});
   const edges=[];
   d.modules.forEach(m=>{const x=modules[m];
    if(x.ops.length)edges.push({from:'router',to:'m:'+m,label:plural(x.ops.length,'op'),tech:'routes.gen.ts'});
    x.imports.filter(i=>mine.has(i)).forEach(i=>edges.push({from:'m:'+m,to:'m:'+i,label:'imports'}));});
   Object.entries(outDom).forEach(([o,s])=>edges.push({from:gid,to:'d:'+o,...share('imports',[...s])}));
   const withT=d.modules.filter(m=>modules[m].tables.length),withE=d.modules.filter(m=>modules[m].events.length),withB=d.modules.filter(m=>blnk.modules.includes(m));
   if(withT.length)edges.push({from:gid,to:'pg',...share('reads/writes',withT)});
   if(withE.length)edges.push({from:gid,to:'outbox',...share('emits',withE)});
   if(withB.length)edges.push({from:gid,to:'k:_shared',...share('Blnk client',withB)});
   Object.keys(inDom).forEach(o=>edges.push({from:'in:'+o,to:'g:'+d.title,label:'imports'}));
   return D(`Inside ${d.title}`,[
    [G('Called by other domains',Object.keys(inDom).map(o=>({...N.domain(domains.find(x=>x.id===o)),id:'in:'+o,sub:[...inDom[o]].map(m=>m+'.ts').join(', ')}))),ops?P([N.port('router','index.ts router',`${plural(ops,'operation')} dispatched here`,{href:'#/module/index',tech:'core/supabase/functions/api/index.ts'})]):P([])],
    [G(d.title,d.modules.map(m=>N.module(m)))],
    [G('Other domains it calls',Object.keys(outDom).map(o=>N.domain(domains.find(x=>x.id===o)))),G('Stores and side effects',[...(tabs.size?[{...N.container('postgres'),id:'pg',sub:plural(tabs.size,'table')+' referenced'}]:[]),...(evs.size?[N.port('outbox','Event outbox',plural(evs.size,'event code'))]:[]),...(d.modules.some(m=>blnk.modules.includes(m))?[N.container('_shared')]:[])])],
   ],edges);
  }
  if(r.kind==='module'){const x=r.item,m=r.id,me='m:'+m;
   const [ops,opRest]=take(x.ops,8),[imp,impRest]=take(x.importedBy,6),[deps,depRest]=take(x.imports,4),[tabs,tabRest]=take(x.tables,4),[evs,evRest]=take(x.events,4),[ctl,ctlRest]=take(x.controls,4);
   const gateCtl=[...new Set(x.gate.flatMap(g=>g.claims.map(([u])=>u).filter(Boolean)))].filter(u=>!ctl.includes(u));
   const edges=[];
   ops.forEach(k=>{edges.push({from:'router',to:'o:'+k,label:'dispatches'});edges.push({from:'o:'+k,to:me,label:'handled by',tech:operations[k].handler});});
   if(opRest)edges.push({from:'router',to:'more:ops'});
   imp.forEach(i=>edges.push({from:'m:'+i,to:me,label:'imports'}));
   deps.forEach(i=>edges.push({from:me,to:'m:'+i,label:'calls'}));
   x.crossImports.forEach(f=>edges.push({from:me,to:'x:'+f,label:'imports'}));
   x.gate.forEach(g=>{g.claims.forEach(([u,v])=>u&&edges.push({from:'cg:'+g.id,to:'c:'+u,label:verdict(v),style:'dotted'}));});
   tabs.forEach(t=>edges.push({from:me,to:'t:'+t,label:'reads/writes'}));
   evs.forEach(e=>{edges.push({from:me,to:'e:'+e,label:'emits'});(events[e]?.triggerOf||[]).forEach(u=>edges.push({from:'e:'+e,to:'c:'+u,label:'triggers'}));(events[e]?.producedBy||[]).forEach(u=>edges.push({from:'e:'+e,to:'c:'+u,label:'evidence for',style:'dashed'}));});
   return D(`Inside ${m}.ts`,[
    [G('Callers',[...(x.ops.length?[N.port('router','index.ts router',plural(x.ops.length,'route'),{href:m==='index'?'':'#/module/index'})]:[]),...imp.map(i=>N.module(i)),...more('imp',impRest,'importers')])],
    [G('Operations it handles',[...ops.map(N.op),...more('ops',opRest,'operations')])],
    // The module's gate checks are part of it, so they are drawn inside its box.
    x.gate.length?{frame:`${m}.ts · this module · ${plural(x.exports.length,'exported function')} · gate checks it implements`,id:me,
      rows:[[P(x.gate.map(g=>({id:'cg:'+g.id,kind:'Gate control · crosswalk claim',title:g.id,sub:first(g.behaviour),tone:'decision',tech:'crosswalk.json'})))]]}
     :[P([N.module(m,{tone:'current',href:'',sub:first(x.about)||`${plural(x.exports.length,'exported function')} · ${x.lines} lines`,tech:x.exports.join(', ')})])],
    [G('Calls into',[...deps.map(i=>N.module(i)),...x.crossImports.map(f=>({id:'x:'+f,kind:'Other function',title:f,sub:box[f.split('/')[0]]?.title||'',href:files[f]?'#/file/'+enc(f):(box[f.split('/')[0]]?.href||''),tech:f})),...more('deps',depRest,'modules')]),G('Tables it references',[...tabs.map(t=>N.table(t)),...more('tabs',tabRest,'tables')])],
    [G('Event codes it emits',[...evs.map(e=>N.event(e)),...more('evs',evRest,'event codes')]),G('Controls its events and gates serve',[...ctl.map(u=>N.control(u)),...gateCtl.map(u=>N.control(u)),...more('ctl',ctlRest,'controls')])],
   ],edges);
  }
  if(r.kind==='op'){const o=r.item,x=modules[o.module];
   const who={partner:['Partner fintech','instance-scoped Bearer token'],internal:['Staff and internal callers','authenticated actor'],public:['Anyone','no credentials']}[o.audience]||[o.audience,''];
   const [tabs]=take(x.tables,6),[evs]=take(x.events,6);
   const edges=[{from:'caller',to:'route',label:`${o.method} ${o.path}`},
    o.audience==='public'?{from:'route',to:'handler',label:'public: dispatched without authentication'}:{from:'route',to:'auth',label:'non-public route'},
    ...(o.audience==='public'?[]:[{from:'auth',to:'handler',label:o.actors.length?'actor allowed':'authenticated'}]),
    ...tabs.map(t=>({from:'handler',to:'t:'+t,label:'module references',style:'dashed'})),...evs.map(e=>({from:'handler',to:'e:'+e,label:'module emits',style:'dashed'})),
    ...o.flows.map(f=>({from:'fl:'+f,to:'route',label:'calls this path',style:'dashed'}))];
   return D(`${o.method} ${o.path}`,[
    [P([N.person('caller',who[0],who[1]+(o.actors.length?' · actors '+o.actors.join(', '):''))]),G('Live flows that call this path',o.flows.map(f=>({id:'fl:'+f,kind:'Live E2E flow',title:f+'.test.ts',href:gh('core/verifier/flows/'+f+'.test.ts'),external:true,tech:'core/verifier/flows/'+f+'.test.ts'})))],
    [P([{id:'route',kind:o.route==='hand'?'Hand-written route · index.ts':'Generated route · routes.gen.ts',title:o.operationId||`${o.method} ${o.path}`,sub:`tier ${o.tier}`,href:gh('core/core-api.yaml',o.specLine),external:true,tech:`core-api.yaml:${o.specLine}`}])],
    [P(o.audience==='public'?[]:[{...N.module('auth'),id:'auth',kind:'Authentication',sub:o.actors.length?'resolves the actor, then the route\'s actor gate':'resolves the actor context'}])],
    [P([{id:'handler',kind:`Handler in ${o.module}.ts`,title:o.handler.split('.').pop()||o.handler,sub:o.summary,tone:'current',href:gh(x.file,o.handlerLine),external:true,tech:`${x.file}:${o.handlerLine}`}])],
    [G(`What ${o.module}.ts stores · module-level`,tabs.map(t=>N.table(t))),G(`What ${o.module}.ts emits · module-level`,evs.map(e=>N.event(e)))],
   ],edges);
  }
  if(r.kind==='policy'){const p=r.item,cs=p.controls;
   const buckets=[['b:green','Green in both tiers',c=>c.scope==='in'&&c.hermetic==='green'&&c.live==='green'],['b:red','Red in a tier',c=>c.scope==='in'&&(c.hermetic==='red'||c.live==='red')],['b:notrun','Not run in a tier',c=>c.scope==='in'&&!(c.hermetic==='green'&&c.live==='green')&&c.hermetic!=='red'&&c.live!=='red'],['b:out','Scoped out · paperwork',c=>c.scope!=='in']];
   const used=buckets.filter(([,,f])=>cs.some(u=>f(controls[u])));
   const edges=[{from:'doc',to:'g:In scope',label:'claimed by the system'},{from:'doc',to:'g:Scoped out',label:'left to people and paperwork'},...cs.map(u=>({from:'c:'+u,to:buckets.find(([,,f])=>f(controls[u]))[0],label:'stands at'}))];
   return D(p.title,[
    [P([{id:'doc',kind:'Policy document',title:p.title,sub:plural(cs.length,'control'),href:gh(p.file),external:true,tech:p.file}])],
    [G('In scope',cs.filter(u=>controls[u].scope==='in').map(u=>N.control(u))),G('Scoped out',cs.filter(u=>controls[u].scope!=='in').map(u=>N.control(u)))],
    [P(used.map(([id,t,f])=>({id,title:t,sub:plural(cs.filter(u=>f(controls[u])).length,'control'),tone:id==='b:green'?'current':id==='b:out'?'exit':''})))],
   ],edges);
  }
  if(r.kind==='control'){const c=r.item,me='c:'+r.id;
   const trigMods=[...new Set(c.triggers.flatMap(([,ms])=>ms))];
   const edges=[...c.triggers.flatMap(([code,ms])=>[...ms.map(m=>({from:'m:'+m,to:'e:'+code,label:'emits'})),{from:'e:'+code,to:me,label:'triggers'}]),
    ...c.gate.map(([g,m,v])=>({from:'cg:'+g,to:me,label:verdict(v),style:'dotted'})),...c.gate.map(([g,m])=>({from:'m:'+m,to:'cg:'+g,label:'implements'})),
    ...c.produced.map(([code])=>({from:me,to:'e:'+code,label:'produces'})),
    {from:me,to:'herm',label:'tested by',style:'dashed'},{from:me,to:'live',label:'tested by',style:'dashed'},...(c.traced&&traced.processes?traced.edges:[])];
   const gateMods=[...new Set(c.gate.map(([,m])=>m))].filter(m=>!trigMods.includes(m));
   return D(`${c.id} flow`,[
    [G('Modules that emit its triggers',[...trigMods,...gateMods].map(m=>N.module(m)))],
    [G('Triggering events',c.triggers.map(([code])=>N.event(code))),G('Gate checks claimed · crosswalk',c.gate.map(([g,m])=>({id:'cg:'+g,kind:`Gate control in ${m}.ts`,title:g,tone:'decision',tech:'crosswalk.json'})))],
    c.traced&&traced.processes?{frame:`${c.id} · ${c.title} · inside, traced by hand`,id:me,rows:traced.processes.map(x=>[P([{...x,href:'#/process/'+x.id,tone:'traced'}])])}
     :[P([{id:me,kind:`Control · ${c.id} · ${c.scope==='in'?'In scope':'Scoped out'}`,title:c.title,sub:first(c.behavior),tone:'current decision',tech:r.id}])],
    [G('Produced events',c.produced.map(([code])=>N.event(code))),G('Evidence',[{id:'herm',kind:'Hermetic tier · fake database',title:`Hermetic: ${c.hermetic||'not run'}`,sub:c.blockedOn?'blocked on '+JSON.stringify(c.blockedOn):'',href:'#/container/drill',tech:'control-tests.json'},{id:'live',kind:'Live tier · the real core',title:`Live: ${c.live||'not run'}`,sub:c.reachability?'reachability '+c.reachability:'',tech:'control-tests-live.json'}])],
   ],edges);
  }
  if(r.kind==='event'){const e=r.item,me='e:'+r.id;
   const siteNode=([path,line],i)=>{const stem=path.split('/').pop().replace(/\.ts$/,''),rel=path.replace('core/supabase/functions/','');
    return {id:'site:'+i,kind:'Emit site',title:path.split('/').pop()+(line>1?':'+line:''),sub:path.startsWith('core/supabase/functions/api/')?`in ${stem}.ts`:path,href:path.startsWith('core/supabase/functions/api/')&&modules[stem]?'#/module/'+stem:files[rel]?'#/file/'+enc(rel):gh(path,line>1?line:0),external:!(path.startsWith('core/supabase/functions/api/')&&modules[stem])&&!files[rel],tech:`${path}:${line}`};};
   const [sites,siteRest]=take(e.sites,10);
   const pols=[...new Set(e.triggerOf.map(u=>controls[u].policy))];
   return D(r.id,[
    [G('Emit sites',[...sites.map(siteNode),...more('sites',siteRest,'emit sites')]),G('Controls that produce it',e.producedBy.map(u=>N.control(u,{id:'pb:'+u})))],
    [P([{id:me,kind:'Event code · recorded in the outbox',title:r.id,sub:'consumed by the verifier and the aggregator',tone:'current',tech:'crosswalk-emitted-events.json'}])],
    [G('Controls it triggers',e.triggerOf.map(u=>N.control(u)))],
    [G('Their policies',pols.map(p=>({id:'pol:'+p,kind:'Policy',title:policies[p].title,href:'#/policy/'+p,tech:policies[p].file})))],
   ],[...sites.map((_,i)=>({from:'site:'+i,to:me,label:'emits'})),...e.producedBy.map(u=>({from:'pb:'+u,to:me,label:'produces'})),...e.triggerOf.map(u=>({from:me,to:'c:'+u,label:'triggers'})),...e.triggerOf.map(u=>({from:'c:'+u,to:'pol:'+controls[u].policy,label:'belongs to'}))]);
  }
  if(r.kind==='file'){const f=r.item,me='f:'+r.id;
   const importers=Object.keys(files).filter(k=>files[k].fn===f.fn&&files[k].imports.some(i=>`${f.fn}/${i}.ts`===r.id||`${f.fn}/${i}`===r.id));
   const crossIn=[...Object.keys(files).filter(k=>files[k].crossImports.includes(r.id)),...Object.keys(modules).filter(m=>modules[m].crossImports.includes(r.id)).map(m=>'api:'+m)];
   const sibs=f.imports.map(i=>files[`${f.fn}/${i}.ts`]?`${f.fn}/${i}.ts`:files[`${f.fn}/${i}`]?`${f.fn}/${i}`:null).filter(Boolean);
   const tabs=Object.keys(tables).filter(k=>tables[k].functionFiles.includes(r.id));
   const [ex,exRest]=take(f.exports,10),[tb,tbRest]=take(tabs,8);
   const inNode=k=>k.startsWith('api:')?N.module(k.slice(4)):N.file(k);
   const inId=k=>k.startsWith('api:')?'m:'+k.slice(4):'f:'+k;
   return D(r.id,[
    [G('Imported by',[...importers,...crossIn].map(inNode))],
    [P([N.file(r.id,{tone:'current',href:'',sub:first(f.about)||`${f.lines} lines`})])],
    [G('Exports',[...ex.map(([n,l])=>({id:'x:'+n,kind:'Export',title:n,sub:'line '+l,href:gh(f.file,l),external:true,tech:`${f.file}:${l}`})),...more('ex',exRest,'exports')])],
    [G('Imports',[...sibs.map(k=>N.file(k)),...f.crossImports.map(k=>k.startsWith('api/')&&modules[k.slice(4,-3)]?N.module(k.slice(4,-3)):files[k]?N.file(k):{id:'cx:'+k,title:k,tone:'port'})]),G('Tables it references',[...tb.map(t=>N.table(t)),...more('tb',tbRest,'tables')])],
   ],[...[...importers,...crossIn].map(k=>({from:inId(k),to:me,label:'imports'})),...ex.map(([n])=>({from:me,to:'x:'+n,label:'defines'})),
     ...sibs.map(k=>({from:me,to:'f:'+k,label:'imports'})),...f.crossImports.map(k=>({from:me,to:k.startsWith('api/')&&modules[k.slice(4,-3)]?'m:'+k.slice(4,-3):files[k]?'f:'+k:'cx:'+k,label:'imports'})),...tb.map(t=>({from:me,to:'t:'+t,label:'reads/writes'}))]);
  }
  if(r.kind==='table'){const t=r.item,me='t:'+r.id;
   const [mods,modRest]=take(t.modules,10),[ff,ffRest]=take(t.functionFiles,8),[rb,rbRest]=take(t.referencedBy,8),[fk,fkRest]=take(t.fks,10);
   const machine=Object.keys(machines).find(n=>machines[n].tables.includes(r.id));
   return D(r.id,[
    [G('Code that references it',[...mods.map(m=>N.module(m)),...more('mods',modRest,'modules'),...ff.map(k=>N.file(k)),...more('ff',ffRest,'files')]),G('Tables that point here · FK',[...rb.map(k=>N.table(k,{id:'rb:'+k})),...more('rb',rbRest,'tables')])],
    [P([{id:me,kind:`Table · ${t.schema} schema`,title:t.name,sub:`${plural(t.columns.length,'column')}${t.fks.length?' · '+plural(t.fks.length,'foreign key'):''}`,tone:'store current',tech:`${t.migration}:${t.line}`}])],
    [G('Tables it points to · FK',[...fk.map(([col,k])=>N.table(k,{id:'fk:'+col,kind:`via ${col}`})),...more('fk',fkRest,'foreign keys')]),G('State machine',machine?[N.machine(machine)]:[]),G('Defined in',[{id:'mig',kind:'Migration',title:t.migration.split('/').pop(),sub:'line '+t.line,href:gh(t.migration,t.line),external:true,tech:t.migration}])],
   ],[...mods.map(m=>({from:'m:'+m,to:me,label:'reads/writes'})),...ff.map(k=>({from:'f:'+k,to:me,label:'reads/writes'})),...rb.map(k=>({from:'rb:'+k,to:me,label:'FK'})),
     ...fk.map(([col])=>({from:me,to:'fk:'+col,label:col,tech:'foreign key'})),...(machine?[{from:'s:'+machine,to:me,label:'stored in'}]:[]),{from:'mig',to:me,label:'creates',style:'dotted'}]);
  }
  if(r.kind==='machine'){const m=r.item,key=m.tables[0],t=key&&tables[key];
   const writers=t?t.modules:[];const [w,wRest]=take(writers,8);
   return D(`${r.id} state machine`,[
    [G('Code that writes the backing table',[...w.map(x=>N.module(x)),...more('w',wRest,'modules')])],
    [P(t?[N.table(key)]:[N.port('nobacking','No backing table found','no table matches this machine\'s name')])],
    [G(`Declared states · in the spec's order · ${m.states.length}`,m.states.map(s=>({id:'st:'+s,title:s,tone:'state',tech:`status = '${s}'`})))],
   ],[...w.map(x=>({from:'m:'+x,to:t?'t:'+key:'nobacking',label:'writes'})),...m.states.map(s=>({from:t?'t:'+key:'nobacking',to:'st:'+s,label:'status',style:'dotted'})),...m.states.slice(1).map((s,i)=>({from:'st:'+m.states[i],to:'st:'+s,label:i===0?'declared order · not a transition list':'',style:'dotted'}))]);
  }
  if(r.kind==='page'){const p=r.item;
   const [ops,opRest]=take(p.ops,10);const mods=[...new Set(ops.map(k=>operations[k].module))];
   return D(r.id,[
    [P([N.person('staff','Credit-union staff','in a browser')])],
    [P([N.page(r.id,{tone:'current',href:''})])],
    [P(p.ops.length?[{id:'proxy',kind:'Server-side proxy',title:'Read-only core proxy',sub:'GET only · allowlist generated from the spec',href:gh('ui/src/lib/coreApi.allowlist.json'),external:true,tech:'ui/src/lib/coreApi.allowlist.json'}]:[N.port('noop','No core operation named in this page','it may compose other pages or read through shared helpers in ui/src/lib')])],
    [G('Core operations it reads',[...ops.map(N.op),...more('ops',opRest,'operations')])],
    [G('Handled by',mods.map(m=>N.module(m)))],
   ],[{from:'staff',to:'p:'+r.id,label:'opens'},{from:'p:'+r.id,to:p.ops.length?'proxy':'noop',label:p.ops.length?'fetches':''},...ops.map(k=>({from:'proxy',to:'o:'+k,label:'GET'})),...ops.map(k=>({from:'o:'+k,to:'m:'+operations[k].module,label:'handled by'}))]);
  }
  if(r.kind==='step'){const i=steps.findIndex(s=>s.script===r.id),s=r.item,prev=steps[i-1],next=steps[i+1];
   const wfs=Object.keys(workflows).filter(w=>workflows[w].runs.includes(s.script));
   return D(r.id,[
    [P(prev?[N.step(prev)]:[N.port('in','core/core-api.yaml and the policies','the rebuild\'s inputs')]),G('CI workflows that run it directly',wfs.map(w=>N.workflow(w)))],
    [P([N.step(s,{tone:(s.gate?'decision ':'')+'current',href:gh(s.script),external:true})])],
    [G('Writes',s.outputs.map(o=>({id:'out:'+o,kind:'Artifact',title:o,tone:'store',tech:o}))),P(s.gate?[{id:'red',title:'Red build',sub:'the gate failed: nothing downstream runs',tone:'exit'}]:[])],
    [P(next?[N.step(next)]:[N.port('done','Rebuild complete','STATE.md and the doc claims are last')])],
   ],[{from:prev?'st:'+prev.script:'in',to:'st:'+s.script,label:'then'},...wfs.map(w=>({from:'w:'+w,to:'st:'+s.script,label:'runs',style:'dashed'})),...s.outputs.map(o=>({from:'st:'+s.script,to:'out:'+o,label:'writes'})),
     ...(s.gate?[{from:'st:'+s.script,to:'red',label:'fails'}]:[]),{from:'st:'+s.script,to:next?'st:'+next.script:'done',label:s.gate?'passes':'then'}]);
  }
  if(r.kind==='container')return containerDiagram(r,eng,D,G,P);
  return '';
 }

 function containerDiagram(r,eng,D,G,P){const id=r.id;
  if(id==='postgres'){
   const schemas=[...new Set(Object.values(tables).map(t=>t.schema))].sort();
   const users=links.filter(l=>l.to==='postgres').map(l=>l.from);
   const top=Object.keys(tables).filter(k=>tables[k].schema==='core').sort((a,b)=>(tables[b].modules.length+tables[b].functionFiles.length)-(tables[a].modules.length+tables[a].functionFiles.length)).slice(0,8);
   const schemaOf=dir=>[...new Set(Object.values(tables).filter(t=>dir==='api'?t.modules.length:t.functionFiles.some(f=>f.startsWith(dir+'/'))).map(t=>t.schema))];
   const [ms,msRest]=take(Object.keys(machines),8);
   return D('Postgres',[
    [G('Code that reads and writes it',users.map(u=>N.container(u,{sub:plural(linkOf(u,'postgres').count,'table')+' referenced'})))],
    [G('Schemas',schemas.map(s=>{const ks=Object.keys(tables).filter(k=>tables[k].schema===s);return {id:'sch:'+s,kind:'Schema',title:s,sub:`${plural(ks.length,'table')} · ${plural(ks.reduce((n,k)=>n+tables[k].fks.length,0),'foreign key')}`,tone:'store',scroll:true,tech:`"${s}".*`};}))],
    [G('Most-referenced core tables',top.map(k=>N.table(k)))],
    [G('Declared state machines',[...ms.map(n=>N.machine(n)),...more('ms',msRest,'state machines')])],
   ],[...users.flatMap(u=>schemaOf(u).map(s=>({from:'k:'+u,to:'sch:'+s,label:'reads/writes'}))),...top.map(k=>({from:'sch:core',to:'t:'+k,label:'contains'})),...ms.flatMap(n=>machines[n].tables.filter(k=>top.includes(k)).map(k=>({from:'s:'+n,to:'t:'+k,label:'stored in'})))]);
  }
  if(id==='ui'){
   const byDom={};Object.entries(operations).filter(([,o])=>o.ui).forEach(([k,o])=>{const d=domainOf[o.module];(byDom[d.id]??=[]).push(k);});
   const reading=Object.keys(pages).filter(p=>pages[p].ops.length);
   return D('Staff console',[
    [P([N.person('staff','Credit-union staff','teller, accounting, approvals'),N.person('officer','Compliance officer / examiner','reviews the control dashboards')])],
    [G('Pages · ui/src/pages',Object.keys(pages).map(p=>N.page(p)))],
    [P([{id:'proxy',kind:'Server-side proxy',title:'Read-only core proxy',sub:`GET only · ${Object.values(operations).filter(o=>o.ui).length} allowlisted operations, generated from the spec`,href:gh('ui/src/lib/coreApi.allowlist.json'),external:true,tech:'ui/src/lib/coreApi.allowlist.json'}])],
    [G('Core API domains it reads',Object.keys(byDom).map(d=>N.domain(domains.find(x=>x.id===d),{sub:plural(byDom[d].length,'UI-surface operation')})))],
   ],[{from:'staff',to:'g:Pages · ui/src/pages',label:'uses'},{from:'officer',to:'g:Pages · ui/src/pages',label:'reviews'},...reading.map(p=>({from:'p:'+p,to:'proxy',label:'fetches'})),...Object.keys(byDom).map(d=>({from:'proxy',to:'d:'+d,label:plural(byDom[d].length,'GET')}))]);
  }
  if(id==='blnk'){
   const [mods,modRest]=take(blnk.modules,10);
   const cols=Object.keys(tables).filter(k=>tables[k].schema==='core'&&tables[k].columns.some(([c])=>/blnk/.test(c))).slice(0,8);
   const client=Object.keys(files).find(k=>k==='_shared/blnk.ts');
   const users=['blnk-webhook','blnk-reconcile','drill'].filter(d=>links.some(l=>l.from===d&&l.to==='_shared'));
   return D('Blnk ledger',[
    [G('Core API modules that reference Blnk',[...mods.map(m=>N.module(m)),...more('mods',modRest,'modules')]),G('Other functions that import the client',users.map(u=>N.container(u,{id:'u:'+u})))],
    [P(client?[N.file(client,{kind:'Shared Blnk client'})]:[])],
    [P([{...N.container('blnk'),tone:'external current',href:''}])],
    [G('Mirror back into Postgres',['blnk-webhook','blnk-reconcile'].map(d=>N.container(d)))],
    [G('Core tables with Blnk columns',cols.map(k=>N.table(k)))],
   ],[...mods.map(m=>({from:'m:'+m,to:'f:_shared/blnk.ts',label:'imports'})),...users.map(u=>({from:'u:'+u,to:'f:_shared/blnk.ts',label:'imports'})),{from:'f:_shared/blnk.ts',to:'k:blnk',label:'HTTPS calls'},
     {from:'k:blnk',to:'k:blnk-webhook',label:'sends ledger webhooks · per its header',style:'dashed'},{from:'k:blnk-reconcile',to:'k:blnk',label:'re-reads balances',style:'dashed'},...cols.flatMap(k=>['blnk-webhook','blnk-reconcile'].filter(d=>tables[k].functionFiles.some(f=>f.startsWith(d+'/'))).map(d=>({from:'k:'+d,to:'t:'+k,label:'mirrors into'})))]);
  }
  if(fnDirs.has(id)){
   const own=Object.keys(files).filter(k=>files[k].fn===id),main=own.filter(k=>!files[k].test),tests=own.filter(k=>files[k].test);
   const sib=(k,i)=>files[`${id}/${i}.ts`]?`${id}/${i}.ts`:files[`${id}/${i}`]?`${id}/${i}`:null;
   const importedBy=k=>main.filter(o=>files[o].imports.some(i=>sib(o,i)===k));
   // depth = longest import chain from an entry file (one no other main file imports)
   const depth={};const walk=(k,d,seen)=>{if(seen.has(k))return;seen.add(k);depth[k]=Math.max(depth[k]??0,d);files[k].imports.map(i=>sib(k,i)).filter(x=>x&&main.includes(x)).forEach(x=>walk(x,d+1,new Set(seen)));};
   main.filter(k=>!importedBy(k).length).forEach(k=>walk(k,0,new Set()));main.forEach(k=>depth[k]??=0);
   const levels=[...new Set(Object.values(depth))].sort((a,b)=>a-b);
   const inbound=[...Object.keys(files).filter(k=>files[k].fn!==id&&files[k].crossImports.some(x=>x.startsWith(id+'/'))).map(k=>files[k].fn),...Object.keys(modules).filter(m=>modules[m].crossImports.some(x=>x.startsWith(id+'/'))).map(()=>'api')];
   const callers=[...new Set(inbound)];
   const wfs=Object.keys(workflows).filter(w=>workflows[w].runs.some(x=>x.startsWith(id==='analytics'?'analytics/':`core/supabase/functions/${id}/`)));
   const outs=[...new Set(main.flatMap(k=>files[k].crossImports.map(x=>x.split('/')[0])))].filter(d=>d!==id);
   const pg=linkOf(id,'postgres'),bl=linkOf(id,'blnk');
   const edges=[];
   main.forEach(k=>files[k].imports.map(i=>sib(k,i)).filter(Boolean).forEach(x=>edges.push({from:'f:'+k,to:'f:'+x,label:'imports'})));
   tests.forEach(k=>files[k].imports.map(i=>sib(k,i)).filter(x=>x&&main.includes(x)).forEach(x=>edges.push({from:'f:'+k,to:'f:'+x,label:'tests',style:'dashed'})));
   // an outside importer points at the exact file it imports
   const crossPairs=[...Object.keys(files).filter(k=>files[k].fn!==id).flatMap(k=>files[k].crossImports.filter(x=>x.startsWith(id+'/')).map(x=>[files[k].fn,x])),...Object.keys(modules).flatMap(m=>modules[m].crossImports.filter(x=>x.startsWith(id+'/')).map(x=>['api',x]))];
   [...new Set(crossPairs.map(p=>p.join('>')))].map(p=>p.split('>')).forEach(([c,x])=>edges.push({from:'in:'+c,to:files[x]?'f:'+x:'g:Depth 0 · entry points',label:'imports'}));
   wfs.forEach(w=>edges.push({from:'w:'+w,to:'g:Depth 0 · entry points',label:'runs',style:'dashed'}));
   main.forEach(k=>files[k].crossImports.forEach(x=>{const d=x.split('/')[0];if(d!==id)edges.push({from:'f:'+k,to:'out:'+d,label:'imports'});}));
   if(pg)main.filter(k=>Object.values(tables).some(t=>t.functionFiles.includes(k))).forEach(k=>edges.push({from:'f:'+k,to:'k:postgres',label:'reads/writes'}));
   if(bl)edges.push({from:'g:Depth 0 · entry points',to:'k:blnk',label:'HTTPS calls'});
   return D(box[id].title,[
    [G('Who starts or imports it',[...callers.map(c=>c==='api'?{...N.container('api'),id:'in:api'}:{...N.container(c),id:'in:'+c}),...wfs.map(w=>N.workflow(w))])],
    ...levels.map(l=>[G(l===0?'Depth 0 · entry points':`Depth ${l} · imported by the row above`,main.filter(k=>depth[k]===l).map(k=>N.file(k)))]),
    [G('Tests · definitions, not run results',tests.map(k=>N.file(k))),G('What it reaches outside itself',[...outs.map(d=>({...N.container(d),id:'out:'+d})),...(pg?[N.container('postgres',{sub:plural(pg.count,'table')+' referenced'})]:[]),...(bl?[N.container('blnk')]:[])])],
   ],edges);
  }
  return '';
 }

 // ---- complete listings that follow a capped diagram -------------------------------
 function indexFor(r,eng){
  if(r.kind==='policies')return index(`Every policy · ${counts.policies}`,grid(Object.keys(policies).map(id=>{const p=policyRow(id);return card('#/policy/'+id,'Policy',policies[id].title,`${plural(p.cs.length,'control')} · ${p.inScope.length} in scope · ${p.green} green in both tiers`,'Open policy ↘');})));
  // A module's and a control's listings repeat their diagram, so they follow it only when it had to cap a list.
  if((r.kind==='module'||r.kind==='control')&&!capped)return '';
  if(r.kind==='module'){const x=r.item;
   // Only the lists the diagram cut short; everything else is already drawn.
   const byAudience=x.ops.length>8?['partner','internal','public'].map(a=>[a,x.ops.filter(k=>operations[k].audience===a)]).filter(([,l])=>l.length):[];
   const parts=[...byAudience.map(([a,l])=>section(`${a} operations · ${l.length}`,grid(l.map(opCard)))),
    x.controls.length>4?section(`Controls whose events this module emits · ${x.controls.length}`,grid(x.controls.map(ctlCard))):'',
    x.events.length>4?section(`Event codes emitted · ${x.events.length}`,evChips(x.events)):'',
    x.tables.length>4?section(`Tables referenced · ${x.tables.length}`,x.tables.map(k=>`<a class="pill" href="#/table/${esc(enc(k))}">${esc(k)}</a>`).join(' ')):'',
    x.imports.length>4?section(`Calls into · ${x.imports.length}`,x.imports.map(modLink).join(' ')):'',
    x.importedBy.length>6?section(`Called by · ${x.importedBy.length}`,x.importedBy.map(modLink).join(' ')):''].join('');
   return parts?index('The rest of each list the diagram shortened',parts):'';}
  if(r.kind==='op')return `<div class="leafsource">${src('core/core-api.yaml',r.item.specLine,'Read the operation in the spec')}${src(modules[r.item.module].file,r.item.handlerLine,'Read the handler')}</div>`;
  if(r.kind==='control'){const c=r.item;const rows=list=>list.map(([code,ms])=>`<div class="eventrow">${evLink(code)}<span>${ms.length?'emitted by '+ms.map(modLink).join(' '):'<span class="muted">no routed emitter</span>'}</span></div>`).join('');
   return index('Events and emitters',`${section('Triggering events',c.triggers.length?rows(c.triggers):'<p class="muted">None declared: exercised on a schedule or by review.</p>')}${section('Produced events',c.produced.length?rows(c.produced):'<p class="muted">None declared: its evidence lives in the records it writes.</p>')}${section('Modules that emit its events',c.modules.length?c.modules.map(modLink).join(' '):'<p class="muted">No api/ module emits this control\'s events.</p>')}`);}
  if(r.kind==='event'&&r.item.sites.length>10)return index(`Every emit site · ${r.item.sites.length}`,r.item.sites.map(emitSite).join(''));
  if(r.kind==='file'){const f=r.item;return (f.exports.length>10?index(`Every export · ${f.exports.length}`,f.exports.map(([n,l])=>`<div class="eventrow"><code>${esc(n)}</code><span>${src(f.file,l,'line '+l)}</span></div>`).join('')):'')+`<div class="leafsource">${src(f.file,0,`Read ${r.id} · ${f.lines} lines`)}</div>`;}
  if(r.kind==='table'){const t=r.item;return index(`Columns · ${t.columns.length} · replayed from the migrations`,t.columns.map(([n,ty])=>`<div class="eventrow"><code>${esc(n)}</code>${eng?`<span>${esc(ty)}</span>`:''}</div>`).join('')+(t.modules.length+t.functionFiles.length?'':'<p class="muted">No source names this table statically; code may reach it through a variable table name.</p>'))+`<div class="leafsource">${src(t.migration,t.line,'Read the defining migration')}</div>`;}
  if(r.kind==='machine')return `<div class="leafsource">${src('core/core-api.yaml',r.item.specLine,'Read the declaration in the spec')}</div>`;
  if(r.kind==='page')return `<div class="leafsource">${src(r.item.file,0,`Read ${r.id} · ${r.item.lines} lines`)}</div>`;
  if(r.kind==='step')return `<div class="leafsource">${src(r.item.script,0,'Read the script')}${src('scripts/rebuild_artifacts.sh',r.item.shLine,'See it in the rebuild order')}</div>`;
  if(r.kind==='container'&&r.id==='postgres'){const bySchema={};Object.keys(tables).forEach(k=>{(bySchema[tables[k].schema]??=[]).push(k);});
   // A compact name list, one folded list per schema: the diagram above already draws the shape.
   const pill=(href,text,quiet)=>`<a class="pill${quiet?' quiet':''}" href="${esc(href)}">${esc(text)}</a>`;
   const used=k=>tables[k].modules.length+tables[k].functionFiles.length;
   return index('Every state machine and table',section(`Declared state machines · ${counts.machines}`,Object.keys(machines).map(n=>pill('#/machine/'+enc(n),`${n} · ${plural(machines[n].states.length,'state')}`)).join(' '))
    +Object.keys(bySchema).sort().map(s=>{const ks=bySchema[s],quiet=ks.filter(k=>!used(k)).length;
     return `<details class="schemalist"><summary>${esc(s)} schema · ${plural(ks.length,'table')}${quiet?` · ${quiet} with no static reference (shown faint)`:''}</summary><div>${ks.map(k=>pill('#/table/'+enc(k),tables[k].name,!used(k))).join(' ')}</div></details>`;}).join(''));}
  if(r.kind==='container'&&r.id==='blnk'&&blnk.modules.length>10)return index('Every Core API module that references Blnk',blnk.modules.map(modLink).join(' '));
  if(r.kind==='container'&&r.item.file)return `<div class="leafsource">${src(r.item.file,0,r.id==='analytics'?'Read the analytics README':'Read the entrypoint')}</div>`;
  return '';
 }
 const flow=(r,eng=false)=>{const d=diagramFor(r,eng);capped=d.includes('t-more');return d+indexFor(r,eng);};

 function inspector(r,eng=false){
  const box2=(eyebrow,body,cls='section')=>`<div class="${cls}"><div class="eyebrow">${eyebrow}</div>${body}</div>`;
  const gen='';void box2('How this view is made','<p>Generated from the spec, the control catalogue, test results and source by <code>scripts/gen_architecture.py</code>. Each arrow is a static reference (an import, a table name, a route, an emit site, a catalogue trigger), not observed traffic. Dashed arrows are evidence or tests; dotted arrows are reviewed claims or declared order.</p>','check');
  const contract=pairs=>eng?box2('Implementation contract',`<p>${pairs.filter(([,v])=>v!==undefined&&v!==''&&!(Array.isArray(v)&&!v.length)).map(([k,v])=>`<b>${esc(k)}</b> <code>${esc(Array.isArray(v)?v.join(', '):v)}</code>`).join('<br>')}</p>`,'technical'):'';
  if(r.kind==='policies')return `<div class="eyebrow">Compliance catalogue</div><h3>Every policy and control the institution has written</h3>${box2('Status columns','<p><b>Hermetic</b> runs each control against a fake database; <b>Live</b> runs it against the real core. Scoped-out controls are discharged by people and paperwork and are not claimed.</p>')}${contract([['catalogue','controls.json'],['scope','control-scope.json'],['hermetic results','control-tests.json'],['live results','control-tests-live.json']])}${gen}`;
  if(r.kind==='domain')return `<div class="eyebrow">Domain</div><h3>${esc(r.item.about)}</h3>${box2('Boundary','<p>Every module here ships inside the one <code>api</code> edge function. The grouping is for reading.</p>')}${contract([['modules',r.item.modules.map(m=>m+'.ts')],['grouping','DOMAINS in scripts/gen_architecture.py']])}${gen}`;
  if(r.kind==='module'){const x=r.item;return `<div class="eyebrow">Module purpose · from its source header</div><h3>${esc(first(x.about)||`${x.file.split('/').pop()} has no header comment; its exported functions follow`)}</h3>${x.about?box2('Header',`<p>${esc(x.about)}</p>`):''}${box2('Exported functions',chips(x.exports))}${box2('Live flows that call its paths',chips(x.flows.map(f=>f+'.test.ts')))}${contract([['file',x.file],['lines',x.lines],['imports',x.imports.map(i=>i+'.ts')],['cross-function imports',x.crossImports],['tables',x.tables]])}${gen}<div class="sources">${src(x.file,1,`Read ${x.file.split('/').pop()} · ${x.lines} lines`)}</div>`;}
  if(r.kind==='op'){const o=r.item;return `<div class="eyebrow">Operation</div><h3>${esc(o.summary||o.handler)}</h3>${box2('Contract',`<p>Handler <code>${esc(o.handler)}</code>. Audience ${esc(o.audience)}, tier ${esc(o.tier)}${o.actors.length?', actors '+o.actors.map(esc).join(', '):''}. ${o.ui?'Readable by the staff console.':''}</p>`)}${box2('Evidence',`<p>${o.flows.length?'Referenced by live flows: '+o.flows.map(f=>esc(f)+'.test.ts').join(', ')+'.':'No live flow references this path.'} A reference is not a test run.</p>`,'check')}${contract([['operationId',o.operationId],['x-handler',o.handler],['x-route',o.route],['x-audience',o.audience],['x-tier',o.tier],['x-actors',o.actors],['x-ui-surface',String(o.ui)],['spec',`core/core-api.yaml:${o.specLine}`],['handler',`${modules[o.module].file}:${o.handlerLine}`]])}<div class="sources">${src('core/core-api.yaml',o.specLine,'Spec')}${src(modules[o.module].file,o.handlerLine,'Handler')}</div>`;}
  if(r.kind==='policy'){const p=policyRow(r.id);return `<div class="eyebrow">Policy</div><h3>${esc(r.item.title)}</h3>${box2('Coverage',`<p>${plural(p.cs.length,'control')}; ${p.inScope.length} in scope, ${p.green} green in both the hermetic and live tiers.</p>`)}${contract([['file',r.item.file],['controls',r.item.controls]])}${gen}<div class="sources">${src(r.item.file,1,'Read the policy')}</div>`;}
  if(r.kind==='control'){const c=r.item,tr=c.traced&&traced.processes;return `<div class="eyebrow">Control · ${esc(c.id)}</div><h3>${esc(c.title)}</h3>${box2('System behaviour · from the policy',`<p>${esc(c.behavior)}</p>`)}${tr?box2('What the traced code does',traced.processes.map(x=>`<p><b>${esc(x.title)}.</b> ${esc(x.sub)}</p>`).join('')):''}${tr&&traced.gap?box2('Where the policy and the code differ',`<p>${esc(traced.gap)}</p>`,'check'):''}${box2('Evidence',`<p>${c.scope==='in'?'In scope':'Scoped out'} · ${esc(c.scopeWhy)}</p><p>Hermetic ${status(c.hermetic)} · Live ${status(c.live)} · reachability ${esc(c.reachability||'not computed')}${c.blockedOn?' · blocked on '+esc(JSON.stringify(c.blockedOn)):''}</p>`,'check')}${c.citations.length?box2('Regulatory citations',chips(c.citations)):''}${contract([['uid',r.id],['policy line',`${policies[c.policy].file}:${c.policyLine}`],['trigger_event',c.triggers.map(([e])=>e)],['produced_events',c.produced.map(([e])=>e)],['gate controls',c.gate.map(([g])=>g)]])}<div class="sources">${src(policies[c.policy].file,c.policyLine,`Policy ${c.id}`)}</div>`;}
  if(r.kind==='file'){const f=r.item;return `<div class="eyebrow">File purpose · from its source header</div><h3>${esc(first(f.about)||`${r.id.split('/').pop()} has no header comment; its exports are in the map`)}</h3>${f.about?box2('Header',`<p>${esc(f.about)}</p>`):''}${f.test?box2('Scope','<p>A test file: its assertions are definitions, not run results.</p>','check'):''}${contract([['path',f.file],['lines',f.lines],['exports',f.exports.map(([n,l])=>`${n}:${l}`)],['imports',f.imports],['cross-function imports',f.crossImports]])}${gen}<div class="sources">${src(f.file,0,`Read ${r.id} · ${f.lines} lines`)}</div>`;}
  if(r.kind==='table')return `<div class="eyebrow">Table · ${esc(r.item.schema)} schema</div><h3>${esc(r.item.name)}</h3>${box2('How it is read','<p>Columns come from replaying the migrations in order: creates define, <code>add column</code> extends, drops remove. Foreign keys come from <code>add constraint … foreign key</code>. Referencing code is a static match on <code>schema("…").from("…")</code> and SQL names, not a query log.</p>','check')}${contract([['migration',`${r.item.migration}:${r.item.line}`],['foreign keys',r.item.fks.map(([c,k])=>`${c} → ${k}`)],['referenced by tables',r.item.referencedBy]])}${gen}<div class="sources">${src(r.item.migration,r.item.line,'Defining migration')}</div>`;
  if(r.kind==='machine')return `<div class="eyebrow">State machine</div><h3>${esc(r.id)} moves through ${plural(r.item.states.length,'declared state')}</h3>${box2('Where it is enforced','<p>The spec declares the states; the backing table\'s <code>check</code> constraints and the handlers that write it enforce transitions. The dotted chain is the spec\'s order, not a list of legal transitions.</p>','check')}${contract([['spec',`core/core-api.yaml:${r.item.specLine}`],['states',r.item.states],['backing table',r.item.tables]])}${gen}<div class="sources">${src('core/core-api.yaml',r.item.specLine,'Declaration in the spec')}</div>`;
  if(r.kind==='page'){const p=r.item;return `<div class="eyebrow">Console page · from its source header</div><h3>${esc(first(p.about)||r.id)}</h3>${p.about?box2('Header',`<p>${esc(p.about)}</p>`):''}${box2('Boundary','<p>The console reads the core through a read-only proxy whose allowlist is generated from the spec\'s UI-surface operations. An operation named here is a static reference in the page source.</p>','check')}${contract([['file',p.file],['operations',p.ops]])}${gen}<div class="sources">${src(p.file,0,`Read ${r.id} · ${p.lines} lines`)}</div>`;}
  if(r.kind==='event'){const e=r.item;return `<div class="eyebrow">Event code</div><h3>${esc(r.id)}</h3>${box2('What it connects',`<p>${plural(e.sites.length,'emit site')} in the inventory; it triggers ${plural(e.triggerOf.length,'control')} and is produced by ${plural(e.producedBy.length,'control')}. Emission is recorded in the outbox and consumed by the verifier and the aggregator; an emit site is a static reference.</p>`)}${contract([['emit sites',e.sites.map(([p,l])=>`${p}:${l}`)],['triggers',e.triggerOf],['produced by',e.producedBy]])}${gen}`;}
  if(r.kind==='step')return `<div class="eyebrow">Pipeline step</div><h3>${esc(first(r.item.about)||r.id)}</h3>${box2('Order','<p>Steps run in the order <code>scripts/rebuild_artifacts.sh</code> lists them; CI runs the same file. A gate step fails the build instead of writing an artifact.</p>')}${contract([['script',r.item.script],['rebuild line',`scripts/rebuild_artifacts.sh:${r.item.shLine}`],['writes',r.item.outputs]])}${gen}<div class="sources">${src(r.item.script,0,'Read the script')}</div>`;
  if(r.kind==='container'){const out=links.filter(l=>l.from===r.id),inn=links.filter(l=>l.to===r.id);return `<div class="eyebrow">${esc(r.item.kind)}</div><h3>${esc(r.item.title)}</h3>${box2('What it is',`<p>${esc(r.item.about)}</p>`)}${contract([['entrypoint',r.item.file],['references out',out.map(l=>`${l.kind} → ${l.to} (${l.count})`)],['references in',inn.map(l=>`${l.from} → ${l.kind} (${l.count})`)]])}${gen}`;}
 }
 const leaf=r=>['op','file','table','machine','page','event','step'].includes(r.kind);
 return {resolve,crumbs,title,scope,flow,inspector,leaf};
}

// Overview: a container diagram. Edges come from `links` in system.json (each a
// static reference: an import, a table name, a workflow step); the few that only
// a header or the spec states are labeled as such.
export function overviewFlow(sys,eng=false){
 const {containers,links,operations,workflows}=sys,box=Object.fromEntries(containers.map(c=>[c.id,c]));
 const C=(id,extra={})=>{const c=box[id];return {id:'k:'+id,kind:c.kind,title:c.title,sub:c.about.length>110?first(c.about):c.about,href:c.href,tone:id==='postgres'?'store':id==='blnk'?'external':'',tech:c.file||'',...extra};};
 const count=a=>Object.values(operations).filter(o=>o.audience===a).length;
 const label={imports:'imports',tables:'reads/writes',calls:'HTTPS calls',ui:'GET via read-only proxy',runs:'runs'};
 const edges=links.filter(l=>!l.from.startsWith('ci:')).map(l=>({from:'k:'+l.from,to:'k:'+l.to,label:l.kind==='tables'?plural(l.count,'table'):l.kind==='ui'?`${l.count} GETs via read-only proxy`:label[l.kind],tech:`${l.kind} × ${l.count}`,style:l.kind==='imports'&&l.to==='api'?'dashed':'solid'}));
 const ci=[...new Set(links.filter(l=>l.from.startsWith('ci:')).map(l=>l.from))];
 return diagram({label:'Cassandra container diagram',rows:[
  [{label:'People',nodes:[{id:'staff',tone:'person',kind:'Person',title:'Credit-union staff',sub:`${count('internal')} internal operations`},{id:'officer',tone:'person',kind:'Person',title:'Compliance officer / examiner',sub:'reviews controls and evidence'},{id:'partner',tone:'person',kind:'Person',title:'Partner fintech',sub:`${count('partner')} partner operations`}]}],
  [{label:'Vercel',nodes:[C('ui')]},{label:'Supabase · the API',nodes:[C('api')]}],
  [{label:'Supabase · supporting edge functions',nodes:['aggregator','drill','blnk-webhook','blnk-reconcile'].map(id=>C(id))}],
  [{nodes:[C('_shared')]}],
  [{label:'Data',nodes:[C('postgres')]},{label:'External',nodes:[C('blnk')]},{label:'Scheduled analytics',nodes:[C('analytics')]}],
  [{label:'Design time · repository and CI',nodes:[C('policy'),C('pipeline'),{id:'ci',kind:'GitHub Actions',title:`${plural(Object.keys(workflows).length,'workflow')}`,sub:'build, test, rebuild artifacts, schedule reporters',href:'#/pipeline',tech:ci.map(c=>c.slice(3)).join(', ')}]}],
 ],edges:[
  {from:'staff',to:'k:ui',label:'uses'},{from:'officer',to:'k:ui',label:'reviews'},{from:'partner',to:'k:api',label:'Bearer token, instance-scoped'},
  ...edges,
  {from:'k:blnk',to:'k:blnk-webhook',label:'ledger webhooks · per its header',style:'dashed'},
  {from:'k:policy',to:'k:pipeline',label:'extracted into the catalogue',style:'dotted'},{from:'k:pipeline',to:'k:api',label:'generates routes.gen.ts',style:'dotted'},{from:'k:pipeline',to:'k:ui',label:'generates the proxy allowlist',style:'dotted'},
  {from:'ci',to:'k:analytics',label:'schedules the reporters',style:'dashed'},{from:'ci',to:'k:drill',label:'runs the live tier',style:'dashed'},
 ]},eng);
}
// Core API: a component diagram, from audiences to the router, authentication,
// domains, the shared platform modules they import, and what they store.
export function apiFlow(sys,traced,eng=false){
 const {domains,modules,operations,counts,links}=sys,domainOf=Object.fromEntries(domains.flatMap(d=>d.modules.map(m=>[m,d])));
 const count=a=>Object.values(operations).filter(o=>o.audience===a).length;
 const business=domains.filter(d=>d.id!=='platform');
 const shared=domains.find(d=>d.id==='platform').modules.filter(m=>!['index','auth','test_helpers'].includes(m)&&Object.values(modules).filter(x=>x.imports.includes(m)).length>=3);
 const hand=Object.values(operations).filter(o=>o.route==='hand').length;
 const D=d=>({id:'d:'+d.id,kind:'Domain',title:d.title,sub:`${plural(d.modules.length,'module')} · ${plural(d.modules.reduce((n,m)=>n+modules[m].ops.length,0),'operation')}`,href:'#/domain/'+d.id,tech:d.modules.join(', ')});
 const M=m=>({id:'m:'+m,kind:'Shared module',title:m+'.ts',sub:`imported by ${plural(Object.values(modules).filter(x=>x.imports.includes(m)).length,'module')}`,href:'#/module/'+m,tech:modules[m].file});
 const uses=(d,m)=>d.modules.some(x=>modules[x].imports.includes(m));
 const pg=links.find(l=>l.from==='api'&&l.to==='postgres');
 return diagram({label:'Core API component diagram',rows:[
  [{label:'Callers, by the spec\'s x-audience',nodes:[{id:'a:partner',tone:'person',kind:'Partner fintechs',title:`${count('partner')} partner operations`},{id:'a:internal',tone:'person',kind:'Staff and the console proxy',title:`${count('internal')} internal operations`},{id:'a:public',tone:'person',kind:'Anyone',title:`${count('public')} public operations`}]}],
  [{nodes:[{id:'router',kind:'Router · index.ts',title:'Match the route',sub:`${counts.operations} operations · ${counts.operations-hand} generated in routes.gen.ts, ${hand} hand-written`,href:'#/module/index',tech:'core/supabase/functions/api/index.ts · routes.gen.ts'}]}],
  [{nodes:[{id:'auth',kind:'auth.ts',title:'Authenticate',sub:'resolve the actor; apply x-actors gates',href:'#/module/auth',tech:modules.auth.file}]}],
  [{label:'Domain handlers',nodes:business.map(D)}],
  [{label:'Shared platform modules',nodes:shared.map(M)},{label:'The rest of the platform',nodes:[D(domains.find(d=>d.id==='platform'))]}],
  [{label:'Stores and side effects',nodes:[{id:'pg',kind:'Supabase Postgres',title:'Postgres',sub:pg?plural(pg.count,'table')+' referenced':'',href:'#/container/postgres',tone:'store'},{id:'sh',kind:'Imported',title:'Shared Blnk client',sub:'→ Blnk ledger',href:'#/container/_shared'},{id:'agg',kind:'Edge function',title:'Aggregator',sub:'receives the signed event outbox',href:'#/container/aggregator'}]}],
 ],edges:[
  {from:'a:partner',to:'router',label:'HTTPS'},{from:'a:internal',to:'router'},{from:'a:public',to:'router'},
  {from:'router',to:'auth',label:'non-public routes'},{from:'router',to:'g:Domain handlers',label:'public routes skip auth',style:'dashed'},
  ...business.filter(d=>d.modules.some(m=>modules[m].ops.length)).map(d=>({from:'auth',to:'d:'+d.id,label:'dispatches'})),
  {from:'router',to:'d:platform',label:'platform routes',style:'dashed'},
  ...business.flatMap(d=>shared.filter(m=>uses(d,m)).map(m=>({from:'d:'+d.id,to:'m:'+m,label:'imports'}))),
  ...shared.filter(m=>modules[m].tables.length).map(m=>({from:'m:'+m,to:'pg',label:'reads/writes'})),
  ...business.filter(d=>d.modules.some(m=>modules[m].tables.length)).map(d=>({from:'d:'+d.id,to:'pg',label:'reads/writes'})),
  ...['lib','events','accounts','transfers'].filter(m=>modules[m]?.crossImports.some(x=>x.startsWith('_shared/'))).map(m=>({from:shared.includes(m)?'m:'+m:'d:'+domainOf[m].id,to:'sh',label:'imports'})),
  ...(modules.events?.crossImports.some(x=>x.startsWith('aggregator/'))?[{from:shared.includes('events')?'m:events':'d:platform',to:'agg',label:'signs and pushes',tech:'imports aggregator/auth.ts'}]:[]),
 ]},eng)+`<div class="enclosure traced"><div class="boundarylabel">MANUALLY TRACED SLICES · READ FROM SOURCE AT ONE REVISION</div>${traced}</div>`;
}
// The pipeline: the 19 rebuild steps in run order, the artifacts each writes,
// and the CI workflows that run the rebuild or its scripts.
export function pipelineFlow(sys,eng=false){
 const {steps,workflows}=sys;
 const S=s=>({id:'st:'+s.script,kind:s.gate?'Gate · fails the build':'Derivation',title:s.script.split('/').pop(),sub:s.outputs.length?'→ '+s.outputs.join(', '):s.note||first(s.about),href:'#/step/'+enc(s.script),tone:s.gate?'decision':'',tech:`rebuild_artifacts.sh:${s.shLine}`});
 const inner=[];for(let i=0;i<steps.length;i+=3)inner.push([{nodes:steps.slice(i,i+3).map(S)}]);const rows=[{frame:'scripts/rebuild_artifacts.sh · in run order',rows:inner}];
 const wf=Object.keys(workflows).filter(w=>workflows[w].runs.some(r=>r==='scripts/rebuild_artifacts.sh'||steps.some(s=>s.script===r)));
 return diagram({label:'Specification pipeline',rows:[
  [{nodes:[{id:'spec',tone:'port',title:'core/core-api.yaml',sub:'the canonical spec'},{id:'pol',tone:'port',title:'compliance/policies',sub:'the policy text',href:'#/policy'}]}],
  ...rows,
  [{nodes:[{id:'out',tone:'port',title:'Routes, catalogues, crosswalks, STATE.md and this map',sub:'or a red gate'}]}],
  [{label:'CI workflows that run the rebuild or its scripts',nodes:wf.map(w=>({id:'w:'+w,kind:'CI workflow',title:workflows[w].name,sub:'on '+workflows[w].triggers.join(', '),href:repo+workflows[w].file,external:true,tech:workflows[w].file}))}],
 ],edges:[{from:'spec',to:'st:'+steps[0].script,label:'read by'},{from:'pol',to:'st:'+steps[0].script},
  ...steps.slice(1).map((s,i)=>({from:'st:'+steps[i].script,to:'st:'+s.script,label:steps[i].gate?'passes':''})),
  {from:'st:'+steps.at(-1).script,to:'out'},
  ...wf.flatMap(w=>workflows[w].runs.includes('scripts/rebuild_artifacts.sh')?[{from:'w:'+w,to:'st:'+steps[0].script,label:'runs the whole rebuild',style:'dashed'}]:steps.filter(s=>workflows[w].runs.includes(s.script)).map(s=>({from:'w:'+w,to:'st:'+s.script,label:'runs',style:'dashed'})))]},eng);
}
