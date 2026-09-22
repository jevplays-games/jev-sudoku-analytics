import { createMatchState, advanceState } from './match.js';
import { RULES_VERSION, canonical, invariant } from './sudoku.js';
export const REPLAY_VERSION=1;
export function replayEvents(replay) {
  invariant(replay && replay.format==='jev-sudoku-replay' && replay.formatVersion===REPLAY_VERSION,'unsupported_replay');
  invariant(replay.rulesVersion===RULES_VERSION,'unsupported_rules');
  invariant(Array.isArray(replay.events) && replay.events.length<=20000,'invalid_events');
  let state=createMatchState(replay.initial.givens,replay.initial.config);
  for(let i=0;i<replay.events.length;i++) {
    invariant(replay.events[i].sequence===i+1,'event_sequence_mismatch');
    state=advanceState(state,replay.events[i]);
  }
  if(replay.finalState) invariant(canonical(state)===canonical(replay.finalState),'final_state_mismatch');
  return state;
}
export function makeReplay(initial,events,finalState) {
  return {format:'jev-sudoku-replay',formatVersion:REPLAY_VERSION,rulesVersion:RULES_VERSION,initial,events,finalState};
}
