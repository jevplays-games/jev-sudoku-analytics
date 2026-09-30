// Runs once when the Worker module is evaluated (Cloudflare's startup phase, which is not billed against a request's 10 ms CPU limit).
// V8 compiles functions lazily and starts in its slowest tier, so the first opponent-decision computation in a fresh isolate costs
// several times what a warm one does. Exercising the hot pure paths here, on a fixed board, moves that one-time cost out of the first
// player's request. It is pure computation: no I/O, no clock, no randomness (so it is allowed in global scope), and it produces
// nothing that is stored or returned.
import { createMatchState, advanceState } from '../public/shared/match.js';
import { getJevCandidates, heuristicChoice, PROFILES } from '../public/shared/sudoku-ai.js';
const WARMUP_PUZZLE = '000000907000420180000705026100904000050000040000507009920108000034059000507000000';
export function warmUp(rounds = 2) {
  try {
    for (let round = 0; round < rounds; round++) for (const difficulty of Object.keys(PROFILES)) {
      let state = advanceState(createMatchState(WARMUP_PUZZLE, { difficulty, pacingMs: 0 }), { type: 'start', ms: 0 });
      for (let step = 1; step <= 6; step++) {
        const bundle = getJevCandidates(state.jev, difficulty); if (!bundle.candidates.length) break;
        state = advanceState(state, { type: 'jev', ms: step, action: heuristicChoice(bundle.candidates), decision: { source: 'heuristic' } }, { candidates: bundle.candidates });
        JSON.stringify(bundle.candidates);
      }
    }
    return true;
  } catch { return false; }
}
warmUp();
