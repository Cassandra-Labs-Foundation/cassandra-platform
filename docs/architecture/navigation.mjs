const topViews=new Set(['overview','api','routing','rails','pipeline','policy','control']);
const groups=new Set(['detect','triage','decide']);
const nodeParents={velocity:'detect',threshold:'detect',blocked:'detect',alert:'detect',skip:'detect',access:'triage',triage:'triage',resolve:'triage',case:'triage',officer:'decide',decision:'decide',file:'decide',nofile:'decide'};
export function decodeRoute(hash){
  const [path,id]=hash.replace(/^#\/?/,'').split('/');
  const alias={containers:'overview',components:'api',walkthroughs:'control'};
  if(alias[path])return {view:alias[path],group:null,node:null};
  if(path==='process'&&groups.has(id))return {view:'group',group:id,node:null};
  if(path==='implementation'&&nodeParents[id])return {view:'node',group:nodeParents[id],node:id};
  return {view:topViews.has(path)?path:'overview',group:null,node:null};
}
