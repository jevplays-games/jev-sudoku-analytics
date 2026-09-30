/** Versioned analytics derived from authoritative events; browser observations remain separate. */
import { createMatchState, advanceState } from './match.js';
export const ANALYTICS_VERSION='analytics-v1';
export function distribution(values) {
  const a=values.filter(Number.isFinite).sort((x,y)=>x-y), n=a.length;
  if(!n) return {n:0,min:null,max:null,mean:null,median:null,p90:null,p95:null,p99:null,stddev:null};
  const q=p=>{const i=(n-1)*p,l=Math.floor(i);return a[l]+(a[Math.ceil(i)]-a[l])*(i-l);};
  const mean=a.reduce((x,y)=>x+y,0)/n;
  return {n,min:a[0],max:a[n-1],mean,median:q(.5),p90:q(.9),p95:q(.95),p99:q(.99),stddev:Math.sqrt(a.reduce((s,x)=>s+(x-mean)**2,0)/n)};
}
export function entropy(probabilities) { return Object.values(probabilities||{}).reduce((s,p)=>p>0?s-p*Math.log2(p):s,0); }
const countBy=(items,key)=>items.reduce((o,x)=>{const k=typeof key==='function'?key(x):x[key];o[k]=(o[k]||0)+1;return o;},{});
const sum=(xs,key)=>xs.reduce((n,x)=>n+(Number.isFinite(x[key])?x[key]:0),0);
/** The client-reported section of a report. Exported so retention and consent withdrawal can rebuild it alone. */
export function browserSection(client) {
  const browserCounts=countBy(client,'name');
  const dwell=Array(81).fill(0);for(const t of client.filter(t=>t.name==='cell_focus')) if(Number.isInteger(t.properties.cell)) dwell[t.properties.cell]+=t.properties.durationMs||0;
  return {trust:'client-reported; optional; never used for scoring',events:client.length,eventCounts:browserCounts,
      focusDwellMsByCell:dwell,focusDwellMs:dwell.reduce((a,b)=>a+b,0),notesAdded:browserCounts.note_added||0,notesRemoved:browserCounts.note_removed||0,
      hiddenMs:sum(client.filter(t=>t.name==='visibility').map(t=>t.properties),'hiddenMs'),
      inputSources:countBy(client.filter(t=>t.name==='input_method'),t=>t.properties.method),
      actionRttMs:distribution(client.filter(t=>t.name==='action_rtt').map(t=>t.properties.durationMs)),
      longTasksMs:distribution(client.filter(t=>t.name==='long_task').map(t=>t.properties.durationMs)),
      reconnects:browserCounts.reconnect||0,localConflicts:browserCounts.local_conflict||0};
}
export function analyzeMatch(initial,events,telemetry=[],options={}) {
  let s=createMatchState(initial.givens,initial.config);
  const startEmpty=s.givens.filter(x=>!x).length, initialFilled=81-startEmpty;
  const human={acceptedActions:0,placements:0,replacements:0,clears:0,undos:0,forfeits:0,firstActionMs:null,
    cellEdits:Array(81).fill(0),rowEdits:Array(9).fill(0),columnEdits:Array(9).fill(0),boxEdits:Array(9).fill(0)};
  const times=[],decisions=[],timeline=[{ms:0,human:0,jev:0,lead:0}], intervals=[];
  let lastTime=null, peakBranchDepth=0;
  for(const e of events) {
    const before=s;
    s=advanceState(s,e,{trusted:!!options.trusted});
    if(e.type==='human') {
      human.acceptedActions++; human.firstActionMs ??= e.ms;
      if(lastTime!==null) intervals.push(e.ms-lastTime);lastTime=e.ms;times.push(e.ms);
      let cell=e.action.cell;
      if(e.action.kind==='set') before.human.values[cell]?human.replacements++:human.placements++;
      if(e.action.kind==='clear') human.clears++;
      if(e.action.kind==='undo') {human.undos++;cell=before.human.undo.at(-1)?.cell;}
      if(e.action.kind==='forfeit') human.forfeits++;
      if(Number.isInteger(cell)) {human.cellEdits[cell]++;human.rowEdits[Math.floor(cell/9)]++;human.columnEdits[cell%9]++;human.boxEdits[Math.floor(cell/27)*3+Math.floor(cell%9/3)]++;}
    }
    if(e.type==='jev') {
      const d=e.decision||{};const ps=Object.values(d.probabilities||{}).sort((a,b)=>b-a);
      decisions.push({sequence:e.sequence,ms:e.ms,source:d.source||'unknown',model:d.model||null,
        actionId:e.action.id,kind:e.action.kind,technique:e.action.proof?.technique||'unknown',cell:e.action.cell??null,digit:e.action.digit??null,
        candidates:d.candidateCount??null,rawCandidates:d.rawCandidateCount??null,pruned:d.prunedCount??null,
        confidence:d.confidence??null,selectedProbability:d.probabilities?.[e.action.id]??null,
        entropyBits:d.probabilities?entropy(d.probabilities):null,topTwoMargin:ps.length>1?ps[0]-ps[1]:ps.length?1:null,
        inferenceMs:d.latencyMs??null,preprocessingMs:d.preprocessingMs??null,pacingWaitMs:d.pacingWaitMs??null,
        previewSteps:d.previewSteps??null,branchDepth:s.jev.branches.length,probabilities:d.probabilities||null,
        proof:e.action.proof,candidateEvidence:d.candidateEvidence||null});
      peakBranchDepth=Math.max(peakBranchDepth,s.jev.branches.length);
    }
    if(['human','jev','start','timeout','settle','void'].includes(e.type)) {
      const h=s.human.values.filter(Boolean).length-initialFilled,j=s.jev.values.filter(Boolean).length-initialFilled;
      timeline.push({ms:e.ms,human:h,jev:j,lead:h-j});
    }
  }
  const elapsed=options.elapsedMs??s.elapsedMs, terminal=s.phase==='finished';
  const durations={humanLeadMs:0,jevLeadMs:0,tiedProgressMs:0};let changes=0,previousSign=0;
  for(let i=0;i<timeline.length;i++) {
    const p=timeline[i],next=timeline[i+1]?.ms??elapsed,delta=Math.max(0,next-p.ms);
    durations[p.lead>0?'humanLeadMs':p.lead<0?'jevLeadMs':'tiedProgressMs']+=delta;
    const sign=Math.sign(p.lead);if(sign&&previousSign&&sign!==previousSign) changes++;if(sign) previousSign=sign;
  }
  const server=telemetry.filter(t=>t.trust==='server'), client=telemetry.filter(t=>t.trust==='client');
  const requests=server.filter(t=>t.name==='jev_request_finished').map(t=>t.properties), rejections=server.filter(t=>t.name==='action_rejected');
  const usageKnown=requests.filter(r=>Number.isFinite(r.inputTokens)), inputTokens=sum(usageKnown,'inputTokens'), outputTokens=sum(requests,'outputTokens');
  const costRate=options.inputUsdPerMillion??null, outputRate=options.outputUsdPerMillion??null;
  const hasCost=Number.isFinite(costRate)&&Number.isFinite(outputRate)&&usageKnown.length===requests.length&&requests.every(r=>Number.isFinite(r.outputTokens))&&requests.length>0;
  const localConflicts=rejections.filter(t=>t.properties.reason==='local_conflict').length;
  const completed=s.human.finishMs!==null, filled=s.human.values.filter(Boolean).length-initialFilled;
  return {schemaVersion:ANALYTICS_VERSION,computedThroughMs:elapsed,complete:terminal,
    dimensions:{difficulty:s.config.difficulty,puzzleBand:s.config.puzzleBand||'standard-v1',mode:s.config.mode,
      policyVersion:s.config.policyVersion,model:s.config.model,rulesVersion:s.rulesVersion},
    game:{phase:s.phase,outcome:s.outcome,eligibility:s.eligibility,ineligibleReason:s.ineligibleReason,initialClues:initialFilled,initialEmpty:startEmpty,
      durationMs:elapsed,humanFinishMs:s.human.finishMs,jevFinishMs:s.jev.finishMs,humanCompleted:completed,
      completionFraction:filled/startEmpty,raceDeltaMs:s.human.finishMs!==null&&s.jev.finishMs!==null?s.human.finishMs-s.jev.finishMs:null,
      ...durations,progressLeadChanges:changes,maxHumanProgressLead:Math.max(...timeline.map(p=>p.lead)),maxJevProgressLead:Math.max(...timeline.map(p=>-p.lead))},
    human:{...human,filledEditableCells:filled,distinctCellsEdited:human.cellEdits.filter(Boolean).length,
      repeatedCellEdits:human.cellEdits.reduce((n,x)=>n+Math.max(0,x-1),0),moveIntervalsMs:distribution(intervals),
      actionsPerMinute:elapsed>0?human.acceptedActions/(elapsed/60000):null,
      editEfficiency:completed?startEmpty/Math.max(startEmpty,human.acceptedActions):null,
      acceptedActionRate:human.acceptedActions+rejections.length?human.acceptedActions/(human.acceptedActions+rejections.length):null,
      rejectedRequests:rejections.length,rejectionsByReason:countBy(rejections,t=>t.properties.reason),localConflictRejections:localConflicts,
      rejectionsAreNotSolutionErrors:true},
    jev:{appliedActions:decisions.length,decisionSources:countBy(decisions,'source'),techniques:countBy(decisions,'technique'),
      actionKinds:countBy(decisions,'kind'),peakBranchDepth,assumptions:decisions.filter(d=>d.kind==='assume').length,
      backtracks:decisions.filter(d=>d.kind==='backtrack').length,forcedActions:decisions.filter(d=>d.source==='forced').length,
      heuristicActions:decisions.filter(d=>d.source==='heuristic').length,fallbackActions:decisions.filter(d=>d.source==='heuristic_fallback').length,
      modelDecisions:decisions.filter(d=>d.source==='jev').length,models:countBy(decisions.filter(d=>d.model),'model'),
      candidateCount:distribution(decisions.map(d=>d.candidates)),rawCandidateCount:distribution(decisions.map(d=>d.rawCandidates)),
      prunedCandidates:sum(decisions,'pruned'),previewSteps:sum(decisions,'previewSteps'),
      confidence:distribution(decisions.map(d=>d.confidence)),entropyBits:distribution(decisions.map(d=>d.entropyBits)),
      topTwoMargin:distribution(decisions.map(d=>d.topTwoMargin)),preprocessingMs:distribution(decisions.map(d=>d.preprocessingMs)),
      inferenceMs:distribution(decisions.map(d=>d.inferenceMs)),pacingWaitMs:distribution(decisions.map(d=>d.pacingWaitMs)),
      requestCount:requests.length,requestOutcomes:countBy(requests,'outcome'),requestLatencyMs:distribution(requests.map(r=>r.latencyMs)),
      requestErrorRate:requests.length?requests.filter(r=>r.outcome!=='ok').length/requests.length:null,
      inputTokens,outputTokens,requestsWithUsage:usageKnown.length,requestsWithoutUsage:requests.length-usageKnown.length,requestsWithoutOutputUsage:requests.filter(r=>!Number.isFinite(r.outputTokens)).length,
      estimatedCostUsd:hasCost?(inputTokens*costRate+outputTokens*outputRate)/1e6:null,costIsEstimate:true,
      costRatesUsdPerMillion:{input:costRate,output:outputRate},decisions},
    browser:browserSection(client),timeline,
    caveats:['Progress counts filled cells, not correctness.','Confidence is distribution concentration, not calibrated Sudoku accuracy.',
      'Human move intervals include thinking, inactivity, and network transit.','Client telemetry is opt-in, incomplete, and forgeable.',
      'Unknown costs and empty denominators are null, not zero.']};
}
export function redactAnalytics(report,hideAnswers) {
  if(!hideAnswers) return report; // nothing to strip; callers treat reports as read-only, so no copy is needed
  const r=structuredClone(report);
  r.jev.decisions=r.jev.decisions.map(({actionId,cell,digit,proof,probabilities,candidateEvidence,...safe})=>safe);
  return r;
}
export function aggregateReports(reports) {
  const finished=reports.filter(r=>r.complete),validFinished=finished.filter(r=>r.game.eligibility!=='void'),completed=validFinished.filter(r=>r.game.humanCompleted),ranked=validFinished.filter(r=>r.game.eligibility==='ranked');
  const wins=validFinished.filter(r=>r.game.outcome==='human').length,losses=validFinished.filter(r=>r.game.outcome==='jev').length,draws=validFinished.filter(r=>r.game.outcome==='draw').length;
  const perDifficulty={};for(const d of ['easy','normal','hard','jev']) {
    const rs=reports.filter(r=>r.dimensions.difficulty===d);perDifficulty[d]={games:rs.length,completed:rs.filter(r=>r.game.humanCompleted).length,
      humanFinishMs:distribution(rs.filter(r=>r.game.humanCompleted).map(r=>r.game.humanFinishMs))};
  }
  let current=0,best=0;for(const r of validFinished) {current=r.game.outcome==='human'?current+1:0;best=Math.max(best,current);}
  return {schemaVersion:ANALYTICS_VERSION,games:reports.length,finished:finished.length,inProgress:reports.length-finished.length,
    completed:completed.length,validFinished:validFinished.length,voided:finished.length-validFinished.length,wins,losses,draws,winRate:validFinished.length?wins/validFinished.length:null,
    completionRate:validFinished.length?completed.length/validFinished.length:null,currentWinStreak:current,bestWinStreak:best,
    rankedResults:ranked.length,practiceResults:finished.filter(r=>r.game.eligibility==='practice').length,
    humanFinishMs:distribution(completed.map(r=>r.game.humanFinishMs)),actions:sum(reports.map(r=>r.human),'acceptedActions'),
    jevRequests:sum(reports.map(r=>r.jev),'requestCount'),jevInputTokens:sum(reports.map(r=>r.jev),'inputTokens'),
    jevOutputTokens:sum(reports.map(r=>r.jev),'outputTokens'),perDifficulty,
    crossPuzzleTimeComparisons:'Descriptive only; not a normalized ranking.'};
}
/** RFC 4180-style CSV plus spreadsheet formula-injection protection. */
export function toCsv(rows,columns) {
  const escape=v=>{let text=v===null||v===undefined?'':String(v);if(/^[=+\-@\t\r]/.test(text)) text="'"+text;return '"'+text.replaceAll('"','""')+'"';};
  return [columns.map(escape).join(','),...rows.map(row=>columns.map(k=>escape(row[k])).join(','))].join('\r\n')+'\r\n';
}
