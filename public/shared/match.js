import { RULES_VERSION, parseGivens, isSolved, applyHuman, clone, invariant } from './sudoku.js';
import { POLICY_VERSION, PROFILES, applyJev, getJevCandidates } from './sudoku-ai.js';
export function createMatchState(givens,config={}) {
  const clues=parseGivens(givens); invariant(!isSolved(clues),'already_solved');
  const options={difficulty:'normal',pacingMs:8000,timeLimitMs:3600000,mode:'practice',model:'jev-1.13.0',policyVersion:POLICY_VERSION,...config};
  invariant(PROFILES[options.difficulty],'invalid_difficulty');
  invariant(Number.isInteger(options.pacingMs)&&options.pacingMs>=0 && Number.isInteger(options.timeLimitMs)&&options.timeLimitMs>0,'invalid_timing');
  invariant(['practice','ranked'].includes(options.mode),'invalid_mode');
  return {schemaVersion:1,rulesVersion:RULES_VERSION,givens:clues,config:options,phase:'ready',elapsedMs:0,sequence:0,outcome:'pending',
    eligibility:options.mode==='ranked'?'ranked':'practice',ineligibleReason:null,providerFallback:false,
    human:{values:[...clues],undo:[],revision:0,finishMs:null,forfeited:false},
    jev:{values:[...clues],eliminated:Array(81).fill(0),branches:[],revision:0,finishMs:null,status:'ready',lastActionMs:0}};
}
export function raceOutcome(s) {
  if(s.human.forfeited) return 'jev';
  const h=s.human.finishMs,j=s.jev.finishMs;
  if(h!==null && j!==null) return Math.floor(h/1000)===Math.floor(j/1000)?'draw':h<j?'human':'jev';
  if(h!==null) return 'human'; if(j!==null) return 'jev';
  return s.phase==='finished'?'draw':'pending';
}
// options.candidates: an already-computed getJevCandidates(...).candidates for this board (skips recomputation, still validated against).
// options.trusted: the event was already validated when it was recorded; skip candidate/proof re-derivation. Used only by the server
// when re-reading its own recorded events for analytics. Anything imported or client supplied is replayed untrusted.
export function advanceState(state,event,options={}) {
  invariant(event && Number.isSafeInteger(event.ms) && event.ms>=state.elapsedMs,'invalid_event_time');
  invariant(typeof event.type==='string','invalid_event');
  const s=clone(state); s.elapsedMs=event.ms; s.sequence++;
  if(event.type==='start') {invariant(s.phase==='ready' && event.ms===0,'already_started');s.phase='running';s.jev.status='thinking';return s;}
  if(event.type==='void'&&s.phase==='ready'){s.eligibility='void';s.ineligibleReason=event.reason||'expired_reservation';s.phase='finished';s.outcome='draw';return s;}
  invariant(s.phase!=='ready' && s.phase!=='finished','match_not_running');
  if(event.type==='human') {
    invariant(s.human.finishMs===null && !s.human.forfeited && event.ms<s.config.timeLimitMs,'human_finished');
    s.human=applyHuman(s.human,s.givens,event.action);
    if(s.human.forfeited) s.phase='finished';
    else if(isSolved(s.human.values,s.givens)) {s.human.finishMs=event.ms;s.phase='settling';}
  } else if(event.type==='jev') {
    invariant(s.jev.finishMs===null && s.jev.status!=='stalled' && event.ms<s.config.timeLimitMs,'jev_finished');
    invariant(event.ms>=s.jev.lastActionMs+s.config.pacingMs,'jev_pacing_violation');
    if(!options.trusted) {
      const c=options.candidates||getJevCandidates(s.jev,s.config.difficulty).candidates;
      invariant(c.some(a=>a.id===event.action?.id),'jev_candidate_not_offered');
    }
    if(event.decision?.source==='jev') {
      invariant(event.decision.model===s.config.model && event.decision.actionId===event.action.id,'jev_model_or_choice_mismatch');
    }
    s.jev=applyJev(s.jev,event.action,s.config.difficulty,{trusted:options.trusted});s.jev.lastActionMs=event.ms;
    if(isSolved(s.jev.values,s.givens)) {s.jev.finishMs=event.ms;s.jev.status='finished';} else s.jev.status='thinking';
  } else if(event.type==='jev_stalled') {
    invariant(!getJevCandidates(s.jev,s.config.difficulty).candidates.length,'false_stall');s.jev.status='stalled';
  } else if(event.type==='eligibility') {
    invariant(typeof event.reason==='string' && event.reason.length<=80,'invalid_reason');
    s.eligibility='practice';s.ineligibleReason ||= event.reason;if(['provider_fallback','request_budget'].includes(event.reason))s.providerFallback=true;
  } else if(event.type==='settle') {
    invariant(s.human.finishMs!==null && event.ms>=(Math.floor(s.human.finishMs/1000)+1)*1000,'premature_settle');s.phase='finished';
  } else if(event.type==='timeout') {
    invariant(event.ms>=s.config.timeLimitMs,'premature_timeout');s.phase='finished';
  } else if(event.type==='void') {s.eligibility='void';s.ineligibleReason=event.reason || 'interrupted';s.phase='finished';}
  else throw new Error('unknown_event');
  s.outcome=raceOutcome(s);return s;
}
export function publicState(state,{reveal=false}={}) {
  const s=state, hidden=s.eligibility==='ranked' && s.phase!=='finished' && !reveal;
  return {schemaVersion:s.schemaVersion,rulesVersion:s.rulesVersion,phase:s.phase,sequence:s.sequence,elapsedMs:s.elapsedMs,
    config:s.config,givens:s.phase==='ready'?null:s.givens,eligibility:s.eligibility,ineligibleReason:s.ineligibleReason,
    outcome:s.outcome,human:s.phase==='ready'?null:{values:s.human.values,revision:s.human.revision,canUndo:!!s.human.undo.length,finishMs:s.human.finishMs,forfeited:s.human.forfeited},
    jev:s.phase==='ready'?null:{values:hidden?s.jev.values.map((d,i)=>s.givens[i] || (d?-1:0)):s.jev.values,
      filled:s.jev.values.filter(Boolean).length,revision:s.jev.revision,status:s.jev.status,finishMs:s.jev.finishMs,hidden}};
}
