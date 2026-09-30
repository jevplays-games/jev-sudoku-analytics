import {writeFileSync,mkdirSync}from'node:fs';import{dirname}from'node:path';import{performance}from'node:perf_hooks';
import{generatePuzzle,rng}from'./puzzle-lib.js';import{createMatchState,advanceState}from'../public/shared/match.js';
import{getJevCandidates,heuristicChoice,PROFILES}from'../public/shared/sudoku-ai.js';import{distribution}from'../public/shared/analytics.js';
import{JevAdapter}from'../server/jev.js';import{loadConfig}from'../server/config.js';import{createHash}from'node:crypto';const hash=x=>createHash('sha256').update(x).digest('hex');
const args=process.argv.slice(2),arg=(name,fallback)=>{const i=args.indexOf(`--${name}`);return i<0?fallback:args[i+1];};
const count=Number(arg('puzzles','2')),maxActions=Number(arg('max-actions','600')),split=arg('split','smoke'),seed=arg('seed','release-v1');
const difficulties=arg('difficulties','easy,normal,hard,jev').split(','),selectors=arg('selectors','canonical,greedy,random').split(',');
const output=arg('out','reports/benchmark.json');
if(!Number.isInteger(count)||count<1||count>1000||!Number.isInteger(maxActions)||maxActions<1||maxActions>5000)throw Error('Invalid benchmark bounds');
if(!['smoke','development','holdout'].includes(split))throw Error('Use --split smoke, development, or holdout');
if(!difficulties.every(d=>PROFILES[d])||!selectors.every(s=>['canonical','greedy','random','jev'].includes(s)))throw Error('Unknown profile or selector');
const config=loadConfig(process.env);if(selectors.includes('jev')&&(!args.includes('--live')||!config.jevKey))throw Error('Live JEV requires both --live and TYPESAFE_API_KEY; it may incur charges.');
const rows=[],transcripts=[];let requestLog=[];
const adapter=new JevAdapter(config,{onRequest:event=>{requestLog.push(event.properties);}});
for(let i=0;i<count;i++){
  const puzzle=generatePuzzle(`${split}:${seed}:family:${i}`),puzzleId=hash(puzzle.givens);
  for(const difficulty of difficulties)for(const selector of selectors){
    let state=createMatchState(puzzle.givens,{difficulty,pacingMs:0,mode:'practice',model:config.jevModel}),status='budget_exhausted';
    state=advanceState(state,{type:'start',ms:0});const random=rng(`${seed}:${i}:${difficulty}:${selector}`),decisions=[];requestLog=[];const t=performance.now();let computeMs=0,invalid=0,fallbacks=0,ms=0;
    for(let turn=1;turn<=maxActions;turn++){
      const c0=performance.now(),bundle=getJevCandidates(state.jev,difficulty);computeMs+=performance.now()-c0;
      if(!bundle.candidates.length){status='stalled';break;}
      let action,decision;
      if(selector==='jev'){
        decision=await adapter.choose({board:state.jev,givens:state.givens,bundle,matchId:`benchmark-${i}-${difficulty}`});
        action=bundle.candidates.find(a=>a.id===decision.actionId);
        if(decision.source==='heuristic_fallback'){fallbacks++;status='provider_fallback';break;}
      }else{
        action=selector==='greedy'?heuristicChoice(bundle.candidates):selector==='random'?bundle.candidates[Math.floor(random()*bundle.candidates.length)]:bundle.candidates[0];
        decision={source:selector,model:null,actionId:action.id,candidateCount:bundle.candidates.length,rawCandidateCount:bundle.rawCount,prunedCount:bundle.prunedCount,previewSteps:bundle.previewSteps};
      }
      try{ms+=Math.max(8000,decision.latencyMs||0);state=advanceState(state,{type:'jev',ms:Math.min(turn,3599999),action,decision});}
      catch(error){invalid++;status='invalid_transition';break;}
      decisions.push({action,decision});if(state.jev.finishMs!==null){status='solved';break;}
    }
    const actions=decisions.length,elapsed=performance.now()-t;
    const row={puzzleIndex:i,puzzleHash:puzzleId,split,difficulty,selector,status,completed:status==='solved',actions,unpacedWallMs:elapsed,
      simulatedPacedMs:status==='solved'?ms:null,pacingMs:8000,preprocessingMs:computeMs,remainingEmpty:state.jev.values.filter(x=>!x).length,
      assumptions:decisions.filter(d=>d.action.kind==='assume').length,backtracks:decisions.filter(d=>d.action.kind==='backtrack').length,
      invalidTransitions:invalid,providerFallbacks:fallbacks,providerRequests:requestLog.length,
      providerLatencyMs:distribution(requestLog.map(r=>r.latencyMs)),inputTokens:requestLog.reduce((n,r)=>n+(r.inputTokens||0),0),
      reportedModel:selector==='jev'?config.jevModel:null,actualClues:puzzle.actualClues};
    rows.push(row);transcripts.push({puzzleHash:puzzleId,difficulty,selector,givens:puzzle.givens,decisions,providerRequests:[...requestLog]});
    console.log(JSON.stringify(row));
  }
}
const groups=[];for(const difficulty of difficulties)for(const selector of selectors){const rs=rows.filter(r=>r.difficulty===difficulty&&r.selector===selector);groups.push({difficulty,selector,runs:rs.length,completed:rs.filter(r=>r.completed).length,
  completionRate:rs.filter(r=>r.completed).length/rs.length,actionsToCompletion:distribution(rs.filter(r=>r.completed).map(r=>r.actions)),
  unpacedWallMs:distribution(rs.map(r=>r.unpacedWallMs)),simulatedPacedMs:distribution(rs.filter(r=>r.completed).map(r=>r.simulatedPacedMs)),invalidTransitions:rs.reduce((n,r)=>n+r.invalidTransitions,0)});}
const report={schemaVersion:'benchmark-v1',generatedAt:new Date().toISOString(),seed,split,puzzleFamilies:count,liveJevUsed:selectors.includes('jev'),
  methodology:'All selectors receive the same profile-specific bounded candidate generation and feature budgets. No exact solution is passed to a selector. Unique independent generated families are namespaced by split.',
  limits:['Small synthetic smoke samples are not evidence of general JEV strength.','Simulated pacing excludes production scheduler jitter and simultaneous traffic.','No JEV performance claim exists when liveJevUsed is false.'],config:{maxActions,difficulties,selectors,policyVersion:'sudoku-policy-v1',generatorVersion:'mrv-unique-v1'},groups,runs:rows};
mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');
writeFileSync(output.replace(/\.json$/,'')+'-transcripts.ndjson',transcripts.map(x=>JSON.stringify(x)).join('\n')+'\n');
console.log(`Wrote ${rows.length} runs to ${output}`);
