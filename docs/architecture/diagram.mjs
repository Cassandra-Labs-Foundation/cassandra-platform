// Flow diagrams: boxes laid out in rows, connected by drawn, labeled edges.
//
// diagram(spec, eng) returns HTML: rows of (optionally labeled) groups of
// nodes, plus the edge list as data. drawDiagrams(root) measures the laid-out
// boxes and draws every edge as an SVG path with an arrowhead and a label, so
// the picture follows the real layout at any width (and redraws on resize).
// Nodes are real links or buttons; edges are also listed as text for screen
// readers. Engineering detail adds each node's and edge's identifiers.
//
// spec = {rows: [[{label, tone, nodes: [node]}]], edges: [{from, to, label, tech, style}]}
// node = {id, title, kind, sub, tech, tone, href, external, open: {data-attr: value}, scroll}
// An edge endpoint may be a node id or a group id ("g:<label>" or the group's own id).
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let serial=0;

function nodeHtml(n,eng){
 const body=`${n.kind?`<span class="kind">${esc(n.kind)}</span>`:''}<strong>${esc(n.title)}</strong>${n.sub?`<span class="sub">${n.subHtml?n.sub:esc(n.sub)}</span>`:''}${eng&&n.tech?`<span class="tech">${esc(n.tech)}</span>`:''}`;
 const cls=`node dnode${n.tone?' '+n.tone.split(' ').map(t=>'t-'+t).join(' '):''}${n.href||n.open||n.scroll?' linked':''}`;
 const id=`data-dnode="${esc(n.id)}"`;
 if(n.href)return `<a class="${cls}" ${id} href="${esc(n.href)}"${n.external?' target="_blank" rel="noopener noreferrer"':''}>${body}${n.external?'<span class="inside">Read the source ↗</span>':''}</a>`;
 if(n.open)return `<button class="${cls}" ${id} ${Object.entries(n.open).map(([k,v])=>`${esc(k)}="${esc(v)}"`).join(' ')}>${body}</button>`;
 if(n.scroll)return `<button class="${cls}" ${id} data-scroll="index">${body}</button>`;
 return `<div class="${cls}" ${id}>${body}</div>`;
}

export function diagram(spec,eng=false){
 const ids=new Set();
 const rows=spec.rows.filter(row=>row.some(g=>g.nodes.length)).map(row=>`<div class="drow">${row.filter(g=>g.nodes.length).map(g=>{
  const gid=g.id||(g.label?'g:'+g.label:'');if(gid)ids.add(gid);g.nodes.forEach(n=>ids.add(n.id));
  return `<div class="dgroup${g.label?'':' plain'}${g.tone?' t-'+g.tone:''}"${gid?` data-dgroup="${esc(gid)}"`:''}>${g.label?`<span class="dglabel">${esc(g.label)}</span>`:''}${g.nodes.map(n=>nodeHtml(n,eng)).join('')}</div>`;}).join('')}</div>`).join('');
 const members={};spec.rows.forEach(row=>row.forEach(g=>{const gid=g.id||(g.label?'g:'+g.label:'');if(gid)members[gid]=g.nodes.filter(n=>n.tone!=='more').map(n=>n.id);}));
 const edges=bundle(spec.edges.filter(e=>ids.has(e.from)&&ids.has(e.to)&&e.from!==e.to),members).map(e=>({...e,label:[e.label,eng&&e.tech?e.tech:''].filter(Boolean).join(' · ')}));
 const name=id=>{for(const row of spec.rows)for(const g of row){if((g.id||(g.label?'g:'+g.label:''))===id)return g.label;const n=g.nodes.find(x=>x.id===id);if(n)return n.title;}return id;};
 return `<div class="diagram" data-diagram="${++serial}" data-edges="${esc(JSON.stringify(edges))}" role="group" aria-label="${esc(spec.label||'Flow diagram')}">${rows}<svg class="dedges" aria-hidden="true"></svg><ul class="dsr">${edges.map(e=>`<li>${esc(name(e.from))} → ${esc(name(e.to))}${e.label?': '+esc(e.label):''}</li>`).join('')}</ul></div>`;
}

// One edge to a group frame stands for the same edge to every box in it, so a
// fan-out (or fan-in) is bundled only when it reaches every member of the group.
function bundle(edges,members){
 for(const [end,other] of [['to','from'],['from','to']]){
  const by={};edges.forEach((e,i)=>(by[[e[other],e.label||'',e.style||''].join('|')]??=[]).push(i));
  const drop=new Set(),add=[];
  for(const list of Object.values(by)){const hit=new Set(list.map(i=>edges[i][end]));
   for(const [gid,ms] of Object.entries(members)){if(ms.length<2||!ms.every(m=>hit.has(m))||edges[list[0]][other]===gid)continue;
    const mine=list.filter(i=>ms.includes(edges[i][end])&&!drop.has(i));if(mine.length<2)continue;
    mine.forEach(i=>drop.add(i));add.push({...edges[mine[0]],[end]:gid,tech:undefined});}}
  edges=[...edges.filter((_,i)=>!drop.has(i)),...add];}
 return edges;
}

const SVG='http://www.w3.org/2000/svg';
const mk=(tag,attrs)=>{const el=document.createElementNS(SVG,tag);for(const [k,v] of Object.entries(attrs))el.setAttribute(k,v);return el;};

// Edges are routed orthogonally through the free space of the layout: down (or
// up) from the source into the gap between rows, sideways to a channel between
// the boxes of each row it must cross, and into the target. So no edge passes
// through a box, and each label sits in empty space or is left to the edge list.
function draw(d){
 const edges=JSON.parse(d.dataset.edges||'[]');
 const svg=d.querySelector('.dedges');svg.replaceChildren();d.querySelectorAll('.dlabel').forEach(l=>l.remove());
 if(!edges.length)return;
 const box=d.getBoundingClientRect(),W=d.clientWidth;
 const R=el=>{const r=el.getBoundingClientRect();return {l:r.left-box.left,t:r.top-box.top,r:r.right-box.left,b:r.bottom-box.top};};
 const nodes=[...d.querySelectorAll('.dnode')].map(R);
 // Bands: the visual rows, found from the boxes themselves (a group can wrap onto several).
 const bands=[];
 for(const r of [...nodes].sort((a,b)=>a.t-b.t)){const b=bands.at(-1);if(b&&r.t<b.b-4){b.b=Math.max(b.b,r.b);b.items.push(r);}else bands.push({t:r.t,b:r.b,items:[r]});}
 const gap=k=>k<0?bands[0].t-14:k>=bands.length-1?bands.at(-1).b+14:(bands[k].b+bands[k+1].t)/2;
 const bandAt=y=>{let k=bands.findIndex(b=>y>=b.t-2&&y<=b.b+2);if(k<0)k=bands.findIndex(b=>b.t>y)-1;return Math.max(0,k<0?bands.length-1:k);};
 const find=id=>{const el=d.querySelector(`[data-dnode="${CSS.escape(id)}"]`)||d.querySelector(`[data-dgroup="${CSS.escape(id)}"]`);if(!el)return null;const r=R(el);r.group=!el.dataset.dnode;r.top=bandAt(r.group?r.t+30:(r.t+r.b)/2);r.bot=bandAt(r.group?r.b-4:(r.t+r.b)/2);return r;};
 const used={};
 // An x inside band k that clears every box, as close to the wanted x as possible.
 function channel(k,want){const m=9,obs=bands[k].items.map(r=>[r.l-m,r.r+m]).sort((a,b)=>a[0]-b[0]);
  const free=[];let x=4;for(const [a,b] of obs){if(a>x)free.push([x,a]);x=Math.max(x,b);}if(x<W-4)free.push([x,W-4]);
  if(!free.length)return want;
  let best=free[0],bd=Infinity;for(const f of free){const dd=want<f[0]?f[0]-want:want>f[1]?want-f[1]:0;if(dd<bd){bd=dd;best=f;}}
  let cx=Math.min(Math.max(want,best[0]+4),best[1]-4);const u=used[k]??=[];
  for(let i=1;i<12&&u.some(v=>Math.abs(v-cx)<7);i++){const nx=cx+(i%2?1:-1)*i*7;if(nx>best[0]+2&&nx<best[1]-2)cx=nx;}
  u.push(cx);return cx;}
 const routes=edges.map(e=>{const s=find(e.from),t=find(e.to);if(!s||!t)return null;
  let kind=t.top>s.bot?'down':t.bot<s.top?'up':'side';
  if(kind==='side'&&s.group!==t.group)kind=(t.t+t.b)/2>(s.t+s.b)/2?'down':'up';
  const out={down:'b',up:'t',side:t.l>=s.r-2?'r':'l'}[kind],inn={down:'t',up:'b',side:t.l>=s.r-2?'l':'r'}[kind];
  return {e,s,t,kind,out,inn};}).filter(Boolean);
 // Spread several edge ends along one side instead of stacking them on a point.
 const ends={},pt=routes.map(()=>({}));
 routes.forEach((r,i)=>{(ends[r.e.from+'|'+r.out]??=[]).push([i,'s']);(ends[r.e.to+'|'+r.inn]??=[]).push([i,'t']);});
 for(const [key,list] of Object.entries(ends)){const side=key.slice(key.lastIndexOf('|')+1);
  const other=([i,w])=>{const r=routes[i],o=w==='s'?r.t:r.s;return side==='t'||side==='b'?(o.l+o.r)/2:(o.t+o.b)/2;};
  list.sort((a,b)=>other(a)-other(b));
  list.forEach(([i,w],k)=>{const r=routes[i],b=w==='s'?r.s:r.t,off=((k+1)/(list.length+1)-.5)*.7;
   pt[i][w]=side==='t'?[(b.l+b.r)/2+off*(b.r-b.l),b.t]:side==='b'?[(b.l+b.r)/2+off*(b.r-b.l),b.b]:side==='l'?[b.l,(b.t+b.b)/2+off*(b.b-b.t)]:[b.r,(b.t+b.b)/2+off*(b.b-b.t)];});}
 const marker=`a${d.dataset.diagram}`;const defs=mk('defs',{});svg.append(defs);
 for(const style of ['solid','dashed','dotted']){const m=mk('marker',{id:`${marker}-${style}`,viewBox:'0 0 10 10',refX:'9',refY:'5',markerWidth:'7',markerHeight:'7',orient:'auto-start-reverse'});m.append(mk('path',{d:'M0,0 L10,5 L0,10 z',class:`dhead s-${style}`}));defs.append(m);}
 const taken=nodes.map(r=>[r.l-2,r.t-2,r.r+2,r.b+2]),labelled=new Set();
 routes.forEach((r,i)=>{const [x1,y1]=pt[i].s,[x2,y2]=pt[i].t;let pts;
  if(r.kind==='side'){const between=bands[r.s.bot].items.some(o=>o.l>Math.min(r.s.r,r.t.r)-1&&o.r<Math.max(r.s.l,r.t.l)+1&&!(o.l===r.s.l&&o.t===r.s.t)&&!(o.l===r.t.l&&o.t===r.t.t));
   if(!between&&Math.abs(y1-y2)<40)pts=[[x1,y1],[(x1+x2)/2,y1],[(x1+x2)/2,y2],[x2,y2]];
   else{const g=gap(r.s.bot),sx=(r.s.l+r.s.r)/2,tx=(r.t.l+r.t.r)/2;pts=[[sx,r.s.b],[sx,g],[tx,g],[tx,r.t.b]];}}
  else{const down=r.kind==='down',from=down?r.s.bot:r.s.top,to=down?r.t.top:r.t.bot,step=down?1:-1;
   const g=k=>down?gap(k):gap(k-1);
   pts=[[x1,y1],[x1,g(from)]];const n=Math.abs(to-from);
   for(let k=from+step,j=1;down?k<to:k>to;k+=step,j++){const cx=channel(k,x1+(x2-x1)*j/n);pts.push([cx,down?gap(k-1):gap(k)],[cx,down?gap(k):gap(k-1)]);}
   pts.push([x2,down?gap(to-1):gap(to)],[x2,y2]);}
  const style=r.e.style||'solid';
  svg.append(mk('path',{d:smooth(pts),class:`dedge s-${style}`,'marker-end':`url(#${marker}-${style})`,'data-from':r.e.from,'data-to':r.e.to}));
  // One label per (source, text) and per (target, text): a fan-out says it once.
  const text=r.e.label;if(!text||labelled.has(r.e.from+'>'+text)||labelled.has('<'+r.e.to+text))return;
  const lab=document.createElement('span');lab.className='dlabel';lab.textContent=text;d.append(lab);const w=lab.offsetWidth,h=lab.offsetHeight;
  // Candidate spots: the middle of each segment, nearest the path's middle first.
  const segs=pts.slice(1).map((p,k)=>[pts[k],p]).filter(([a,b])=>Math.hypot(a[0]-b[0],a[1]-b[1])>12);
  const mid=segs.length/2;const cands=segs.map((s,k)=>({s,k})).sort((a,b)=>Math.abs(a.k+.5-mid)-Math.abs(b.k+.5-mid));
  const hits=a=>taken.some(b=>a[0]<b[2]&&a[2]>b[0]&&a[1]<b[3]&&a[3]>b[1]);
  let spot=null;
  for(const {s:[a,b]} of cands){const horiz=Math.abs(a[1]-b[1])<1,cx=(a[0]+b[0])/2,cy=(a[1]+b[1])/2;
   for(const o of [0,1,-1,2,-2,3,-3]){const lx=horiz?cx-w/2+o*(w/2+6):cx-w/2,ly=horiz?cy-h/2:cy-h/2+o*(h+4);
    const rect=[lx,ly,lx+w,ly+h];if(lx>=0&&lx+w<=W&&!hits(rect)){spot=rect;break;}}
   if(spot)break;}
  if(!spot){lab.remove();return;}
  labelled.add(r.e.from+'>'+text);labelled.add('<'+r.e.to+text);
  lab.style.left=spot[0]+'px';lab.style.top=spot[1]+'px';taken.push(spot);});
}
// A polyline with rounded corners.
function smooth(pts){
 const p=pts.filter((q,i)=>i===0||Math.hypot(q[0]-pts[i-1][0],q[1]-pts[i-1][1])>.5);
 let out=`M${p[0][0]},${p[0][1]}`;
 for(let i=1;i<p.length-1;i++){const [a,b,c]=[p[i-1],p[i],p[i+1]];const l1=Math.hypot(b[0]-a[0],b[1]-a[1]),l2=Math.hypot(c[0]-b[0],c[1]-b[1]);const r=Math.min(10,l1/2,l2/2);
  if(r<1){out+=` L${b[0]},${b[1]}`;continue;}
  const i1=[b[0]-(b[0]-a[0])/l1*r,b[1]-(b[1]-a[1])/l1*r],o1=[b[0]+(c[0]-b[0])/l2*r,b[1]+(c[1]-b[1])/l2*r];
  out+=` L${i1[0]},${i1[1]} Q${b[0]},${b[1]} ${o1[0]},${o1[1]}`;}
 const z=p.at(-1);return out+` L${z[0]},${z[1]}`;
}

const watched=new WeakSet();
export function drawDiagrams(root){
 root.querySelectorAll('[data-diagram]').forEach(d=>{draw(d);
  if(!watched.has(d)&&'ResizeObserver' in window){watched.add(d);let w=d.clientWidth;new ResizeObserver(()=>{if(d.clientWidth!==w){w=d.clientWidth;draw(d);}}).observe(d);}});
}
