import { candidateMask,digits,countSolutions } from '../public/shared/sudoku.js';
/** Seeded generator for reproducible publishing; never sent to ranked clients. */
export function rng(seed) {
  let h=2166136261;for(const c of String(seed)){h^=c.charCodeAt(0);h=Math.imul(h,16777619);}
  let x=h>>>0||1;return ()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return (x>>>0)/4294967296;};
}
export function shuffle(xs,random){const a=[...xs];for(let i=a.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
export function generatePuzzle(seed,clues=36) {
  if(!Number.isInteger(clues)||clues<25||clues>60)throw new Error('clues must be between 25 and 60');
  const random=rng(seed),board=Array(81).fill(0);let nodes=0;
  const solve=()=>{
    if(++nodes>1000000)throw new Error('generation_budget_exceeded');
    let cell=-1,ds=null;
    for(let i=0;i<81;i++)if(!board[i]){const options=digits(candidateMask(board,i));if(!options.length)return false;if(!ds||options.length<ds.length){cell=i;ds=options;if(ds.length===1)break;}}
    if(cell<0)return true;
    for(const d of shuffle(ds,random)){board[cell]=d;if(solve())return true;}board[cell]=0;return false;
  };
  if(!solve())throw new Error('generation_failed');
  let remaining=81;
  for(const i of shuffle(Array.from({length:81},(_,k)=>k),random)){
    if(remaining<=clues)break;const old=board[i];board[i]=0;
    try{if(countSolutions(board,2,200000).count===1)remaining--;else board[i]=old;}catch{board[i]=old;}
  }
  if(countSolutions(board,2).count!==1)throw new Error('non_unique_puzzle');
  return {givens:board.join(''),actualClues:remaining,generatorVersion:'mrv-unique-v1',seed:String(seed)};
}
