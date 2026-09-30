// Practice puzzles. Generating a unique-solution puzzle costs several milliseconds of CPU with a heavy tail, which does not fit the
// 10 ms Workers Free budget, so the Worker never runs the generator. It draws a puzzle that scripts/build-pool.js generated and
// verified offline (migrations/0002_practice_pool.sql) and applies a random validity-preserving symmetry transform.
import { one } from './db.js';
import { httpError } from './util.js';
export const PUZZLE_SOURCE = 'pool-transform-v1';
const random = n => { const limit = Math.floor(0x100000000 / n) * n; for (;;) { const x = crypto.getRandomValues(new Uint32Array(1))[0]; if (x < limit) return x % n; } };
const shuffle = xs => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = random(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
/**
 * Relabel digits, permute rows within bands and bands, permute columns within stacks and stacks, optionally transpose.
 * Each step maps solutions to solutions one-to-one, so a unique-solution puzzle stays a unique-solution puzzle with the
 * same clue count and the same difficulty class.
 */
export function transformPuzzle(givens, pick = random) {
  const source = [...givens].map(Number), digitMap = [0, ...shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9])];
  const order = () => shuffle([0, 1, 2]).flatMap(band => shuffle([0, 1, 2]).map(k => band * 3 + k));
  const rows = order(), cols = order(), transpose = pick(2) === 1, out = [];
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
    const [sr, sc] = transpose ? [cols[c], rows[r]] : [rows[r], cols[c]];
    out.push(digitMap[source[sr * 9 + sc]]);
  }
  return out.join('');
}
export async function practicePuzzle(env) {
  const count = (await one(env, 'SELECT COUNT(*) AS n FROM puzzle_pool')).n;
  if (!count) throw httpError(503, 'puzzle_pool_empty');
  const row = await one(env, 'SELECT givens,puzzle_hash FROM puzzle_pool ORDER BY id LIMIT 1 OFFSET ?', random(count));
  return { givens: transformPuzzle(row.givens), source: PUZZLE_SOURCE, poolHash: row.puzzle_hash };
}
