/* JEV Arcade shared header behaviour. Zero dependencies, no build step.
   Wires the overflow sheet: open/close, scrim, Escape, focus return, and a
   focus trap while open. Games import this once; everything else is CSS. */

const sheet = document.getElementById('jv-sheet');
const scrim = document.getElementById('jv-scrim');
const button = document.getElementById('jv-menu');
let lastFocus = null;

function focusables() {
  return sheet ? [...sheet.querySelectorAll('button,a[href],select,input,[tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.disabled && el.offsetParent !== null) : [];
}

export function closeSheet() {
  if (!sheet || !sheet.classList.contains('is-open')) return;
  sheet.classList.remove('is-open');
  scrim?.classList.remove('is-open');
  button?.setAttribute('aria-expanded', 'false');
  lastFocus?.focus();
  lastFocus = null;
}

export function openSheet() {
  if (!sheet) return;
  lastFocus = document.activeElement;
  sheet.classList.add('is-open');
  scrim?.classList.add('is-open');
  button?.setAttribute('aria-expanded', 'true');
  focusables()[0]?.focus();
}

button?.addEventListener('click', () => {
  sheet?.classList.contains('is-open') ? closeSheet() : openSheet();
});
scrim?.addEventListener('click', closeSheet);

/* Any action inside the sheet dismisses it, so a tap never leaves it covering the board. */
sheet?.addEventListener('click', (event) => {
  if (event.target.closest('.jv-sheet-item')) closeSheet();
});

document.addEventListener('keydown', (event) => {
  if (!sheet?.classList.contains('is-open')) return;
  if (event.key === 'Escape') { event.preventDefault(); closeSheet(); return; }
  if (event.key !== 'Tab') return;
  const items = focusables();
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});

/* The sheet only exists below 900px; if the viewport grows past it while open,
   its contents are already visible inline, so drop the overlay. */
matchMedia('(min-width:900px)').addEventListener('change', (event) => {
  if (event.matches) closeSheet();
});
