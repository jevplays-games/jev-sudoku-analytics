/** Pure Sudoku rules: no clocks, network, DOM, or random source. */
export const RULES_VERSION = 'sudoku-v1';
export const ALL = 0x1ff;
export const bit = d => 1 << (d - 1);
export const digits = mask => { const out = []; for (let d = 1; d <= 9; d++) if (mask & (1 << (d - 1))) out.push(d); return out; };
export const popcount = mask => { let n = 0; for (; mask; mask &= mask - 1) n++; return n; };
export const ROWS = Array.from({ length: 9 }, (_, r) => Array.from({ length: 9 }, (_, c) => r * 9 + c));
export const COLS = Array.from({ length: 9 }, (_, c) => Array.from({ length: 9 }, (_, r) => r * 9 + c));
export const BOXES = Array.from({ length: 9 }, (_, b) => Array.from({ length: 9 }, (_, k) =>
  (Math.floor(b / 3) * 3 + Math.floor(k / 3)) * 9 + (b % 3) * 3 + k % 3));
export const UNITS = [...ROWS, ...COLS, ...BOXES];
export const CELL_UNITS = Array.from({ length: 81 }, (_, i) => UNITS.filter(u => u.includes(i)));
export const PEERS = CELL_UNITS.map((units, i) => [...new Set(units.flat())].filter(j => i !== j).sort((a,b) => a-b));
export const label = i => `R${Math.floor(i / 9) + 1}C${i % 9 + 1}`;
export const clone = x => JSON.parse(JSON.stringify(x));
export function invariant(condition, code) { if (!condition) { const e = new Error(code); e.code = code; throw e; } }
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function parseGivens(input) {
  const a = typeof input === 'string' && /^[0-9.]{81}$/.test(input) ? [...input].map(c => c === '.' ? 0 : Number(c)) : input;
  invariant(Array.isArray(a) && a.length === 81 && a.every(d => Number.isInteger(d) && d >= 0 && d <= 9), 'invalid_grid');
  invariant(isConsistent(a), 'conflicting_givens');
  return [...a];
}
export function isConsistent(values) {
  for (const unit of UNITS) { let seen = 0;
    for (const i of unit) { const d = values[i]; if (d) { const b = 1 << (d - 1); if (seen & b) return false; seen |= b; } } }
  return true;
}
export function candidateMask(values, cell, eliminated = []) {
  if (values[cell]) return 0;
  let used = 0; for (const peer of PEERS[cell]) if (values[peer]) used |= bit(values[peer]);
  return ALL & ~used & ~(eliminated[cell] || 0);
}
export const candidateMasks = (values, eliminated = []) => values.map((_, i) => candidateMask(values, i, eliminated));
export function isSolved(values, givens = Array(81).fill(0)) {
  return Array.isArray(values) && values.length === 81 && values.every((d,i) => Number.isInteger(d) && d >= 1 && d <= 9 && (!givens[i] || givens[i] === d)) &&
    UNITS.every(unit => unit.reduce((mask,i) => mask | bit(values[i]), 0) === ALL);
}
// Flat unit table (27 units x 9 cells) so the hot loops below are plain indexed reads.
const UNIT_TABLE = Int16Array.from(UNITS.flat());
// `masks` may be supplied when the caller already holds candidateMasks(values, eliminated); the answer is identical.
// Three conditions make a board contradictory: two equal digits in a unit, an empty cell with no candidate, or a unit whose
// digits and candidates cannot cover 1-9. One pass over the 27 units checks all three (the result is their OR, so order is irrelevant).
export function isContradiction(values, eliminated = [], masks = null) {
  masks ||= candidateMasks(values, eliminated);
  for (let u = 0, k = 0; u < 27; u++) {
    let seen = 0, possible = 0;
    for (let j = 0; j < 9; j++, k++) {
      const i = UNIT_TABLE[k], d = values[i];
      if (d) { const b = 1 << (d - 1); if (seen & b) return true; seen |= b; possible |= b; }
      else { const m = masks[i]; if (!m) return true; possible |= m; }
    }
    if (possible !== ALL) return true;
  }
  return false;
}
export function validateHuman(board, givens, action) {
  invariant(action && typeof action === 'object' && !Array.isArray(action), 'invalid_action');
  invariant(['set','clear','undo','forfeit'].includes(action.kind), 'unknown_action');
  if (action.kind === 'forfeit') return true;
  if (action.kind === 'undo') { invariant(board.undo.length > 0, 'nothing_to_undo'); return true; }
  invariant(Number.isInteger(action.cell) && action.cell >= 0 && action.cell < 81, 'invalid_cell');
  invariant(!givens[action.cell], 'immutable_clue');
  if (action.kind === 'set') {
    invariant(Number.isInteger(action.digit) && action.digit >= 1 && action.digit <= 9, 'invalid_digit');
    invariant(board.values[action.cell] !== action.digit, 'no_change');
    invariant(!PEERS[action.cell].some(i => board.values[i] === action.digit), 'local_conflict');
  } else invariant(board.values[action.cell] !== 0, 'no_change');
  return true;
}
export function applyHuman(board, givens, action) {
  validateHuman(board, givens, action);
  const b = clone(board);
  if (action.kind === 'forfeit') b.forfeited = true;
  else if (action.kind === 'undo') {
    const previous = b.undo.pop(); b.values[previous.cell] = previous.previous;
  } else {
    b.undo.push({ cell: action.cell, previous: b.values[action.cell] });
    b.values[action.cell] = action.kind === 'clear' ? 0 : action.digit;
  }
  b.revision++;
  return b;
}
export function countSolutions(givens, limit = 2, nodeLimit = 1000000) {
  const values = parseGivens(givens); let count = 0, nodes = 0, first = null;
  const visit = () => {
    if (++nodes > nodeLimit) throw new Error('solver_budget_exceeded');
    let best = -1, options = null;
    for (let i = 0; i < 81; i++) if (!values[i]) {
      const ds = digits(candidateMask(values,i)); if (!ds.length) return;
      if (!options || ds.length < options.length) { best = i; options = ds; if (ds.length === 1) break; }
    }
    if (best === -1) { count++; first ||= [...values]; return; }
    for (const d of options) { values[best] = d; visit(); if (count >= limit) break; }
    values[best] = 0;
  };
  visit(); return { count, solution: first, nodes };
}
