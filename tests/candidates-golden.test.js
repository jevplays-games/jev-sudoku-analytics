import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { walk, sha } from '../scripts/golden-candidates.js';
const golden = JSON.parse(readFileSync(new URL('../fixtures/candidates-golden.json', import.meta.url), 'utf8'));
// The fixture was generated from the original (pre-optimization) candidate generator. Every candidate set, feature and
// preview value along these walks must stay byte-identical, so CPU work for the Workers budget never changes behavior.
test('candidate generation is byte-identical to the pinned reference walks', () => {
  assert.equal(golden.policyVersion, 'sudoku-policy-v1');
  for (const c of golden.cases) {
    const hashes = walk(c.givens, c.difficulty, c.selector, `${c.seed}:${c.difficulty}:${c.selector}`);
    assert.equal(hashes.length, c.steps, `${c.difficulty}/${c.selector} step count`);
    assert.equal(sha(hashes), c.digest, `${c.difficulty}/${c.selector} digest`);
  }
});
