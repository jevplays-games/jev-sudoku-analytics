import { ALL, bit, digits, popcount, ROWS, COLS, UNITS, PEERS, candidateMasks, isContradiction, clone, invariant, canonical } from './sudoku.js';
export const POLICY_VERSION = 'sudoku-policy-v1';
export const PROFILES = Object.freeze({
  easy:   { techniques: ['naked_single'], cap: 8, previewBudget: 0 },
  normal: { techniques: ['naked_single','hidden_single','locked_candidate'], cap: 16, previewBudget: 32 },
  hard:   { techniques: ['naked_single','hidden_single','locked_candidate','naked_pair','hidden_pair','x_wing'], cap: 32, previewBudget: 256 },
  jev:    { techniques: ['naked_single','hidden_single','locked_candidate','naked_pair','hidden_pair','x_wing','naked_triple'], cap: 64, previewBudget: 2048, branching: true }
});
const combos = (items,k) => { const out = []; const go = (a,start) => { if (a.length === k) {out.push(a);return;}
  for (let i=start;i<items.length;i++) go([...a,items[i]],i+1); }; go([],0); return out; };
const effectId = a => `${a.kind}:${String(a.cell).padStart(2,'0')}:${a.digit}`;
export function logicalActions(board, difficulty = 'normal') {
  const profile = PROFILES[difficulty]; invariant(profile, 'invalid_difficulty');
  const { values, eliminated } = board, masks = candidateMasks(values, eliminated), found = new Map();
  const allowed = new Set(profile.techniques);
  const add = (kind,cell,digit,technique,cells,unit = null) => {
    if (!allowed.has(technique) || values[cell] || !(masks[cell] & bit(digit))) return;
    const a = {kind,cell,digit,proof:{technique,cells:[...cells].sort((a,b)=>a-b),unit}};
    a.id = effectId(a); if (!found.has(a.id)) found.set(a.id,a);
  };
  masks.forEach((m,i) => { if (popcount(m) === 1) add('place',i,digits(m)[0],'naked_single',[i]); });
  if (allowed.has('hidden_single')) UNITS.forEach((u,ui) => {
    for (let d=1;d<=9;d++) { const cells = u.filter(i=>masks[i]&bit(d)); if (cells.length===1) add('place',cells[0],d,'hidden_single',cells,ui); }
  });
  if (allowed.has('locked_candidate')) UNITS.forEach((u,ui) => {
    for (let d=1;d<=9;d++) { const cells=u.filter(i=>masks[i]&bit(d)); if(cells.length<2) continue;
      UNITS.forEach((other,oi)=>{ if(ui===oi || !cells.every(i=>other.includes(i))) return;
        other.filter(i=>!u.includes(i)).forEach(i=>add('eliminate',i,d,'locked_candidate',cells,ui)); });
    }
  });
  for (const size of [2,3]) {
    const technique = size===2 ? 'naked_pair' : 'naked_triple'; if(!allowed.has(technique)) continue;
    UNITS.forEach((u,ui)=> {
      for (const cells of combos(u.filter(i=>masks[i] && popcount(masks[i])<=size),size)) {
        const union=cells.reduce((m,i)=>m|masks[i],0); if(popcount(union)!==size) continue;
        for(const i of u.filter(i=>!cells.includes(i))) for(const d of digits(masks[i]&union)) add('eliminate',i,d,technique,cells,ui);
      }
    });
  }
  if(allowed.has('hidden_pair')) UNITS.forEach((u,ui)=> {
    for(const ds of combos(digits(ALL),2)) {
      const a=u.filter(i=>masks[i]&bit(ds[0])), b=u.filter(i=>masks[i]&bit(ds[1]));
      const cells=[...new Set([...a,...b])]; if(!a.length || !b.length || cells.length!==2) continue;
      const keep=bit(ds[0])|bit(ds[1]);
      for(const i of cells) for(const d of digits(masks[i]&~keep)) add('eliminate',i,d,'hidden_pair',cells,ui);
    }
  });
  if(allowed.has('x_wing')) for(const [base,cross] of [[ROWS,COLS],[COLS,ROWS]]) {
    for(let d=1;d<=9;d++) for(const [u,v] of combos(base,2)) {
      const a=u.filter(i=>masks[i]&bit(d)), b=v.filter(i=>masks[i]&bit(d)); if(a.length!==2 || b.length!==2) continue;
      const crosses=cross.filter(c=>a.some(i=>c.includes(i)));
      if(!b.every(i=>crosses.some(c=>c.includes(i)))) continue;
      const support=[...a,...b]; for(const c of crosses) for(const i of c) if(!support.includes(i)) add('eliminate',i,d,'x_wing',support);
    }
  }
  return [...found.values()];
}
export function rawCandidates(board,difficulty) {
  if(isContradiction(board.values,board.eliminated)) return board.branches.length ? [{id:'backtrack',kind:'backtrack',proof:{technique:'backtrack'}}] : [];
  const logical=logicalActions(board,difficulty); if(logical.length || !PROFILES[difficulty].branching) return logical;
  const masks=candidateMasks(board.values,board.eliminated);
  let cell=-1; for(let i=0;i<81;i++) if(masks[i] && (cell<0 || popcount(masks[i])<popcount(masks[cell]))) cell=i;
  return cell<0 ? [] : digits(masks[cell]).map(digit=> {const a={kind:'assume',cell,digit,proof:{technique:'assumption',cells:[cell],unit:null}};a.id=effectId(a);return a;});
}
// Bounded look-ahead of forced (naked single) placements. Candidate masks are maintained incrementally: a placement can
// only remove that digit from its empty peers, so this is identical to recomputing every mask each step, at a fraction of the CPU.
function preview(board,action,budget) {
  const values=[...board.values], eliminated=[...board.eliminated]; let placements=0, eliminations=0, steps=0;
  if(action.kind==='place'||action.kind==='assume') values[action.cell]=action.digit;
  if(action.kind==='eliminate') eliminated[action.cell]|=bit(action.digit);
  const masks=candidateMasks(values,eliminated);
  while(steps<budget) {
    let i=-1; for(let k=0;k<81;k++){const m=masks[k]; if(m && !(m&(m-1))){i=k;break;}}
    if(i<0 || isContradiction(values,eliminated,masks)) break;
    const d=32-Math.clz32(masks[i]); values[i]=d; placements++; steps++;
    masks[i]=0; for(const j of PEERS[i]) if(!values[j]) masks[j]&=~bit(d);
  }
  return {previewPlacements:placements,previewEliminations:eliminations,previewSteps:steps,previewContradiction:isContradiction(values,eliminated,masks)};
}
// Small memo: the same board is asked for candidates by the scheduler and again by advanceState's validation. Results are
// read-only for every caller; the key covers every input that affects them (branches matter only through their length).
const memo=new Map();
export function getJevCandidates(board,difficulty='normal') {
  const key=`${difficulty}|${board.values.join('')}|${board.eliminated.join(',')}|${board.branches.length}`;
  const hit=memo.get(key); if(hit) {memo.delete(key);memo.set(key,hit);return hit;}
  const result=computeJevCandidates(board,difficulty);
  memo.set(key,result); if(memo.size>16) memo.delete(memo.keys().next().value);
  return result;
}
function computeJevCandidates(board,difficulty) {
  const profile=PROFILES[difficulty]; invariant(profile,'invalid_difficulty');
  const raw=rawCandidates(board,difficulty), masks=candidateMasks(board.values,board.eliminated);
  const scored=raw.map(a=>({...a,features:{remainingCandidates:a.cell===undefined?0:popcount(masks[a.cell]),
    affectedPeers:a.cell===undefined?0:PEERS[a.cell].filter(i=>masks[i]&bit(a.digit)).length}}));
  scored.sort((a,b)=>(a.kind==='place'?-1:0)-(b.kind==='place'?-1:0) || b.features.affectedPeers-a.features.affectedPeers || a.id.localeCompare(b.id));
  const selected=[], seen=new Set();
  for(const a of scored) if(!seen.has(a.proof.technique)) {selected.push(a);seen.add(a.proof.technique);}
  for(const a of scored) if(selected.length<profile.cap && !selected.includes(a)) selected.push(a);
  const capped=selected.slice(0,profile.cap), perCandidate=Math.floor(profile.previewBudget/Math.max(1,capped.length));
  for(const a of capped) Object.assign(a.features,a.kind==='backtrack'?{previewPlacements:0,previewEliminations:0,previewSteps:0,previewContradiction:false}:preview(board,a,perCandidate));
  capped.sort((a,b)=>a.id.localeCompare(b.id));
  return {candidates:capped,rawCount:raw.length,prunedCount:Math.max(0,raw.length-capped.length),previewBudget:profile.previewBudget,
    previewSteps:capped.reduce((n,a)=>n+a.features.previewSteps,0)};
}
export function heuristicChoice(candidates) {
  return [...candidates].sort((a,b)=>Number(a.features?.previewContradiction)-Number(b.features?.previewContradiction) ||
    (b.features?.previewPlacements||0)-(a.features?.previewPlacements||0) ||
    (a.kind==='place'?-1:0)-(b.kind==='place'?-1:0) ||
    (b.features?.affectedPeers||0)-(a.features?.affectedPeers||0) || a.id.localeCompare(b.id))[0];
}
export function applyJev(board,action,difficulty,{trusted=false}={}) {
  invariant(action && typeof action==='object','invalid_jev_action');
  if(!trusted) {
    const matching=rawCandidates(board,difficulty).find(a=>a.id===action.id && a.kind===action.kind && a.cell===action.cell && a.digit===action.digit && canonical(a.proof)===canonical(action.proof));
    invariant(matching,'invalid_jev_proof');
  }
  const b=clone(board);
  if(action.kind==='backtrack') {
    const branch=b.branches.pop(); b.values=branch.values; b.eliminated=branch.eliminated; b.eliminated[branch.cell]|=bit(branch.digit);
  } else if(action.kind==='eliminate') b.eliminated[action.cell]|=bit(action.digit);
  else {
    if(action.kind==='assume') b.branches.push({values:[...b.values],eliminated:[...b.eliminated],cell:action.cell,digit:action.digit});
    b.values[action.cell]=action.digit;
  }
  b.revision++; return b;
}
