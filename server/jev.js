import { digits,candidateMasks,label,canonical,invariant } from '../public/shared/sudoku.js';
import { heuristicChoice } from '../public/shared/sudoku-ai.js';
import { hash } from './util.js';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// Smallest increment the provider reports probabilities on.
export const PROBABILITY_GRAIN=0.01;
export function encodeJevState(board,givens,candidates) {
  const rows=a=>Array.from({length:9},(_,i)=>a.slice(i*9,i*9+9).join(''));
  const masks=candidateMasks(board.values,board.eliminated);
  return {rules:{boardSize:9,boxSize:3,objective:'Complete a valid Sudoku grid using few solving actions.'},givens:rows(givens),values:rows(board.values),
    candidateDigits:Object.fromEntries(masks.flatMap((m,i)=>m?[[label(i),digits(m)]]:[])),branchDepth:board.branches.length,
    candidates:candidates.map(a=>({id:a.id,kind:a.kind,cell:a.cell===undefined?null:label(a.cell),digit:a.digit??null,technique:a.proof.technique,proof:a.proof,features:a.features}))};
}
export function validateResponse(body,candidates,model) {
  invariant(body&&body.model===model,'wrong_model');
  const a=body.answers?.next_action;
  invariant(a&&a.type==='choice'&&typeof a.probabilities==='object'&&a.probabilities!==null&&!Array.isArray(a.probabilities),'malformed_response');
  const ids=candidates.map(c=>c.id).sort(),keys=Object.keys(a.probabilities).sort();
  invariant(canonical(ids)===canonical(keys),'candidate_set_mismatch');
  invariant(Number.isFinite(a.confidence)&&a.confidence>=0&&a.confidence<=1,'invalid_confidence');
  invariant(keys.every(k=>Number.isFinite(a.probabilities[k])&&a.probabilities[k]>=0&&a.probabilities[k]<=1),'invalid_probability');
  // Each probability is reported on the grain, so the sum can drift by half a grain per
  // bucket. This is the worst case of that rounding, not slack for arbitrary drift.
  const sumTolerance=keys.length*(PROBABILITY_GRAIN/2);
  invariant(Math.abs(Object.values(a.probabilities).reduce((s,p)=>s+p,0)-1)<=sumTolerance,'invalid_probability_sum');
  const max=Math.max(...Object.values(a.probabilities));
  invariant(ids.includes(a.choice)&&Math.abs(a.probabilities[a.choice]-max)<1e-9,'invalid_choice');
  const chosen=ids.filter(id=>Math.abs(a.probabilities[id]-max)<1e-9)[0];
  const usage=body.usage||{};
  for(const key of ['input_tokens','output_tokens'])if(usage[key]!==undefined)invariant(Number.isSafeInteger(usage[key])&&usage[key]>=0,'invalid_usage');
  return {actionId:chosen,providerChoice:a.choice,confidence:a.confidence,probabilities:a.probabilities,model:body.model,
    inputTokens:usage.input_tokens??null,outputTokens:usage.output_tokens??null};
}
async function boundedJson(response) {
  const reader=response.body?.getReader();if(!reader)return response.json();
  let bytes=0;const chunks=[];
  while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>1048576){await reader.cancel();throw new Error('response_too_large');}chunks.push(value);}
  const all=new Uint8Array(bytes);let offset=0;for(const c of chunks){all.set(c,offset);offset+=c.byteLength;}
  return JSON.parse(new TextDecoder().decode(all));
}
/**
 * The only place the model is called. `reserve()` is an async quota reservation made before every provider attempt (D1 backed
 * in the Worker); when it refuses, the decision is an explicit heuristic_fallback, never a silent one and never labelled `jev`.
 */
export class JevAdapter {
  constructor(config,{fetchImpl=(...a)=>fetch(...a),onRequest=()=>{},reserve=async()=>true}={}){this.config=config;this.fetch=fetchImpl;this.onRequest=onRequest;this.reserve=reserve;}
  async choose({board,givens,bundle,forceLocal=false,matchId=null}) {
    const {candidates}=bundle;invariant(candidates.length>0,'no_candidates');
    const common={candidateCount:candidates.length,rawCandidateCount:bundle.rawCount,prunedCount:bundle.prunedCount,previewSteps:bundle.previewSteps,
      boardRevision:board.revision,stateHash:await hash({values:board.values,eliminated:board.eliminated,branches:board.branches}),candidateSetHash:await hash(candidates),
      candidateEvidence:candidates.map(c=>({id:c.id,kind:c.kind,cell:c.cell??null,digit:c.digit??null,proof:c.proof,features:c.features}))};
    if(forceLocal||!this.config.jevKey) return {...common,actionId:heuristicChoice(candidates).id,source:'heuristic',model:null,latencyMs:0,attempts:0};
    if(candidates.length===1) return {...common,actionId:candidates[0].id,source:'forced',model:null,latencyMs:0,attempts:0};
    const state=encodeJevState(board,givens,candidates);
    const body={model:this.config.jevModel,state,questions:{next_action:{type:'choice',instructions:'Select the supplied action most likely to reduce remaining Sudoku solving work. Favor productive certified deductions. Avoid unnecessary branching and contradictions. Evaluate only the supplied board and candidate actions.',criteria:Object.fromEntries(candidates.map(c=>[c.id,{kind:c.kind,cell:c.cell===undefined?null:label(c.cell),digit:c.digit??null,technique:c.proof.technique,features:c.features}]))}}};
    const started=performance.now();let reason='provider_unavailable',attempts=0;
    for(let retry=0;retry<2;retry++){
      if(!(await this.reserve())){reason='provider_quota_limit';break;}
      attempts++;const t=performance.now(),requestId=crypto.randomUUID();let status=null,retryMs=100,usage={};
      const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),this.config.timeoutMs);
      try{
        const response=await this.fetch(this.config.jevEndpoint,{method:'POST',headers:{Authorization:`Bearer ${this.config.jevKey}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal});
        status=response.status;const h=response.headers.get('retry-after');if(h)retryMs=/^\d+(\.\d+)?$/.test(h)?Number(h)*1000:Math.max(0,Date.parse(h)-Date.now());
        if(!response.ok){await response.body?.cancel();throw new Error(`http_${response.status}`);}
        const raw=await boundedJson(response);usage=raw.usage||{};
        const result=validateResponse(raw,candidates,this.config.jevModel);
        await this.onRequest({matchId,name:'jev_request_finished',properties:{requestId,retry,model:this.config.jevModel,outcome:'ok',status,latencyMs:performance.now()-t,inputTokens:result.inputTokens,outputTokens:result.outputTokens,candidates:candidates.length}});
        return {...common,...result,source:'jev',latencyMs:performance.now()-started,attempts};
      }catch(error){
        reason=controller.signal.aborted?'timeout':(['wrong_model','malformed_response','candidate_set_mismatch','invalid_confidence','invalid_probability','invalid_probability_sum','invalid_choice','invalid_usage','response_too_large'].includes(error.message)?error.message:status?`http_${status}`:'network_error');
        await this.onRequest({matchId,name:'jev_request_finished',properties:{requestId,retry,model:this.config.jevModel,outcome:reason,status,latencyMs:performance.now()-t,
          inputTokens:Number.isSafeInteger(usage.input_tokens)?usage.input_tokens:null,outputTokens:Number.isSafeInteger(usage.output_tokens)?usage.output_tokens:null,candidates:candidates.length}});
        if(status===401||status===403||retryMs>500)break;
        if(retry===0)await wait(retryMs);
      }finally{clearTimeout(timer);}
    }
    return {...common,actionId:heuristicChoice(candidates).id,source:'heuristic_fallback',reason,model:null,latencyMs:performance.now()-started,attempts};
  }
}
