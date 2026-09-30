// Regenerates fixtures/candidates-golden.json: hashes of getJevCandidates() along seeded walks.
// The fixture pins the candidate generator's exact output so performance work cannot silently change behavior.
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { generatePuzzle, rng } from './puzzle-lib.js';
import { createMatchState, advanceState } from '../public/shared/match.js';
import { getJevCandidates, PROFILES } from '../public/shared/sudoku-ai.js';
import { canonical } from '../public/shared/sudoku.js';
export const sha = x => createHash('sha256').update(canonical(x)).digest('hex');
export function walk(givens, difficulty, selector, seed, maxSteps = 140) {
  let state = advanceState(createMatchState(givens, { difficulty, pacingMs: 0 }), { type: 'start', ms: 0 });
  const random = rng(seed), hashes = [];
  for (let step = 1; step <= maxSteps; step++) {
    const bundle = getJevCandidates(state.jev, difficulty);
    hashes.push(sha(bundle));
    if (!bundle.candidates.length) break;
    const pick = selector === 'random' ? bundle.candidates[Math.floor(random() * bundle.candidates.length)] : bundle.candidates[0];
    state = advanceState(state, { type: 'jev', ms: step, action: pick, decision: { source: 'heuristic' } });
    if (state.jev.finishMs !== null) break;
  }
  return hashes;
}
export function buildGolden() {
  const cases = [];
  for (let i = 0; i < 4; i++) {
    const seed = `golden:${i}`, puzzle = generatePuzzle(seed);
    for (const difficulty of Object.keys(PROFILES)) for (const selector of ['canonical', 'random']) {
      const hashes = walk(puzzle.givens, difficulty, selector, `${seed}:${difficulty}:${selector}`);
      cases.push({ seed, difficulty, selector, givens: puzzle.givens, steps: hashes.length, digest: sha(hashes) });
    }
  }
  return { format: 'candidate-golden-v1', policyVersion: 'sudoku-policy-v1', cases };
}
if (process.argv[1] === new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') || process.argv[1]?.endsWith('golden-candidates.js')) {
  const golden = buildGolden();
  mkdirSync('fixtures', { recursive: true });
  writeFileSync('fixtures/candidates-golden.json', JSON.stringify(golden, null, 2) + '\n');
  console.log(`Wrote ${golden.cases.length} cases`);
}
