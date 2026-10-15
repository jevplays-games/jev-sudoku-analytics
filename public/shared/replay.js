import { createMatchState, advanceState } from './match.js';
import { RULES_VERSION, canonical, invariant } from './sudoku.js';
export const REPLAY_VERSION=1;
// A storage format, not a product name: replays keep this identifier so files exported before the Typedoku rename stay valid and
// hash-identical. 'jev-typedoku-replay' is accepted as well, so a later switch of the written value needs no reader change.
export const REPLAY_FORMAT='jev-sudoku-replay';
export const REPLAY_FORMATS=[REPLAY_FORMAT,'jev-typedoku-replay'];
export function replayEvents(replay) {
  invariant(replay && REPLAY_FORMATS.includes(replay.format) && replay.formatVersion===REPLAY_VERSION,'unsupported_replay');
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
  return {format:REPLAY_FORMAT,formatVersion:REPLAY_VERSION,rulesVersion:RULES_VERSION,initial,events,finalState};
}
