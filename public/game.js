import { validateHuman,PEERS,label,bit,clone } from '/shared/sudoku.js';
import { createMatchState,advanceState,publicState } from '/shared/match.js';
import { getJevCandidates,heuristicChoice } from '/shared/sudoku-ai.js';
import { makeReplay,replayEvents } from '/shared/replay.js';
import { analyzeMatch,toCsv } from '/shared/analytics.js';
import { el,fmt,pct,time,table,renderMatchAnalytics,renderProfile,renderOperator } from '/analytics-ui.js';
const $=id=>document.getElementById(id),uuid=()=>crypto.randomUUID();
let me=null,current=null,selected=0,noteMode=false,difficulty='jev',notes=Array(81).fill(0),stream=null,busy=false,currentView='play';
let stateReceived=performance.now(),report=null,telemetry=[],focusStart=performance.now(),hiddenAt=null,leaderboardCursor=null;
let local=null,localEvents=[],localInitial=null,localTimer=null,localStarted=0,replay=null,replayMode=false,reportMatchId=null;
const storage={get:(key,fallback=null)=>{try{const value=localStorage.getItem(key);return value===null?fallback:JSON.parse(value);}catch{return fallback;}},set:(key,value)=>{try{localStorage.setItem(key,JSON.stringify(value));}catch{}},remove:key=>{try{localStorage.removeItem(key);}catch{}}};
function notice(text,error=false){$('notice').hidden=!text;$('notice').textContent=text||'';if(error)$('live-announcement').textContent=text;}
const messages={discord_not_configured:'Discord sign-in is not configured on this host. Practice remains available.',ranked_requires_jev:'Ranked games require a configured live JEV service.',discord_login_required:'Sign in with Discord to start an official daily attempt.',
 daily_challenge_not_published:'The operator has not published today’s challenge for this difficulty.',official_attempt_already_used:'Your official attempt for this difficulty and UTC day has already been used.',
 local_conflict:'That digit conflicts with a row, column, or box.',immutable_clue:'Starting clues cannot be changed.',no_change:'That cell already has this value.',nothing_to_undo:'There is nothing to undo.',
 stale_human_revision:'The board changed in another tab. Your latest server board has been restored.',fresh_discord_context_required:'Open a fresh personal link from /jev sudoku in the relevant Discord channel.',
 csrf_rejected:'Your session changed. Reload the page before making another move.',match_not_running:'This attempt is no longer running.',human_finished:'Your attempt is already complete or expired.',
 new_game_rate_limit:'The practice creation limit has been reached. Continue your current game or retry after the hourly window.',
 launch_wrong_user:'This launch link belongs to another Discord user. Run /jev sudoku yourself.',
 launch_already_used_or_expired:'This personal launch link is expired or already used. Run /jev sudoku again.'};
function friendly(e){return messages[e.message]||e.message?.replaceAll('_',' ')||'The request could not be completed.';}
async function api(path,{method='GET',body}={}){
  const response=await fetch(path,{method,credentials:'same-origin',cache:'no-store',headers:body!==undefined?{'Content-Type':'application/json','X-CSRF-Token':me?.csrfToken||''}:{},body:body===undefined?undefined:JSON.stringify(body)});
  let value;try{value=await response.json();}catch{throw new Error('invalid_server_response');}
  if(!response.ok){const e=new Error(value.error||`http_${response.status}`);e.status=response.status;throw e;}return value;
}
function record(name,properties={}){if(!me?.telemetryConsent||local||!current?.id)return;if(telemetry.length<200)telemetry.push({id:uuid(),name,properties});}
async function flushTelemetry(){if(!telemetry.length||!current?.id||local)return;const batch=telemetry.splice(0,50);try{await api(`/api/matches/${current.id}/telemetry`,{method:'POST',body:{events:batch}});}catch{/* Optional observations never block play or retry forever. */}}
function saveNotes(){if(current?.id)storage.set(`jev-notes:${current.id}`,notes);}
function focusCell(i,{focus=true}={}){
  if(i<0||i>80)return;record('cell_focus',{cell:selected,durationMs:Math.min(60000,Math.max(0,performance.now()-focusStart))});focusStart=performance.now();selected=i;
  updateSelection();if(focus)$('human-board').querySelector(`[data-cell="${i}"]`)?.focus();
}
function updateSelection(){const board=current?.human?.values||Array(81).fill(0),value=board[selected];
  for(const cell of $('human-board').querySelectorAll('.cell')){const i=Number(cell.dataset.cell);cell.classList.toggle('selected',i===selected);cell.classList.toggle('peer',PEERS[selected].includes(i)&&i!==selected);cell.classList.toggle('same-value',!!value&&board[i]===value&&i!==selected);cell.tabIndex=i===selected?0:-1;cell.setAttribute('aria-selected',String(i===selected));}
  $('selection-label').textContent=current?.givens?.[selected]?`${label(selected)} · fixed clue ${current.givens[selected]}`:`${label(selected)} · ${noteMode?'pencil marks':'digit entry'} · ${board[selected]||'empty'}`;
}
function buildBoards(){for(const [id,human]of [['human-board',true],['jev-board',false]]){
  const container=$(id);container.replaceChildren();for(let r=0;r<9;r++){const row=el('div','board-row');row.setAttribute('role','row');row.setAttribute('aria-rowindex',String(r+1));for(let c=0;c<9;c++){
    const i=r*9+c,cell=el(human?'button':'div','cell');cell.dataset.cell=String(i);if(human){cell.type='button';cell.tabIndex=i===0?0:-1;cell.addEventListener('click',()=>focusCell(i,{focus:false}));cell.addEventListener('focus',()=>{if(selected!==i)focusCell(i,{focus:false});});}
    cell.setAttribute('role','gridcell');cell.setAttribute('aria-colindex',String(c+1));if(c===2||c===5)cell.classList.add('box-right');if(r===2||r===5)cell.classList.add('box-bottom');if(c===8)cell.classList.add('end-column');if(r===8)cell.classList.add('end-row');row.append(cell);
  }container.append(row);}}}
function paintBoard(id,values,givens,human){for(const cell of $(id).querySelectorAll('.cell')){
  const i=Number(cell.dataset.cell),v=values?.[i]||0,given=!!givens?.[i];cell.classList.toggle('given',given);cell.classList.toggle('concealed',v===-1);cell.replaceChildren();
  if(v)cell.textContent=v===-1?'●':String(v);
  else if(human&&notes[i]){const grid=el('span','notes-grid');for(let d=1;d<=9;d++)grid.append(el('span',null,notes[i]&bit(d)?d:''));cell.append(grid);}
  const noteList=human&&!v?Array.from({length:9},(_,d)=>d+1).filter(d=>notes[i]&bit(d)).join(', '):'';
  cell.setAttribute('aria-label',`${label(i)}, ${v===-1?'opponent cell filled; digit concealed':given?`fixed clue ${v}`:v?`digit ${v}`:'empty'}${noteList?`, notes ${noteList}`:''}`);
  if(human)cell.setAttribute('aria-readonly',String(given||!current||current.phase==='finished'||replayMode));
}}
function elapsed(){if(local)return local.phase==='finished'?local.elapsedMs:Math.floor(performance.now()-localStarted);if(!current)return 0;return current.elapsedMs+(['running','settling'].includes(current.phase)?performance.now()-stateReceived:0);}
function render(){
  const p=current;paintBoard('human-board',p?.human?.values,p?.givens,true);paintBoard('jev-board',p?.jev?.values,p?.givens,false);updateSelection();
  const clueCount=p?.givens?.filter(Boolean).length||0,empty=p?.givens?81-clueCount:0;
  const h=p?.human?.values?.filter(Boolean).length-clueCount||0,j=(p?.jev?.filled??0)-clueCount||0;
  for(const [prefix,count]of [['human',h],['jev',j]]){$(`${prefix}-progress`).textContent=`${Math.max(0,count)} / ${empty} cells`;$(`${prefix}-percent`).textContent=empty?`${Math.round(count/empty*100)}%`:'0%';$(`${prefix}-progressbar`).value=empty?count/empty*100:0;}
  $('timer').textContent=time(elapsed());$('phase-label').textContent=replayMode?'REPLAY':p?.phase==='running'?'RACE IN PROGRESS':p?.phase==='settling'?'CHECKING FINISH':p?.phase==='finished'?'DUEL COMPLETE':'READY TO PLAY';
  $('eligibility-label').textContent=p?.eligibility==='ranked'?'Daily ranked':p?.eligibility==='void'?'Void':'Practice';
  $('puzzle-caption').textContent=p?.givens?`${clueCount} clues · ${p.config.difficulty.toUpperCase()} · ${p.config.puzzleBand||'standard'}`:'Classic 9 × 9 · one correct solution';
  const opponent=p?.opponent||(me?.capabilities?.jev?'JEV':'Local heuristic');$('opponent-name').textContent=opponent;
  $('opponent-badge').textContent=opponent==='JEV'?'STRUCTURED AI':'HEURISTIC';
  $('opponent-subtitle').textContent=p?.jev?.hidden?'Your opponent’s digits stay concealed.':opponent==='JEV'?'Structured decisions. Validated moves.':'Practice opponent · not a live JEV model';
  $('jev-status').textContent={thinking:'Evaluating candidates',ready:'Decision ready · pacing',finished:'Grid completed',stalled:'No available deduction',readyToPlay:'Awaiting a puzzle'}[p?.jev?.status||'readyToPlay']||'Awaiting a puzzle';
  const d=p?.decision;$('jev-candidates').textContent=fmt(d?.candidateCount,0);$('jev-confidence').textContent=pct(d?.confidence);$('jev-latency').textContent=d?.latencyMs===null||d?.latencyMs===undefined?'—':`${fmt(d.latencyMs,0)} ms`;
  $('jev-technique').textContent=d?.technique?.replaceAll('_',' ')||'—';$('decision-note').textContent=d?.source?`Source: ${d.source.replaceAll('_',' ')}. Confidence is not Sudoku accuracy.`:'Model confidence is not a measure of Sudoku accuracy.';
  const editable=p&&['running','settling'].includes(p.phase)&&p.human?.finishMs===null&&!replayMode;
  $('give-up').disabled=!editable;$('erase').disabled=!editable||busy;$('undo').disabled=!editable||!p.human?.canUndo||busy;$('notes').disabled=!editable;
  for(const button of document.querySelectorAll('[data-digit]'))button.disabled=!editable||busy;
  $('reveal').hidden=!(p?.eligibility==='ranked'&&p.phase!=='finished'&&p.phase!=='ready');
  $('replay-button').disabled=!p||p.phase!=='finished'||replayMode;
  $('result-banner').hidden=true;
  if(p?.phase==='finished'){
    $('result-banner').hidden=false;
    const label=p.eligibility==='void'?'Attempt voided':p.outcome==='human'?'You won the duel':p.outcome==='draw'?'The duel ended in a draw':`${opponent} won the duel`;
    $('result-banner').textContent=`${label}. ${p.human?.finishMs!==null?`Your time: ${time(p.human.finishMs)}. `:''}${p.eligibility==='ranked'?'Server-verified ranked result.':`Unranked ${p.eligibility==='void'?'void':'practice'} result.`}`;
  }else if(p?.jev?.finishMs!==null&&p?.jev?.finishMs!==undefined&&p?.human?.finishMs===null){$('result-banner').hidden=false;$('result-banner').textContent=`${opponent} finished first. Complete your board to record your solve time.`;}
  if(p?.opponent==='Heuristic fallback')notice('JEV is unavailable. This game is continuing against the heuristic and will not count toward ranked results.');
}
function acceptState(p){if(replayMode)return;if(current&&current.id===p.id&&p.sequence<current.sequence)return;current=p;stateReceived=performance.now();storage.set('jev-current',p.id);if(p.givens)storage.set('jev-practice-copy',{givens:p.givens,human:p.human?.values,difficulty:p.config.difficulty});render();}
function connectStream(id){stream?.close();stream=new EventSource(`/api/matches/${id}/events`);let opened=false;
  stream.addEventListener('state',e=>{try{if(!local)acceptState(JSON.parse(e.data));}catch{notice('An invalid live update was ignored. Reload to resynchronize.');}});
  stream.onopen=()=>{$('connection-label').textContent='Connected';$('offline-button').hidden=true;if(opened)record('reconnect');opened=true;};
  stream.onerror=()=>{if(local)return;$('connection-label').textContent='Reconnecting';$('offline-button').hidden=!current?.givens;};
}
async function resume(id){const p=await api(`/api/matches/${id}`);reportMatchId=id;notes=storage.get(`jev-notes:${id}`,Array(81).fill(0));if(!Array.isArray(notes)||notes.length!==81)notes=Array(81).fill(0);acceptState(p);
  if(p.phase==='ready'){acceptState(await api(`/api/matches/${id}/start`,{method:'POST',body:{}}));}connectStream(id);
}
async function startGame(){if(busy)return;if(current&&['running','settling'].includes(current.phase)&&!confirm('End your current attempt and start a new duel? An official attempt remains used.'))return;
  busy=true;$('new-game').disabled=true;notice('');
  try{
    if(current&&['running','settling'].includes(current.phase)){if(local){localApply({type:'human',action:{kind:'forfeit'}});}else if(current.human.finishMs===null)await api(`/api/matches/${current.id}/actions`,{method:'POST',body:{requestId:uuid(),expectedHumanRevision:current.human.revision,action:{kind:'forfeit'}}});else throw new Error('Wait for your current finish bucket to close.');}
    await flushTelemetry();local=null;clearInterval(localTimer);replayMode=false;$('replay-controls').hidden=true;stream?.close();
    const p=await api('/api/matches',{method:'POST',body:{requestId:uuid(),difficulty,mode:$('mode').value}});current=p;notes=Array(81).fill(0);reportMatchId=p.id;acceptState(p);
    for(const count of [3,2,1]){$('new-game').textContent=String(count);await new Promise(resolve=>setTimeout(resolve,450));}
    acceptState(await api(`/api/matches/${p.id}/start`,{method:'POST',body:{}}));connectStream(p.id);focusCell(current.givens.findIndex(v=>!v));
    if(!me.capabilities.jev)notice('Live JEV is not configured. This duel uses the local heuristic and is unranked.');
  }catch(e){if(e.message.startsWith('active_match_exists:')){await resume(e.message.split(':')[1]);notice('Your existing active attempt has been restored.');}else notice(friendly(e),true);}
  finally{busy=false;$('new-game').disabled=false;$('new-game').replaceChildren(document.createTextNode('Start new duel '),el('span',null,'↗'));render();}
}
async function perform(action,method='keyboard'){
  if(!current||busy||replayMode||!['running','settling'].includes(current.phase)||current.human?.finishMs!==null)return;
  try{validateHuman({values:current.human.values,undo:current.human.canUndo?[{}]:[]},current.givens,action);}catch(e){if(e.message==='local_conflict')record('local_conflict',{cell:action.cell});notice(friendly(e),true);return;}
  record('input_method',{method});busy=true;const started=performance.now();render();
  try{
    if(local)localApply({type:'human',action});else{
      const p=await api(`/api/matches/${current.id}/actions`,{method:'POST',body:{requestId:uuid(),expectedHumanRevision:current.human.revision,action}});acceptState(p);
      record('action_rtt',{durationMs:Math.min(120000,performance.now()-started)});
    }
    if(action.kind==='set'){notes[action.cell]=0;saveNotes();}notice('');
  }catch(e){notice(friendly(e),true);if(e.message==='stale_human_revision')acceptState(await api(`/api/matches/${current.id}`));if(!e.status){$('connection-label').textContent='Offline';$('offline-button').hidden=false;}}
  finally{busy=false;render();}
}
function digit(d,method='keyboard'){if(!current||replayMode||!['running','settling'].includes(current.phase)||current.human.finishMs!==null)return;
  if(noteMode&&!current.givens[selected]&&!current.human.values[selected]){const removing=!!(notes[selected]&bit(d));notes[selected]^=bit(d);record(removing?'note_removed':'note_added',{cell:selected});saveNotes();render();}else perform({kind:'set',cell:selected,digit:d},method);
}
function toggleNotes(){noteMode=!noteMode;$('notes').setAttribute('aria-pressed',String(noteMode));updateSelection();}
function showView(view){currentView=view;for(const panel of document.querySelectorAll('.view'))panel.hidden=panel.id!==`view-${view}`;for(const button of document.querySelectorAll('[data-view]'))button.classList.toggle('active',button.dataset.view===view);
  if(view==='analytics'){record('analysis_opened');loadAnalytics();}if(view==='leaderboards')loadLeaderboard();if(view==='profile')loadProfile();}
async function loadAnalytics(){try{if(local){report=analyzeMatch(localInitial,localEvents,[],{elapsedMs:elapsed()});}else if(reportMatchId||current?.id)report=await api(`/api/matches/${reportMatchId||current.id}/analytics`);else report=null;renderMatchAnalytics($('analytics-content'),report);}catch(e){$('analytics-content').replaceChildren(el('div','empty-state',friendly(e)));}}
function download(name,content,type='application/json'){const blob=new Blob([content],{type}),url=URL.createObjectURL(blob),a=el('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
async function loadLeaderboard(next=false){try{const p=new URLSearchParams({scope:$('leaderboard-scope').value,date:$('leaderboard-date').value,difficulty:$('leaderboard-difficulty').value});if(next&&leaderboardCursor)p.set('cursor',leaderboardCursor);
  const data=await api(`/api/leaderboard?${p}`);leaderboardCursor=data.nextCursor;$('leaderboard-next').hidden=!leaderboardCursor;
  $('leaderboard-content').replaceChildren(data.entries.length?table(['Rank','Player','Human time','Race winner'],data.entries.map(r=>[r.rank,r.display_name,time(r.seconds*1000),r.winner==='human'?'Human':r.winner==='jev'?'JEV':'Draw'])):el('div','empty-state',data.published?'No eligible completions yet.':'No challenge has been published for this date and difficulty.'));
  }catch(e){$('leaderboard-content').replaceChildren(el('div','empty-state',friendly(e)));$('leaderboard-next').hidden=true;}}
async function loadProfile(){try{const data=await api('/api/analytics/me');renderProfile($('profile-content'),data,id=>{reportMatchId=id;showView('analytics');});}catch(e){$('profile-content').replaceChildren(el('div','empty-state',friendly(e)));}}
function localApply(event){const e={...event,ms:Math.max(local.elapsedMs,Math.floor(performance.now()-localStarted)),sequence:local.sequence+1};local=advanceState(local,e);localEvents.push(e);current={...publicState(local),id:'offline',opponent:'Local heuristic',verified:false};stateReceived=performance.now();render();}
function beginOffline(){const copy=current?.givens?{givens:current.givens,human:current.human.values,difficulty:current.config.difficulty}:storage.get('jev-practice-copy');
  if(!copy?.givens){notice('There is no loaded puzzle to continue offline.');return;}
  if(!confirm('Create a separate unranked offline copy? Your existing server attempt keeps its original clock. The local opponent restarts from the givens.'))return;
  const oldId=current?.id;if(oldId&&oldId!=='offline')storage.set('jev-downgrade-on-connect',oldId);
  stream?.close();localStarted=performance.now();local=createMatchState(copy.givens,{difficulty:copy.difficulty,mode:'practice',pacingMs:8000,puzzleBand:'offline-copy'});localInitial={givens:copy.givens,config:local.config};localEvents=[];
  const start={type:'start',ms:0,sequence:1};local=advanceState(local,start);localEvents.push(start);
  for(let i=0;i<81;i++)if(!copy.givens[i]&&copy.human?.[i]>0)localApply({type:'human',action:{kind:'set',cell:i,digit:copy.human[i]}});
  current={...publicState(local),id:'offline',opponent:'Local heuristic',verified:false};$('connection-label').textContent='Offline copy';$('offline-button').hidden=true;notice('Separate offline practice copy. The opponent restarted from the givens. This copy cannot submit an official result.');render();
  clearInterval(localTimer);localTimer=setInterval(()=>{
    if(!local||local.phase==='finished')return;const ms=Math.floor(performance.now()-localStarted);
    if(ms>=local.config.timeLimitMs){localApply({type:'timeout'});return;}
    if(local.human.finishMs!==null&&ms>=(Math.floor(local.human.finishMs/1000)+1)*1000){localApply({type:'settle'});return;}
    if(local.jev.finishMs!==null||local.jev.status==='stalled'||ms<local.jev.lastActionMs+local.config.pacingMs)return;
    const bundle=getJevCandidates(local.jev,local.config.difficulty);if(!bundle.candidates.length){localApply({type:'jev_stalled'});return;}
    const a=heuristicChoice(bundle.candidates);localApply({type:'jev',action:a,decision:{source:'heuristic',model:null,actionId:a.id,candidateCount:bundle.candidates.length,rawCandidateCount:bundle.rawCount,prunedCount:bundle.prunedCount,previewSteps:bundle.previewSteps,latencyMs:0}});
  },250);
}
function openReplay(data){replayEvents(data);replay=data;replayMode=true;stream?.close();$('replay-controls').hidden=false;$('replay-slider').max=String(data.events.length);$('replay-slider').value=String(data.events.length);showView('play');scrubReplay(data.events.length);record('replay_opened');}
function scrubReplay(n){const part={...replay,events:replay.events.slice(0,n),finalState:undefined};const state=replayEvents(part);current={...publicState(state,{reveal:true}),id:'replay',opponent:'Recorded opponent',verified:false};notes=Array(81).fill(0);$('replay-position').textContent=`${n} / ${replay.events.length}`;stateReceived=performance.now();render();$('timer').textContent=time(state.elapsedMs);}
async function boot(){buildBoards();render();$('leaderboard-date').value=new Date().toISOString().slice(0,10);
  difficulty=storage.get('jev-difficulty','jev');if(!['easy','normal','hard','jev'].includes(difficulty))difficulty='jev';setDifficulty(difficulty);
  const fragment=new URLSearchParams(location.hash.slice(1));if(fragment.has('launch')){sessionStorage.setItem('jev-launch',fragment.get('launch'));history.replaceState(null,'',location.pathname);}
  if(fragment.has('login')){notice(fragment.get('login')==='success'?'Signed in with Discord.':'Discord sign-in could not be completed. Practice remains available.');history.replaceState(null,'',location.pathname);}
  try{
    me=await api('/api/me');$('connection-label').textContent='Connected';$('identity-label').textContent=me.user?.display_name||'Guest session';$('login').hidden=!!me.user;$('logout').hidden=!me.user;$('telemetry-consent').checked=me.telemetryConsent;$('operator-section').hidden=!me.admin;
    if(!me.capabilities.discord){$('login').textContent='Discord not configured';$('login').setAttribute('aria-disabled','true');$('login').addEventListener('click',e=>{e.preventDefault();notice(messages.discord_not_configured);});}
    const launch=sessionStorage.getItem('jev-launch');if(launch&&me.user){try{await api('/api/context',{method:'POST',body:{launch}});me=await api('/api/me');notice('Verified Discord channel context attached to this session.');sessionStorage.removeItem('jev-launch');}catch(e){notice(friendly(e));sessionStorage.removeItem('jev-launch');}}
    else if(launch)notice('This personal Discord launch is ready. Sign in with the account that invoked /jev sudoku.');
    const downgrade=storage.get('jev-downgrade-on-connect');if(downgrade){try{await api(`/api/matches/${downgrade}/reveal`,{method:'POST',body:{}});storage.remove('jev-downgrade-on-connect');}catch{}}
    const last=me.activeMatch?.id||storage.get('jev-current');if(last&&last!=='offline'&&last!=='replay'){try{await resume(last);}catch{storage.remove('jev-current');}}
    if(!current)render();
  }catch(e){$('connection-label').textContent='Offline';$('offline-button').hidden=!storage.get('jev-practice-copy');notice('The server is unreachable. An already loaded puzzle can be continued as an offline practice copy.');}
  await autoStart();
}
/* Auto-start: the puzzle is playable as soon as the page is, with no click.
   It returns early when an attempt is already running, because boot() has just
   resumed me.activeMatch -- so a reload rejoins the attempt instead of
   forfeiting it, and startGame()'s "an official attempt remains used" confirm
   can never be triggered by a page load.
   Ranked needs a signed-in account AND the ranked capability, the same gate the
   player faces by hand. Anything less starts practice, so a page load can never
   spend the one daily ranked attempt on its own. */
async function autoStart(){
  if(busy||(current&&['running','settling'].includes(current.phase)))return;
  $('mode').value=me?.user&&me?.capabilities?.jev?'ranked':'practice';
  await startGame();
}
function setDifficulty(d){difficulty=d;storage.set('jev-difficulty',d);for(const b of document.querySelectorAll('[data-difficulty]')){b.classList.toggle('selected',b.dataset.difficulty===d);b.setAttribute('aria-pressed',String(b.dataset.difficulty===d));}}
for(const b of document.querySelectorAll('[data-view]'))b.addEventListener('click',()=>showView(b.dataset.view));
for(const b of document.querySelectorAll('[data-difficulty]'))b.addEventListener('click',()=>setDifficulty(b.dataset.difficulty));
for(const b of document.querySelectorAll('[data-digit]'))b.addEventListener('click',e=>digit(Number(b.dataset.digit),e.pointerType==='touch'?'touch':'mouse'));
$('new-game').addEventListener('click',startGame);$('notes').addEventListener('click',toggleNotes);$('erase').addEventListener('click',()=>perform({kind:'clear',cell:selected},'mouse'));$('undo').addEventListener('click',()=>perform({kind:'undo'},'mouse'));
$('human-board').addEventListener('keydown',e=>{const arrows={ArrowLeft:-1,ArrowRight:1,ArrowUp:-9,ArrowDown:9};
  if(Object.hasOwn(arrows,e.key)){e.preventDefault();focusCell(Math.max(0,Math.min(80,selected+arrows[e.key])));return;}
  if(/^[1-9]$/.test(e.key)){e.preventDefault();digit(Number(e.key));}else if(e.key.toLowerCase()==='n'){e.preventDefault();toggleNotes();}else if(['Delete','Backspace'].includes(e.key)){e.preventDefault();perform({kind:'clear',cell:selected});}else if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'){e.preventDefault();perform({kind:'undo'});}
});
$('give-up').addEventListener('click',()=>{if(confirm('Give up this attempt? A ranked attempt remains used.'))perform({kind:'forfeit'},'mouse');});
$('analysis-button').addEventListener('click',()=>{reportMatchId=current?.id;showView('analytics');});$('refresh-analytics').addEventListener('click',loadAnalytics);
for(const id of ['rules-button','rules-footer'])$(id).addEventListener('click',()=>{$('rules-dialog').showModal();record('rules_opened');});$('close-rules').addEventListener('click',()=>$('rules-dialog').close());
$('reveal').addEventListener('click',async()=>{if(!confirm('Reveal the opponent’s answers? This irreversibly makes the official attempt practice.'))return;try{acceptState(await api(`/api/matches/${current.id}/reveal`,{method:'POST',body:{}}));notice('Answers revealed. This attempt is now unranked practice.');}catch(e){notice(friendly(e));}});
$('load-leaderboard').addEventListener('click',()=>loadLeaderboard(false));$('leaderboard-next').addEventListener('click',()=>loadLeaderboard(true));
$('export-json').addEventListener('click',async()=>{await loadAnalytics();if(report){record('export_requested',{format:'json'});download(`sudoku-analytics-${current?.id||'match'}.json`,JSON.stringify(report,null,2));}});
$('export-csv').addEventListener('click',async()=>{await loadAnalytics();if(report){record('export_requested',{format:'csv'});download('sudoku-decision-analytics.csv',toCsv(report.jev.decisions,['sequence','ms','source','model','kind','technique','candidates','confidence','entropyBits','topTwoMargin','inferenceMs','preprocessingMs','pacingWaitMs','branchDepth']),'text/csv');}});
$('telemetry-consent').addEventListener('change',async e=>{try{const data=await api('/api/privacy',{method:'POST',body:{telemetryConsent:e.target.checked}});me.telemetryConsent=data.telemetryConsent;if(!data.telemetryConsent)telemetry=[];}catch(err){e.target.checked=!e.target.checked;notice(friendly(err));}});
$('logout').addEventListener('click',async()=>{try{await api('/api/logout',{method:'POST',body:{}});location.reload();}catch(e){notice(friendly(e));}});
$('export-account').addEventListener('click',async()=>{try{download('jev-sudoku-my-data.json',JSON.stringify(await api('/api/me/export'),null,2));}catch(e){notice(friendly(e));}});
$('delete-account').addEventListener('click',async()=>{const confirmation=prompt('This permanently deletes your stored games, results, and optional telemetry. Type DELETE MY DATA to continue.');if(confirmation!=='DELETE MY DATA')return;
  try{await api('/api/me/data',{method:'DELETE',body:{confirm:confirmation}});storage.remove('jev-current');location.reload();}catch(e){notice(friendly(e));}});
$('operator-load').addEventListener('click',async()=>{try{renderOperator($('operator-content'),await api('/api/analytics/operator?days=30'));}catch(e){notice(friendly(e));}});
$('offline-button').addEventListener('click',beginOffline);
$('replay-button').addEventListener('click',async()=>{try{const data=local?makeReplay(localInitial,localEvents,local):await api(`/api/matches/${current.id}/replay`);openReplay(data);}catch(e){notice(friendly(e));}});
$('replay-slider').addEventListener('input',e=>scrubReplay(Number(e.target.value)));
$('exit-replay').addEventListener('click',async()=>{replayMode=false;replay=null;$('replay-controls').hidden=true;const id=storage.get('jev-current');if(local){current={...publicState(local),id:'offline',opponent:'Local heuristic',verified:false};render();}else if(id&&id!=='replay')await resume(id);else{current=null;render();}});
$('import-replay').addEventListener('change',async e=>{const file=e.target.files[0];if(!file)return;if(file.size>10*1024*1024){notice('Replay files must be smaller than 10 MB.');return;}try{openReplay(JSON.parse(await file.text()));}catch(err){notice(`Replay rejected: ${friendly(err)}`);}});
window.addEventListener('online',async()=>{if(local){notice('Connection restored. This offline copy remains practice.');const id=storage.get('jev-downgrade-on-connect');if(id&&me)try{await api(`/api/matches/${id}/reveal`,{method:'POST',body:{}});storage.remove('jev-downgrade-on-connect');}catch{}}});
document.addEventListener('visibilitychange',()=>{if(document.hidden){hiddenAt=performance.now();flushTelemetry();}else if(hiddenAt!==null){record('visibility',{hiddenMs:Math.min(3600000,performance.now()-hiddenAt)});hiddenAt=null;}});
try{new PerformanceObserver(list=>{for(const e of list.getEntries())record('long_task',{durationMs:Math.min(120000,e.duration)});}).observe({type:'longtask',buffered:true});}catch{/* Unsupported browsers do not synthesize observations. */}
setInterval(()=>{if(!replayMode)$('timer').textContent=time(elapsed());},250);setInterval(flushTelemetry,5000);
boot();
