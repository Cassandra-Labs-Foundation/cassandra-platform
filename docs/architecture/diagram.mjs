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
 const ids=new Set(),members={},owner={};
 const groupHtml=g=>{const gid=g.id||(g.label?'g:'+g.label:'');if(gid)ids.add(gid);g.nodes.forEach(n=>ids.add(n.id));
  const real=g.nodes.filter(n=>n.tone!=='more').map(n=>n.id);if(gid){members[gid]=real;if(real.length>1)real.forEach(id=>owner[id]=gid);}
  return `<div class="dgroup${g.label?'':' plain'}${g.tone?' t-'+g.tone:''}"${gid?` data-dgroup="${esc(gid)}"`:''}>${g.label?`<span class="dglabel">${esc(g.label)}</span>`:''}${g.nodes.map(n=>nodeHtml(n,eng)).join('')}</div>`;};
 const rowHtml=row=>{const gs=row.filter(g=>g.nodes.length);return gs.length?`<div class="drow">${gs.map(groupHtml).join('')}</div>`:'';};
 // A row entry may be a frame {frame, id, rows} that encloses several rows.
 const rows=spec.rows.map(row=>{if(Array.isArray(row))return rowHtml(row);
  const gid=row.id||'g:'+row.frame;ids.add(gid);const inner=row.rows.map(rowHtml).join('');
  members[gid]=row.rows.flat().flatMap(g=>g.nodes.filter(n=>n.tone!=='more').map(n=>n.id));
  if(members[gid].length>1)members[gid].forEach(id=>owner[id]??=gid);
  return inner?`<div class="dframe" data-dgroup="${esc(gid)}"><span class="dglabel">${esc(row.frame)}</span>${inner}</div>`:'';}).join('');
 const all=spec.rows.flatMap(r=>Array.isArray(r)?[r]:r.rows);
 const raw=bundle(spec.edges.filter(e=>ids.has(e.from)&&ids.has(e.to)&&e.from!==e.to),members);
 const edges=collapse(raw,owner).map(e=>({...e,label:[e.label,eng&&e.tech?e.tech:''].filter(Boolean).join(' · ')}));
 const name=id=>{for(const r of spec.rows)if(!Array.isArray(r)&&(r.id||'g:'+r.frame)===id)return r.frame;for(const row of all)for(const g of row){if((g.id||(g.label?'g:'+g.label:''))===id)return g.label;const n=g.nodes.find(x=>x.id===id);if(n)return n.title;}return id;};
 return `<div class="diagram" data-diagram="${++serial}" data-edges="${esc(JSON.stringify(edges))}" role="group" aria-label="${esc(spec.label||'Flow diagram')}">${rows}<svg class="dedges" aria-hidden="true"></svg><ul class="dsr">${raw.map(e=>`<li>${esc(name(e.from))} → ${esc(name(e.to))}${e.label||(eng&&e.tech)?': '+esc([e.label,eng&&e.tech?e.tech:''].filter(Boolean).join(' · ')):''}</li>`).join('')}</ul></div>`;
}

// Three or more wires between the same two groups read as noise, not
// information: draw them as one arrow between the groups (or between the one
// box they share). The screen-reader list still names every original edge.
function collapse(edges,owner){
 const by={},S='\u0001';
 edges.forEach((e,i)=>{const a=owner[e.from]??e.from,b=owner[e.to]??e.to;if(a!==b)(by[[a,b,e.style||''].join(S)]??=[]).push(i);});
 const drop=new Set(),add=[];
 for(const [k,list] of Object.entries(by)){if(list.length<3)continue;const [a,b]=k.split(S),L=list.map(i=>edges[i]);
  const one=f=>new Set(L.map(e=>e[f])).size===1;
  const tally={};L.forEach(e=>{if(e.label)tally[e.label]=(tally[e.label]||0)+1;});
  const label=Object.entries(tally).sort((x,y)=>y[1]-x[1])[0]?.[0]||'';
  add.push({from:one('from')?L[0].from:a,to:one('to')?L[0].to:b,style:L[0].style,label,n:L.length});
  list.forEach(i=>drop.add(i));}
 return [...edges.filter((_,i)=>!drop.has(i)),...add];
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
// up) from the source into the gap between rows, along a lane of that gap, to
// a channel between the boxes of each row it must cross, and into the target.
// Every edge into one box shares its entry point and lane, so arrivals merge
// like a tree instead of fanning into parallel wires; edges that skip a row
// are kept out of the resting picture and drawn when a box they touch is
// pointed at or focused.
function draw(d){
 const edges=JSON.parse(d.dataset.edges||'[]');
 const svg=d.querySelector('.dedges');svg.replaceChildren();d.querySelectorAll('.dlabel,.dhint').forEach(l=>l.remove());
 if(!edges.length)return;
 const box=d.getBoundingClientRect(),W=d.clientWidth;
 const R=el=>{const r=el.getBoundingClientRect();return {l:r.left-box.left,t:r.top-box.top,r:r.right-box.left,b:r.bottom-box.top};};
 const nodes=[...d.querySelectorAll('.dnode')].map(R);
 const bands=[];
 for(const r of [...nodes].sort((a,b)=>a.t-b.t)){const b=bands.at(-1);if(b&&r.t<b.b-4){b.b=Math.max(b.b,r.b);b.items.push(r);}else bands.push({t:r.t,b:r.b,items:[r]});}
 const gap=k=>k<0?bands[0].t-14:k>=bands.length-1?bands.at(-1).b+14:(bands[k].b+bands[k+1].t)/2;
 const bandAt=y=>{let k=bands.findIndex(b=>y>=b.t-2&&y<=b.b+2);if(k<0)k=bands.findIndex(b=>b.t>y)-1;return Math.max(0,k<0?bands.length-1:k);};
 const find=id=>{const el=d.querySelector(`[data-dnode="${CSS.escape(id)}"]`)||d.querySelector(`[data-dgroup="${CSS.escape(id)}"]`);if(!el)return null;const r=R(el);r.group=!el.dataset.dnode;
  if(r.group){const inside=bands.map((b,k)=>b.t>=r.t-1&&b.b<=r.b+1?k:-1).filter(k=>k>=0);r.top=inside[0]??bandAt(r.t+30);r.bot=inside.at(-1)??bandAt(r.b-4);}
  else r.top=r.bot=bandAt((r.t+r.b)/2);return r;};
 const used={};
 function channel(k,want){const m=10,obs=bands[k].items.map(r=>[r.l-m,r.r+m]).sort((a,b)=>a[0]-b[0]);
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
  const span=kind==='down'?t.top-s.bot:kind==='up'?s.top-t.bot:0;
  return {e,s,t,kind,out,inn,span};}).filter(Boolean);
 const crowded=routes.filter(r=>r.span>1).length>2||routes.length>10;
 // A row-skipping edge rests out of view only when both of its boxes keep another edge.
 const short={};routes.forEach(r=>{if(r.span<=1){short[r.e.from]=1;short[r.e.to]=1;}});
 // A box counts as connected when it, its frame or a box inside it has a resting edge.
 const el=id=>d.querySelector(`[data-dnode="${CSS.escape(id)}"]`)||d.querySelector(`[data-dgroup="${CSS.escape(id)}"]`);
 const linked=id=>{const x=el(id);if(!x)return false;if(short[id])return true;
  for(let a=x.parentElement;a&&a!==d;a=a.parentElement)if(a.dataset.dgroup&&short[a.dataset.dgroup])return true;
  return [...x.querySelectorAll('[data-dnode],[data-dgroup]')].some(c=>short[c.dataset.dnode||c.dataset.dgroup]);};
 routes.forEach(r=>{r.defer=crowded&&r.span>1&&linked(r.e.from)&&linked(r.e.to);});
 routes.forEach(r=>{if(r.span>1&&!r.defer){short[r.e.from]=1;short[r.e.to]=1;}});
 // One entry (and one exit) point per box side and line style.
 const slot={solid:0,dashed:.22,dotted:-.22};
 const port=(b,side,style)=>{const o=slot[style||'solid']??0;return side==='t'?[(b.l+b.r)/2+o*(b.r-b.l),b.t]:side==='b'?[(b.l+b.r)/2+o*(b.r-b.l),b.b]:side==='l'?[b.l,(b.t+b.b)/2+o*(b.b-b.t)]:[b.r,(b.t+b.b)/2+o*(b.b-b.t)];};
 // Each gap gives every target its own horizontal lane, ordered by the target's x.
 const laneKeys={};
 [...routes].sort((a,b)=>(a.t.l+a.t.r)-(b.t.l+b.t.r)).forEach(r=>{if(r.kind==='side')return;const down=r.kind==='down';
  for(let k=down?r.s.bot:r.t.bot;k<(down?r.t.top:r.s.top);k++){const L=laneKeys[k]??=[];const key=r.e.to+'|'+(r.e.style||'');if(!L.includes(key))L.push(key);}});
 const lane=(k,r)=>{const L=laneKeys[k]||[],i=L.indexOf(r.e.to+'|'+(r.e.style||''));if(L.length<2||i<0)return gap(k);
  const room=Math.max(0,((k<0||k>=bands.length-1)?20:(bands[k+1].t-bands[k].b)-26)/2),step=Math.min(8,2*room/(L.length-1));
  return gap(k)+(i-(L.length-1)/2)*step;};
 const marker=`a${d.dataset.diagram}`;const defs=mk('defs',{});svg.append(defs);
 for(const style of ['solid','dashed','dotted']){const m=mk('marker',{id:`${marker}-${style}`,viewBox:'0 0 10 10',refX:'9',refY:'5',markerWidth:'7',markerHeight:'7',orient:'auto-start-reverse'});m.append(mk('path',{d:'M0,0 L10,5 L0,10 z',class:`dhead s-${style}`}));defs.append(m);}
 const taken=[...nodes,...[...d.querySelectorAll('.dglabel')].map(el=>{const r=R(el.firstChild?(()=>{const g=document.createRange();g.selectNodeContents(el);return g;})():el);return r;})].map(r=>[r.l-2,r.t-2,r.r+2,r.b+2]),labelled=new Set();
 // Resting edges first, so their labels get the free spots.
 const order=[...routes].sort((a,b)=>!!a.defer-!!b.defer);
 order.forEach(r=>{const [x1,y1]=port(r.s,r.out,r.e.style),[x2,y2]=port(r.t,r.inn,r.e.style);let pts;
  if(r.kind==='side'){const between=bands[r.s.bot].items.some(o=>o.l>Math.min(r.s.r,r.t.r)-1&&o.r<Math.max(r.s.l,r.t.l)+1&&!(o.l===r.s.l&&o.t===r.s.t)&&!(o.l===r.t.l&&o.t===r.t.t));
   if(!between&&Math.abs(y1-y2)<40)pts=[[x1,y1],[(x1+x2)/2,y1],[(x1+x2)/2,y2],[x2,y2]];
   else{const g=gap(r.s.bot),sx=(r.s.l+r.s.r)/2,tx=(r.t.l+r.t.r)/2;pts=[[sx,r.s.b],[sx,g],[tx,g],[tx,r.t.b]];}}
  else{const down=r.kind==='down',from=down?r.s.bot:r.s.top,to=down?r.t.top:r.t.bot,step=down?1:-1;
   const ln=k=>lane(k,r),first=down?from:from-1,last=down?to-1:to;
   pts=[[x1,y1],[x1,ln(first)]];const n=Math.abs(to-from);
   for(let k=from+step,j=1;down?k<to:k>to;k+=step,j++){const cx=channel(k,x1+(x2-x1)*j/n);pts.push([cx,ln(down?k-1:k)],[cx,ln(down?k:k-1)]);}
   pts.push([x2,ln(last)],[x2,y2]);}
  const style=r.e.style||'solid',deferred=!!r.defer;
  svg.append(mk('path',{d:smooth(pts),class:`dedge s-${style}${deferred?' long':''}`,'marker-end':`url(#${marker}-${style})`,'data-from':r.e.from,'data-to':r.e.to}));
  const text=r.e.label;if(!text||labelled.has(r.e.from+'>'+text)||labelled.has('<'+r.e.to+text))return;
  const lab=document.createElement('span');lab.className='dlabel'+(deferred?' long':'');lab.dataset.from=r.e.from;lab.dataset.to=r.e.to;lab.textContent=text;d.append(lab);const w=lab.offsetWidth,h=lab.offsetHeight;
  const segs=pts.slice(1).map((p,k)=>[pts[k],p]).filter(([a,b])=>Math.hypot(a[0]-b[0],a[1]-b[1])>12);
  const mid=segs.length/2;const cands=segs.map((s,k)=>({s,k})).sort((a,b)=>Math.abs(a.k+.5-mid)-Math.abs(b.k+.5-mid));
  const hits=a=>taken.some(b=>a[0]<b[2]&&a[2]>b[0]&&a[1]<b[3]&&a[3]>b[1]);
  let spot=null;
  for(const {s:[a,b]} of cands){const horiz=Math.abs(a[1]-b[1])<1,cx=(a[0]+b[0])/2,cy=(a[1]+b[1])/2;
   for(const o of [0,1,-1,2,-2,3,-3]){const lx=horiz?cx-w/2+o*(w/2+6):cx+6,ly=horiz?cy-h/2:cy-h/2+o*(h+4);
    const rect=[lx,ly,lx+w,ly+h];if(lx>=0&&lx+w<=W&&!hits(rect)){spot=rect;break;}}
   if(spot)break;}
  if(!spot){lab.remove();return;}
  if(!deferred){labelled.add(r.e.from+'>'+text);labelled.add('<'+r.e.to+text);taken.push(spot);}
  lab.style.left=spot[0]+'px';lab.style.top=spot[1]+'px';});
 const hidden=routes.filter(r=>r.defer).length;
 if(hidden){const p=document.createElement('p');p.className='dhint';p.textContent=`${hidden} longer connection${hidden>1?'s':''} that skip a row appear when you point at or focus a box.`;d.append(p);}
}
// Pointing at (or focusing) a box brings forward every edge that touches it or its frame.
function highlight(d,el){
 const ids=new Set();for(let x=el;x&&x!==d;x=x.parentElement){if(x.dataset?.dnode)ids.add(x.dataset.dnode);if(x.dataset?.dgroup)ids.add(x.dataset.dgroup);}
 d.classList.toggle('hovering',ids.size>0);
 d.querySelectorAll('.dedge,.dlabel').forEach(p=>{const f=p.dataset?.from??p.getAttribute('data-from'),t=p.dataset?.to??p.getAttribute('data-to');p.classList.toggle('on',ids.has(f)||ids.has(t));});
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
  if(!d.dataset.hover){d.dataset.hover='1';const pick=ev=>highlight(d,ev.target.closest('.dnode')||ev.target.closest('[data-dgroup]')||d);
   d.addEventListener('pointerover',pick);d.addEventListener('focusin',pick);d.addEventListener('pointerleave',()=>highlight(d,d));d.addEventListener('focusout',()=>highlight(d,d));}
  if(!watched.has(d)&&'ResizeObserver' in window){watched.add(d);let w=d.clientWidth;new ResizeObserver(()=>{if(d.clientWidth!==w){w=d.clientWidth;draw(d);}}).observe(d);}});
}
