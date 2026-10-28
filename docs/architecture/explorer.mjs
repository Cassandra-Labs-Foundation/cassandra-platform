import {decodeRoute} from './navigation.mjs';
import {inventory,overviewFlow,apiFlow,pipelineFlow} from './inventory.mjs';
import {diagram,drawDiagrams} from './diagram.mjs';
const root=document.getElementById('control-atlas');
let model,sys,stale=null;
try{
  const responses=await Promise.all(['./model.json','./system.json'].map(file=>fetch(file)));
  if(responses.some(response=>!response.ok))throw new Error('Unable to load the architecture model');
  [model,sys]=await Promise.all(responses.map(response=>response.json()));
}catch(error){
  root.querySelector('[data-flow]').textContent='The architecture model could not be loaded. Reload this page from the documentation site or a local HTTP server.';
  throw error;
}
const {nodes,groups,internals,snapshot}=model;
// Written by the Pages deploy when a hand-traced source changed after review.
fetch('./stale.json').then(r=>r.ok?r.json():null).then(s=>{if(s?.changed?.length){stale=s;render();}}).catch(()=>{});
function staleBar(traced){const el=root.querySelector('[data-stale]');el.hidden=!(traced&&stale);
 if(traced&&stale)el.innerHTML=`<b>The code behind this traced path changed after it was reviewed.</b> It was read at <code>${esc(stale.revision.slice(0,7))}</code>; since then ${stale.changed.map(f=>`<code>${esc(f.split('/').pop())}</code>`).join(', ')} changed, so its claims may be out of date until it is traced again. The generated inventory is current.`;}
// BSA-06's control page draws its traced processes inside the control's own box.
const inv=inventory(sys,{processes:['detect','triage','decide'].map(id=>({id,kind:'Process · traced by hand',title:groups[id].title,sub:groups[id].sub,tech:Object.keys(nodes).filter(n=>nodes[n].stage===id).join(' · ')})),
 edges:[{from:'detect',to:'triage',label:'open alert'},{from:'triage',to:'decide',label:'escalated investigation'}]});
const tracedControl=sys.controls[model.control];
const base='https://github.com/Cassandra-Labs-Foundation/cassandra-platform/blob/'+snapshot.revision+'/';
const bsa='core/supabase/functions/api/bsa.ts',transfers='core/supabase/functions/api/transfers.ts',policy='compliance/policies/bsa/bsa.md';
const api='core/supabase/functions/api/';
const views={
 overview:{title:'Backend core & controls',scope:'People → containers → what they call, store and derive',intro:'Every deployable, module, operation, policy and control, with one control traced by hand down to its decisions.',meaning:'The Core API serves authenticated domain operations and records state and evidence in Postgres. Money movements reach the Blnk ledger through the shared client; the webhook and reconciler mirror it back. Policies and specifications describe intended behavior; handlers implement it.',limit:'Two layers. The inventory is generated from the spec, catalogue, test results and source on every rebuild, so it is complete but only states declared facts and static references. The BSA-06 path is traced by hand at one revision and interprets behavior. Neither is a compliance assessment.',sources:[[api+'index.ts',514,'Core entry point'],[transfers,725,'Gate and ledger call']]},
 api:{title:'Core API',scope:'Callers → router → authentication → domains → shared modules → stores',intro:'Every routed operation, grouped by domain and module, plus the request path and payment gate traced by hand.',meaning:'index.ts combines hand-written routes with generatedRoutes. Non-public requests authenticate before dispatch to a domain handler. The BSA handlers and payment handlers are modules within this deployment, not separate services.',limit:'Domains are a reading boundary; every module ships in one edge function. Public routes are an explicit exception to authentication; domain handlers have additional role and ownership checks that the inventory does not show.',sources:[[api+'index.ts',490,'Route composition'],[api+'index.ts',570,'Public and authenticated dispatch']]},
 routing:{title:'Request routing & access',scope:'Inside the Core API request dispatcher · every refusal path',intro:'Route selection precedes authentication because authorization needs endpoint metadata.',meaning:'An unconfigured instance returns an error. Matching yields a route, 404 or 405. Public routes dispatch with a sentinel context. Other routes authenticate and then invoke the handler with the resulting actor context.',limit:'This view summarizes dispatch. It does not prove every handler enforces its business-level roles or ownership constraints.',sources:[[api+'index.ts',514,'Request dispatcher'],[api+'auth.ts',207,'Authentication']]},
 rails:{title:'Payment execution & controls',scope:'Payment call sites → shared gate → monitoring and ledger',intro:'Multiple payment handlers call the same gate, but that does not make every money operation the same path.',meaning:'Book transfers, ACH, wire preparation and card authorization call runGate from transfers.ts. In the reviewed book-transfer path, safe-mode refusal precedes the gate and a passing gate leads toward recordTransaction.',limit:'The gate has explicit checks, not a dynamic interpreter of the extracted control catalogue. CDA uses a separate evaluateFundingGate. Returns, replays and earlier validations need their own paths; this diagram does not claim universal gate coverage.',sources:[[transfers,85,'runGate implementation'],[transfers,700,'Book-transfer call site'],[api+'ach.ts',294,'ACH call site'],[api+'wires.ts',240,'Wire call site'],[api+'cards.ts',195,'Card call site'],[api+'cda.ts',1,'Separate CDA gate']]},
 pipeline:{title:'Specification & evidence',scope:'Development-time derivation · not runtime event flow',intro:'Distinguish intended design, generated inventories and behavioral evidence.',meaning:'The ordered rebuild derives vocabulary and control catalogues, crosswalks, routes and verifier artifacts, regenerates this explorer’s inventory, then runs consistency checks. The sequence is defined in scripts/rebuild_artifacts.sh.',limit:'Extraction and consistency checks do not prove policy-to-code semantic correctness. Test definitions are not executed test results. This architecture snapshot is manually traced; its fingerprint check detects changed sources but does not regenerate meaning.',sources:[['scripts/rebuild_artifacts.sh',1,'Ordered artifact rebuild'],[policy,153,'Authored policy requirement']]}
};
// The hand-traced views, drawn with the same diagram renderer as the inventory.
const at=(file,line)=>`${file.replace(api,'')}:${line}`;
const ext=(file,line)=>({href:base+file+'#L'+line,external:true});
function tracedSlices(eng){
 return diagram({label:'Manually traced slices',rows:[[{nodes:[
  {id:'routing',kind:'index.ts → auth.ts',title:'Request routing & access',sub:'Resolve route, authenticate, dispatch',open:{'data-open-view':'routing'},tone:'traced',tech:at(api+'index.ts',514)},
  {id:'rails',kind:'transfers.ts · ach.ts · wires.ts · cards.ts',title:'Payment execution & controls',sub:'Shared runGate calls and ledger handoff',open:{'data-open-view':'rails'},tone:'traced',tech:at(transfers,85)},
  {id:'control',kind:'bsa.ts',title:'BSA alert & case management',sub:'Open alerts, investigate and record SAR decisions',href:'#/control/'+encodeURIComponent(model.control),tone:'traced',tech:'BSA-06'}]}]],
  edges:[{from:'routing',to:'rails',label:'dispatches payment handlers'},{from:'rails',to:'control',label:'runGate calls raiseAlert'}]},eng);
}
function routingDiagram(eng){
 const step=(id,title,sub,file,line,tone='')=>({id,kind:'Step',title,sub,tone,tech:at(file,line),...ext(file,line)});
 const exit=(id,title,sub)=>({id,kind:'Refusal',title,sub,tone:'exit'});
 return diagram({label:'Request routing',rows:[
  [{nodes:[{id:'req',tone:'port',title:'An HTTPS request',sub:'any caller'}]}],
  [{nodes:[step('inst','Resolve the configured instance','INSTANCE_ID from the environment',api+'index.ts',521)]},{nodes:[exit('noinst','Refuse','instance not configured')]}],
  [{nodes:[step('match','Match path and method','route table: routes.gen.ts + hand routes',api+'index.ts',556)]},{nodes:[exit('404','404','unknown path'),exit('405','405','unsupported method')]}],
  [{nodes:[step('pub','Is the route public?','x-audience: public',api+'index.ts',573,'decision')]}],
  [{nodes:[step('sentinel','Call the handler with a sentinel context','no actor',api+'index.ts',575)]},{nodes:[step('auth','Authenticate the request','resolve the actor',api+'index.ts',584)]},{nodes:[exit('authfail','Return the failure response','authentication failed')]}],
  [{nodes:[step('call','Call the matched handler','with the actor context',api+'index.ts',600)]},{nodes:[{...exit('500','Internal-error response','the handler threw'),tech:at(api+'index.ts',606),...ext(api+'index.ts',606)}]}],
 ],edges:[{from:'req',to:'inst'},{from:'inst',to:'noinst',label:'missing INSTANCE_ID'},{from:'inst',to:'match',label:'configured'},{from:'match',to:'404',label:'unknown path'},{from:'match',to:'405',label:'wrong method'},{from:'match',to:'pub',label:'matched'},
  {from:'pub',to:'sentinel',label:'yes'},{from:'pub',to:'auth',label:'no'},{from:'auth',to:'authfail',label:'fails'},{from:'auth',to:'call',label:'actor context'},{from:'call',to:'500',label:'throws'}]},eng);
}
function railsDiagram(eng){
 const site=(id,title,file,line)=>({id,kind:'Call site',title,sub:file.split('/').pop(),tech:at(file,line),...ext(file,line)});
 return diagram({label:'Payment rails',rows:[
  [{label:'Payment handlers that call runGate',nodes:[site('book','Book transfer',transfers,725),site('ach','ACH',api+'ach.ts',294),site('wire','Wire preparation',api+'wires.ts',240),site('card','Card authorization',api+'cards.ts',195)]},{label:'A separate gate',nodes:[site('cda','CDA funding',api+'cda.ts',545)]}],
  [{nodes:[{id:'gate',kind:'Shared gate · transfers.ts',title:'runGate',sub:'explicit checks in order; not a catalogue interpreter',tone:'decision',tech:at(transfers,85),...ext(transfers,85)}]},{nodes:[{id:'cdagate',kind:'cda.ts',title:'evaluateFundingGate',sub:'its own checks',tone:'decision',tech:at(api+'cda.ts',545),...ext(api+'cda.ts',545)}]}],
  [{nodes:[{id:'detect',kind:'Process inside BSA-06',title:groups.detect.title,sub:groups.detect.sub,open:{'data-open-group':'detect'},tone:'traced',tech:'threshold · velocity · alert writer'}]},{nodes:[{id:'other',tone:'port',title:'Other gate checks',sub:'safe mode, funds, OFAC · outside this slice'}]}],
  [{nodes:[{id:'record',kind:'Book-transfer path · reviewed',title:'recordTransaction',sub:'a passing gate leads here',tech:at(transfers,734),...ext(transfers,734)}]}],
  [{nodes:[{id:'blnk',kind:'External ledger',title:'Blnk ledger',sub:'through the shared client',href:'#/container/blnk',tone:'external'}]}],
 ],edges:[...['book','ach','wire','card'].map(id=>({from:id,to:'gate',label:'calls'})),{from:'cda',to:'cdagate',label:'calls'},{from:'gate',to:'detect',label:'large movement'},{from:'gate',to:'other'},{from:'gate',to:'record',label:'passes · book transfer'},{from:'record',to:'blnk',label:'posts the movement'}]},eng);
}
const block=(id,current)=>{const n=nodes[id];return {id,kind:n.kind,title:n.title,sub:n.sub,tech:n.tech,open:{'data-open-node':id},tone:[['Rule','Human decision'].includes(n.kind)?'decision':'',n.kind==='Exit'?'exit':'',id===current?'current':''].filter(Boolean).join(' ')};};
// `out` names the nodes that produce the process's declared output; the rest are terminal.
const shapes={
 detect:{rows:[['velocity'],['blocked','threshold'],['alert','skip']],out:['alert'],edges:[['velocity','blocked','No · over the cap'],['velocity','threshold','Yes · continue'],['threshold','alert','Yes · above $10,000'],['threshold','skip','No · at or below']]},
 triage:{rows:[['access'],['triage'],['resolve','case']],out:['resolve','case'],edges:[['access','triage','Authorized, untriaged alert'],['triage','resolve','No · resolve'],['triage','case','Yes · escalate']]},
 decide:{rows:[['officer'],['decision'],['file','nofile']],out:['file','nofile'],edges:[['officer','decision','Authorized, eligible case'],['decision','file','File'],['decision','nofile','Do not file']]},
};
function groupDiagram(gid,current,eng){const s=shapes[gid];
 return diagram({label:groups[gid].title,rows:[[{nodes:[{id:'in',tone:'port',title:'Input · '+groups[gid].input}]}],{frame:groups[gid].title,rows:s.rows.map(row=>[{nodes:row.map(id=>block(id,current))}])},[{nodes:[{id:'out',tone:'port',title:'Output · '+groups[gid].output}]}]],
  edges:[{from:'in',to:s.rows[0][0]},...s.edges.map(([a,b,label])=>({from:a,to:b,label})),...s.out.map(id=>({from:id,to:'out'}))]},eng);
}
function nodeDiagram(id,eng){const n=nodes[id],steps=internals[id];
 return diagram({label:n.title,rows:[[{nodes:[{id:'parent',tone:'port',title:'Inside '+groups[n.stage].title,sub:'the enclosing process'}]}],{frame:n.tech,rows:steps.map(([name,detail],i)=>[{nodes:[{id:'i'+i,kind:'Implementation',title:name,sub:detail,tone:i===steps.length-1?'current':''}]}])},[{nodes:[{id:'src',kind:'Source',title:at(n.file,n.line),sub:'the code behind this boundary',tech:n.contract,...ext(n.file,n.line)}]}]],
  edges:[{from:'parent',to:'i0'},...steps.slice(1).map((_,i)=>({from:'i'+i,to:'i'+(i+1),label:'then'})),{from:'i'+(steps.length-1),to:'src',label:'implemented at',style:'dotted'}]},eng);
}
function renderViewInspector(view){const contract=state.engineering?`<div class="technical"><div class="eyebrow">Implementation contract</div><p>${view.sources.map(([f,l,t])=>`<b>${esc(t)}</b> <code>${esc(f)}:${l}</code>`).join('<br>')}</p></div>`:'';return `<h3>${view.intro}</h3><div class="section"><div class="eyebrow">Implementation</div><p>${view.meaning}</p></div><div class="check"><div class="eyebrow">Scope & review boundary</div><p>${view.limit}</p></div>${contract}<div class="sources">${view.sources.map(([file,line,title])=>link(file,line,title)).join('')}</div>`;}
let state={view:'overview',group:null,node:null,id:null,engineering:false};
function link(path,line,label){return `<a href="${base+path}#L${line}" target="_blank" rel="noopener noreferrer">${label} ↗</a>`;}
function crumb(view,title,current=false){return current?`<span aria-current="page">${title}</span>`:`<button data-up="${view}">${title}</button>`;}
function hrefCrumb(href,title,current=false){return current?`<span aria-current="page">${esc(title)}</span>`:`<button data-href="${esc(href)}">${esc(title)}</button>`;}
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const flowEl=root.querySelector('[data-flow]');
function paint(html){flowEl.innerHTML=html;drawDiagrams(flowEl);}
function renderGenerated(r){
 staleBar(r.kind==='control'&&r.id===model.control);
 const crumbs=inv.crumbs(r);
 root.querySelector('[data-title]').textContent=inv.title(r);
 root.querySelector('[data-scope]').textContent=inv.scope(r);
 root.querySelector('[data-breadcrumb]').innerHTML=crumbs.map(([href,title],i)=>hrefCrumb(href,title,i===crumbs.length-1)).join('<span class="crumbsep" aria-hidden="true">›</span>');
 root.querySelector('.maphead').hidden=!inv.leaf(r);
 paint(inv.flow(r,state.engineering));
 root.querySelector('[data-inspector]').innerHTML=inv.inspector(r,state.engineering);
}
function render(){
root.querySelector('[data-engineering]').checked=state.engineering;
const generated=inv.resolve(state);
if(generated)return renderGenerated(generated);
staleBar(['routing','rails','group','node'].includes(state.view));
if(state.view==='control'){location.replace('#/control/'+encodeURIComponent(model.control));return;}
if(state.id||state.view==='policy')state={...state,view:'overview',id:null};
const eng=state.engineering;
const isDeep=state.view==='group'||state.view==='node';
const current=state.view==='node'?nodes[state.node]:null;
const title=views[state.view]?.title || (state.view==='control'?'Transaction monitoring & case management':state.view==='group'?groups[state.group].title:current.title);
root.querySelector('[data-title]').textContent=title;
root.querySelector('[data-scope]').textContent=views[state.view]?.scope || (state.view==='control'?'BSA-06 → connected processes · one traced path':state.view==='group'?'Process → decisions and actions':'Decision or action → implementation mechanics');
let crumbs=[crumb('overview','Architecture',state.view==='overview')];
if(views[state.view]&&state.view!=='overview') { if(['routing','rails'].includes(state.view)) crumbs.push(crumb('api','Core API')); crumbs.push(crumb(state.view,title,true)); }
if(!views[state.view]) { crumbs.push(hrefCrumb('#/policy','Policies & controls'),hrefCrumb('#/policy/'+tracedControl.policy,sys.policies[tracedControl.policy].title),hrefCrumb('#/control/'+model.control,tracedControl.id)); if(isDeep)crumbs.push(crumb('group',groups[state.group].title,state.view==='group')); if(current)crumbs.push(crumb('node',current.title,true)); }
root.querySelector('[data-breadcrumb]').innerHTML=crumbs.join('<span class="crumbsep" aria-hidden="true">›</span>');
root.querySelector('.maphead').hidden=!current;
const flow={overview:()=>overviewFlow(sys,eng),api:()=>apiFlow(sys,tracedSlices(eng),eng),routing:()=>routingDiagram(eng),rails:()=>railsDiagram(eng),pipeline:()=>pipelineFlow(sys,eng),control:()=>tracedDiagram(eng),group:()=>groupDiagram(state.group,groups[state.group].selected,eng),node:()=>nodeDiagram(state.node,eng)}[state.view]();
paint(flow+(current?`<div class="leafsource">${link(current.file,current.line,'Read the source behind this boundary')}</div>`:''));
const n=current||(state.view==='group'?nodes[groups[state.group].selected]:null);
root.querySelector('[data-inspector]').innerHTML=views[state.view]?renderViewInspector(views[state.view]):n?`<div class="eyebrow">${current?'Implementation focus':'Process focus'}</div><h3>${current?n.title:groups[state.group].title}</h3><div class="section"><div class="eyebrow">Policy intent · interpreted</div><p>${n.intent}</p></div><div class="section"><div class="eyebrow">What the implementation does</div><p>${n.behavior}</p></div><div class="check"><div class="eyebrow">Boundary to examine</div><p>${n.boundary}</p></div>${eng?`<div class="technical"><div class="eyebrow">Implementation contract</div><p>${n.contract}</p></div>`:''}<div class="sources">${link(policy,153,'Policy BSA-06')}${link(n.file,n.line,'Implementation')}${link(n.test.includes('/')?n.test:'core/supabase/functions/api/'+n.test,n.testline,'Related test')}</div>`:`<div class="eyebrow">Control context</div><h3>From monitoring to a documented decision</h3><div class="section"><div class="eyebrow">Policy intent · interpreted</div><p>Review monitoring alerts within two business days. Escalate unresolved alerts into investigations, then reach a documented SAR or no-SAR decision.</p></div><div class="section"><div class="eyebrow">Implementation boundary</div><p>This path connects the Core API’s payment gate to its alert and case-management handlers.</p></div><div class="check"><div class="eyebrow">Scope</div><p>One large-movement path within BSA-06. Other detectors, external filing and Board reporting are outside this model.</p></div>${eng?`<div class="technical"><div class="eyebrow">Implementation contract</div><p>${Object.keys(nodes).map(k=>`<b>${esc(nodes[k].title)}</b> <code>${esc(at(nodes[k].file,nodes[k].line))}</code>`).join('<br>')}</p></div>`:''}<div class="section"><div class="eyebrow">Explore the structure</div><p>Open a process to reveal its decisions. Open a decision to reveal the checks and writes that implement it. Breadcrumbs return to the enclosing view.</p></div><div class="sources">${link(policy,153,'Policy BSA-06')}</div>`;
}
function save(){try {localStorage.setItem('cassandra-architecture-detail',String(state.engineering));}catch{} const hash=state.id?'#/'+state.view+'/'+encodeURIComponent(state.id):state.view==='node'?'#/implementation/'+state.node:state.view==='group'?'#/process/'+state.group:'#/'+state.view; if(location.hash!==hash) history.pushState(null,'',hash);}
root.addEventListener('click',event=>{const b=event.target.closest('button');if(!b||!root.contains(b))return;if(b.dataset.href){location.hash=b.dataset.href;return;}if(b.dataset.scroll){root.querySelector('[data-index]')?.scrollIntoView({block:'start'});return;}if(b.dataset.openView){state.view=b.dataset.openView;state.group=null;state.node=null;state.id=null;}else if(b.dataset.openGroup){state.view='group';state.group=b.dataset.openGroup;state.node=null;}else if(b.dataset.openNode){state.view='node';state.node=b.dataset.openNode;state.group=nodes[state.node].stage;}else if(b.dataset.up){state.view=b.dataset.up;state.id=null;if(state.view!=='node')state.node=null;if(!['group','node'].includes(state.view))state.group=null;}else return;render();save();const target=root.querySelector('[data-breadcrumb] [aria-current="page"]');target?.scrollIntoView?.({block:'nearest'});root.querySelector('[data-title]').focus({preventScroll:true});});
root.querySelector('[data-engineering]').addEventListener('change',event=>{state.engineering=event.target.checked;render();save();});
function route(){state={...state,...decodeRoute(location.hash)};render();}
try{state.engineering=localStorage.getItem('cassandra-architecture-detail')==='true';}catch{}
window.addEventListener('hashchange',route);window.addEventListener('popstate',route);
document.fonts?.ready.then(()=>drawDiagrams(flowEl));
root.querySelector('[data-title]').tabIndex=-1;
root.querySelector('[data-snapshot]').innerHTML='Inventory generated from the spec, catalogue and source · '+sys.counts.operations+' operations · '+sys.counts.controls+' controls<span>BSA-06 path manually traced · '+snapshot.reviewedAt+' · <a href="'+base+'" target="_blank" rel="noopener noreferrer">'+snapshot.revision.slice(0,7)+'</a> · linked tests are definitions, not run results</span>';
route();
