// The generated layer: every container, module, operation, policy and control,
// rendered from system.json (scripts/gen_architecture.py). Facts here are
// derived, not interpreted; the hand-traced BSA-06 slice lives in explorer.mjs.
const repo='https://github.com/Cassandra-Labs-Foundation/cassandra-platform/blob/main/';
export const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const src=(path,line,label)=>`<a href="${repo+path}${line?'#L'+line:''}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>`;
const plural=(n,w)=>`${n} ${w}${n===1?'':'s'}`;
const first=s=>{const m=String(s||'').match(/^.*?[.!?](\s|$)/);return (m?m[0]:String(s||'')).trim().slice(0,180);};
const status=s=>s?`<span class="badge ${s==='green'?'ok':s==='red'?'bad':''}">${esc(s)}</span>`:'<span class="badge">not run</span>';
const card=(href,kind,title,sub,inside='Open ↘',extra='')=>`<a class="node container-node" href="${esc(href)}"><span class="kind">${esc(kind)}</span><strong>${esc(title)}</strong><span class="sub">${sub}</span>${extra}<span class="inside">${inside}</span></a>`;
const grid=items=>`<div class="grid">${items.join('')}</div>`;
const section=(label,body)=>`<div class="subsection"><div class="boundarylabel">${esc(label)}</div>${body}</div>`;
const chips=list=>list.length?`<div class="chips">${list.map(x=>`<code>${esc(x)}</code>`).join('')}</div>`:'<p class="muted">None.</p>';
const verdict=v=>esc(String(v).replace(/_/g,' '));
const opHref=key=>'#/op/'+encodeURIComponent(key);
const views=new Set(['domain','module','op','policy','control','container']);

export function inventory(sys){
 const {containers,domains,modules,operations,policies,controls,machines,pages,counts}=sys;
 const domainOf=Object.fromEntries(domains.flatMap(d=>d.modules.map(m=>[m,d])));
 const policyRow=id=>{const cs=policies[id].controls.map(u=>controls[u]);const inScope=cs.filter(c=>c.scope==='in');return {cs,inScope,green:inScope.filter(c=>c.hermetic==='green'&&c.live==='green').length};};
 const modLink=m=>`<a class="pill" href="#/module/${esc(m)}">${esc(m)}.ts</a>`;
 const ctlCard=u=>{const c=controls[u];return card('#/control/'+u,`Control · ${c.id}`,c.title,`${c.scope==='in'?'In scope':'Scoped out'} · ${plural(c.modules.length,'module')}`,'Open control ↘',c.scope==='in'?`<span class="badges">Hermetic ${status(c.hermetic)} Live ${status(c.live)}</span>`:'<span class="badges">Discharged by people and paperwork · not claimed</span>');};
 const opCard=k=>{const o=operations[k];return card(opHref(k),`${o.audience} · ${o.tier}`,`${o.method} ${o.path}`,esc(o.summary||o.handler),'Open operation ↘');};

 // Which generated view a state shows, or null when the state is a hand view.
 function resolve(state){
  if(state.view==='policy'&&!state.id)return {kind:'policies'};
  if(!views.has(state.view))return null;
  const id=state.id;
  const found={domain:domains.find(d=>d.id===id),module:modules[id],op:operations[id],policy:policies[id],control:controls[id],container:containers.find(c=>c.href==='#/container/'+id)}[state.view];
  return found?{kind:state.view,id,item:found}:null;
 }
 function crumbs(r){
  const out=[['#/overview','Architecture']];
  if(r.kind==='policies'||r.kind==='policy'||r.kind==='control')out.push(['#/policy','Policies & controls']);
  if(r.kind==='policy')out.push(['#/policy/'+r.id,policies[r.id].title]);
  if(r.kind==='control'){const c=r.item;out.push(['#/policy/'+c.policy,policies[c.policy].title],['#/control/'+r.id,c.id]);}
  if(['domain','module','op'].includes(r.kind))out.push(['#/api','Core API']);
  const mod=r.kind==='module'?r.id:r.kind==='op'?r.item.module:null;
  if(r.kind==='domain')out.push(['#/domain/'+r.id,r.item.title]);
  if(mod){const d=domainOf[mod];out.push(['#/domain/'+d.id,d.title],['#/module/'+mod,mod+'.ts']);}
  if(r.kind==='op')out.push([opHref(r.id),`${r.item.method} ${r.item.path}`]);
  if(r.kind==='container')out.push(['#/container/'+r.id,r.item.title]);
  return out;
 }
 function title(r){return {policies:'Policies & controls',domain:r.item?.title,module:r.id+'.ts',op:r.item&&`${r.item.method} ${r.item.path}`,policy:r.item?.title,control:r.item?.title,container:r.item?.title}[r.kind];}
 function scope(r){
  if(r.kind==='policies')return `${plural(counts.policies,'policy')} → ${plural(counts.controls,'control')} · generated from the catalogue`;
  if(r.kind==='domain')return `Domain → ${plural(r.item.modules.length,'module')} · a reading boundary, not a deployment`;
  if(r.kind==='module')return `Module → ${plural(r.item.ops.length,'operation')} · ${plural(r.item.events.length,'event')} · ${plural(r.item.controls.length,'control')}${r.item.gate.length?' · '+plural(r.item.gate.length,'gate control'):''}`;
  if(r.kind==='op')return 'Operation → handler, access and evidence';
  if(r.kind==='policy')return `Policy → ${plural(r.item.controls.length,'control')}`;
  if(r.kind==='control')return 'Control → triggering and produced events → modules that emit them';
  return 'Deployable or dependency';
 }
 function flow(r){
  if(r.kind==='policies')return `<div class="enclosure"><div class="boundarylabel">COMPLIANCE CATALOGUE · ${counts.policies} POLICIES</div>${grid(Object.keys(policies).map(id=>{const p=policyRow(id);return card('#/policy/'+id,'Policy',policies[id].title,`${plural(p.cs.length,'control')} · ${p.inScope.length} in scope · ${p.green} green in both tiers`,'Open policy ↘');}))}</div>`;
  if(r.kind==='domain')return `<div class="enclosure"><div class="boundarylabel">${esc(r.item.title.toUpperCase())}</div>${grid(r.item.modules.map(m=>{const x=modules[m];return card('#/module/'+m,`Module · ${x.lines} lines`,m+'.ts',`${plural(x.ops.length,'operation')} · ${plural(x.events.length,'event')} · ${plural(x.controls.length,'control')}`,'Open module ↘');}))}</div>`;
  if(r.kind==='module'){const x=r.item;
   const byAudience=['partner','internal','public'].map(a=>[a,x.ops.filter(k=>operations[k].audience===a)]).filter(([,l])=>l.length);
   return `<div class="enclosure"><div class="boundarylabel">${esc(x.file)}</div>${byAudience.length?byAudience.map(([a,l])=>section(`${a} operations · ${l.length}`,grid(l.map(opCard)))).join(''):'<p class="muted">No routed operations: this module is called by other modules, not by the router.</p>'}${x.gate.length?section(`Gate controls implemented here · ${x.gate.length} · reviewed crosswalk claims`,x.gate.map(g=>`<div class="mechanic"><span class="kind">${esc(g.id)}</span><span class="sub">${esc(g.behaviour)}</span><span class="sub">${g.claims.map(([u,v])=>u?`<a href="#/control/${esc(u)}">${esc(controls[u].id)}</a> ${verdict(v)}`:verdict(v)).join(' · ')}</span></div>`).join('')):''}${section(`Controls whose events this module emits · ${x.controls.length}`,x.controls.length?grid(x.controls.map(ctlCard)):'<p class="muted">None.</p>')}${section(`Event codes emitted · ${x.events.length}`,chips(x.events))}${section('Calls into',x.imports.length?x.imports.map(modLink).join(' '):'<p class="muted">No other api/ module.</p>')}${section('Called by',x.importedBy.length?x.importedBy.map(modLink).join(' '):'<p class="muted">No other api/ module.</p>')}</div>`;}
  if(r.kind==='op'){const o=r.item;
   const steps=[['Route',`${o.route==='hand'?'Hand-written entry in index.ts':'Generated entry in routes.gen.ts'} · <code>${esc(o.operationId)}</code>`],['Access',`Audience <b>${esc(o.audience)}</b> · tier <b>${esc(o.tier)}</b>${o.actors.length?' · actors '+o.actors.map(esc).join(', '):''}${o.audience==='public'?' · dispatched without authentication':''}`],['Handler',`<code>${esc(o.handler)}</code> in ${modLink(o.module)}`],['Live flows that call this path',o.flows.length?o.flows.map(f=>`<code>${esc(f)}.test.ts</code>`).join(' '):'None found: no live flow references this path']];
   return `<div class="enclosure"><div class="boundarylabel">CORE API · ${esc(o.method)} ${esc(o.path)}</div>${steps.map(([t,s])=>`<div class="mechanic"><span class="kind">Derived from the spec</span><strong>${t}</strong><span class="sub">${s}</span></div>`).join('<div class="depthedge"><span></span><span aria-hidden="true">↓</span></div>')}</div><div class="leafsource">${src('core/core-api.yaml',o.specLine,'Read the operation in the spec')}${src(modules[o.module].file,o.handlerLine,'Read the handler')}</div>`;}
  if(r.kind==='policy')return `<div class="enclosure"><div class="boundarylabel">${esc(r.item.title.toUpperCase())}</div>${grid(r.item.controls.map(ctlCard))}</div>`;
  if(r.kind==='control'){const c=r.item;
   const ev=(label,list)=>section(label,list.length?list.map(([code,ms])=>`<div class="eventrow"><code>${esc(code)}</code><span>${ms.length?'emitted by '+ms.map(modLink).join(' '):'<span class="muted">no routed emitter</span>'}</span></div>`).join(''):'<p class="muted">None declared.</p>');
   return `<div class="enclosure"><div class="boundarylabel">${esc(c.id)} · ${esc(policies[c.policy].title)}</div>${ev('Triggering events',c.triggers)}${ev('Produced events',c.produced)}${c.gate.length?section('Gate controls claimed to discharge it · reviewed crosswalk',c.gate.map(([g,m,v])=>`<div class="eventrow"><code>${esc(g)}</code><span>${verdict(v)} · in ${modLink(m)}</span></div>`).join('')):''}${section('Modules that emit its events',c.modules.length?c.modules.map(modLink).join(' '):'<p class="muted">No api/ module emits this control\'s events.</p>')}${c.traced?card('#/control','Manually traced','Open the traced implementation path','Payment gate → alert triage → SAR decision, read from source','Open traced path ↘'):''}</div>`;}
  if(r.kind==='container'){const c=r.item;
   if(r.id==='postgres')return `<div class="enclosure"><div class="boundarylabel">CORE SCHEMA · DECLARED STATE MACHINES</div>${grid(Object.entries(machines).map(([n,s])=>`<div class="node"><span class="kind">State machine</span><strong>${esc(n)}</strong><span class="sub">${(Array.isArray(s)?s:Object.keys(s)).map(esc).join(' → ')}</span></div>`))}</div>`;
   if(r.id==='ui')return `<div class="enclosure"><div class="boundarylabel">UI/SRC/PAGES</div>${chips(pages)}${section('Core operations the console may read',grid(Object.keys(operations).filter(k=>operations[k].ui).map(opCard)))}</div>`;
   return `<div class="enclosure"><div class="boundarylabel">${esc(c.title.toUpperCase())}</div><div class="mechanic"><span class="kind">${esc(c.kind)}</span><strong>${esc(c.title)}</strong><span class="sub">${esc(c.about)}</span></div></div>${c.file?`<div class="leafsource">${src(c.file,1,'Read the entrypoint')}</div>`:''}`;}
 }
 function inspector(r){
  const box=(eyebrow,body,cls='section')=>`<div class="${cls}"><div class="eyebrow">${eyebrow}</div>${body}</div>`;
  const gen=box('How this view is made','<p>Generated from the spec, the control catalogue, test results and source by <code>scripts/gen_architecture.py</code>. Complete by construction; a relationship shown here is a static reference, not proof of behaviour.</p>','check');
  if(r.kind==='policies')return `<div class="eyebrow">Compliance catalogue</div><h3>Every policy and control the institution has written</h3>${box('Status columns','<p><b>Hermetic</b> runs each control against a fake database; <b>Live</b> runs it against the real core. Scoped-out controls are discharged by people and paperwork and are not claimed.</p>')}${gen}`;
  if(r.kind==='domain')return `<div class="eyebrow">Domain</div><h3>${esc(r.item.about)}</h3>${box('Boundary','<p>Every module here ships inside the one <code>api</code> edge function. The grouping is for reading.</p>')}${gen}`;
  if(r.kind==='module'){const x=r.item;return `<div class="eyebrow">Module purpose · from its source header</div><h3>${esc(first(x.about)||`${x.file.split('/').pop()} has no header comment; its exports are below`)}</h3>${x.about?box('Header',`<p>${esc(x.about)}</p>`):''}${box('Exported functions',chips(x.exports))}${box('Live flows that call its paths',chips(x.flows.map(f=>f+'.test.ts')))}${gen}<div class="sources">${src(x.file,1,`Read ${x.file.split('/').pop()} · ${x.lines} lines`)}</div>`;}
  if(r.kind==='op'){const o=r.item;return `<div class="eyebrow">Operation</div><h3>${esc(o.summary||o.handler)}</h3>${box('Contract',`<p>Handler <code>${esc(o.handler)}</code>. Audience ${esc(o.audience)}, tier ${esc(o.tier)}${o.actors.length?', actors '+o.actors.map(esc).join(', '):''}. ${o.ui?'Readable by the staff console.':''}</p>`)}${box('Evidence',`<p>${o.flows.length?'Referenced by live flows: '+o.flows.map(f=>esc(f)+'.test.ts').join(', ')+'.':'No live flow references this path.'} A reference is not a test run.</p>`,'check')}<div class="sources">${src('core/core-api.yaml',o.specLine,'Spec')}${src(modules[o.module].file,o.handlerLine,'Handler')}</div>`;}
  if(r.kind==='policy'){const p=policyRow(r.id);return `<div class="eyebrow">Policy</div><h3>${esc(r.item.title)}</h3>${box('Coverage',`<p>${plural(p.cs.length,'control')}; ${p.inScope.length} in scope, ${p.green} green in both the hermetic and live tiers.</p>`)}${gen}<div class="sources">${src(r.item.file,1,'Read the policy')}</div>`;}
  if(r.kind==='control'){const c=r.item;return `<div class="eyebrow">Control · ${esc(c.id)}</div><h3>${esc(c.title)}</h3>${box('System behaviour · from the policy',`<p>${esc(c.behavior)}</p>`)}${box('Evidence',`<p>${c.scope==='in'?'In scope':'Scoped out'} · ${esc(c.scopeWhy)}</p><p>Hermetic ${status(c.hermetic)} · Live ${status(c.live)} · reachability ${esc(c.reachability||'not computed')}${c.blockedOn?' · blocked on '+esc(JSON.stringify(c.blockedOn)):''}</p>`,'check')}${c.citations.length?box('Regulatory citations',chips(c.citations)):''}<div class="sources">${src(policies[c.policy].file,c.policyLine,`Policy ${c.id}`)}</div>`;}
  if(r.kind==='container')return `<div class="eyebrow">${esc(r.item.kind)}</div><h3>${esc(r.item.title)}</h3>${box('What it is',`<p>${esc(r.item.about)}</p>`)}${gen}`;
 }
 const leaf=r=>r.kind==='op';
 return {resolve,crumbs,title,scope,flow,inspector,leaf};
}

// Overview and Core API: the generated containers and domains, with the
// hand-traced slices kept as an explicitly labelled section.
export function overviewFlow(sys){
 return `<div class="enclosure"><div class="boundarylabel">CASSANDRA · RUNTIME CONTAINERS AND THE CATALOGUE THEY ANSWER TO</div>${grid(sys.containers.map(c=>card(c.href,c.kind,c.title,esc(c.about.length>140?first(c.about):c.about))))}</div><p class="context-note">Relationships: the staff console reads the Core API through a read-only proxy. The Core API writes Postgres and posts money movements to Blnk; the Blnk webhook and reconciler mirror the ledger back into Postgres. Policies and controls describe what the Core API must do; the specification pipeline derives routes, catalogues and this map.</p>`;
}
export function apiFlow(sys,traced){
 const {domains,modules,counts}=sys;
 return `<div class="enclosure"><div class="boundarylabel">CORE API · ONE EDGE FUNCTION · ${counts.operations} operations · ${counts.modules} modules</div>${grid(domains.map(d=>card('#/domain/'+d.id,'Domain',d.title,`${plural(d.modules.length,'module')} · ${plural(d.modules.reduce((n,m)=>n+modules[m].ops.length,0),'operation')}`,'Open domain ↘')))}</div><div class="enclosure traced"><div class="boundarylabel">MANUALLY TRACED SLICES · READ FROM SOURCE AT ONE REVISION</div>${traced}</div>`;
}
