const topViews=new Set(['overview','api','routing','rails','pipeline','policy','control']);
const groups=new Set(['detect','triage','decide']);
const nodeParents={velocity:'detect',threshold:'detect',blocked:'detect',alert:'detect',skip:'detect',access:'triage',triage:'triage',resolve:'triage',case:'triage',officer:'decide',decision:'decide',file:'decide',nofile:'decide'};
// Generated views take one id; whether it exists is checked against system.json by the explorer.
const generated=new Set(['domain','module','op','policy','control','container','file','table','machine','page','event','step']);
const safeId=/^[\w .:/{}[\]@-]{1,200}$/;
export function decodeRoute(hash){
  const raw=hash.replace(/^#\/?/,'');
  const cut=raw.indexOf('/');
  const path=cut<0?raw:raw.slice(0,cut);
  let id=cut<0?undefined:raw.slice(cut+1);
  try{id=id===undefined?undefined:decodeURIComponent(id);}catch{return {view:'overview',group:null,node:null,id:null};}
  const alias={containers:'overview',components:'api',walkthroughs:'control'};
  if(alias[path])return {view:alias[path],group:null,node:null,id:null};
  if(path==='process'&&groups.has(id))return {view:'group',group:id,node:null,id:null};
  if(path==='implementation'&&nodeParents[id])return {view:'node',group:nodeParents[id],node:id,id:null};
  if(generated.has(path)&&id&&safeId.test(id))return {view:path,group:null,node:null,id};
  return {view:topViews.has(path)&&id===undefined?path:'overview',group:null,node:null,id:null};
}
