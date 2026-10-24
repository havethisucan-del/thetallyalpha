/**
 * Shared class strings on the manuscript tokens (index.css): paper surfaces, the one ink line
 * (`ink-line`, with the dark-theme paper halo) and the turn accent.
 */
const base =
  'ink-line inline-flex min-h-11 items-center justify-center rounded-md px-4 py-2 text-lg ' +
  'leading-none tracking-wide transition-colors disabled:cursor-not-allowed disabled:opacity-50';

export const buttonClass = {
  primary: `${base} bg-turn text-on-turn hover:bg-turn-hover disabled:hover:bg-turn`,
  secondary:
    `${base} bg-paper-raised text-ink hover:bg-paper-sunken ` + 'disabled:hover:bg-paper-raised',
} as const;

export const cardClass = 'ink-line rounded-lg bg-paper-raised p-4 text-ink';

export const inputClass =
  'ink-line min-h-11 w-full rounded-md bg-paper-raised px-3 py-2 text-xl uppercase ' +
  'tracking-widest text-ink placeholder:text-ink-muted';

/**
 * Manuscript option row around a radio input (bot level, settings): an ink-lined paper slip; the
 * checked one is filled and gets a turn-coloured margin bar (never colour alone: see the marker).
 */
export const optionRowClass =
  'ink-line flex min-h-12 cursor-pointer items-center gap-3 rounded-md ' +
  'bg-paper py-1.5 pr-3 pl-4 transition-colors hover:bg-paper-sunken ' +
  'has-checked:border-l-[6px] has-checked:border-l-turn has-checked:bg-paper-sunken ' +
  'has-checked:pl-3 ' +
  'has-focus-visible:outline-2 has-focus-visible:outline-offset-2 ' +
  'has-focus-visible:outline-focus';

/** Custom radio marker for `optionRowClass`: ink ring; checked = turn fill inside a paper gap. */
export const radioMarkerClass =
  'size-5 shrink-0 cursor-pointer appearance-none rounded-full border-2 ' +
  'border-ink bg-paper-raised checked:border-turn checked:bg-turn ' +
  'checked:shadow-[inset_0_0_0_3px_var(--color-paper-raised)] focus-visible:outline-none';

export const alertClass =
  'rounded-md border-l-4 border-rubric bg-rubric-surface px-3 py-2 text-base text-rubric';

/** Secondary text on any paper surface (>= 5.8:1 in both themes). */
export const mutedTextClass = 'text-ink-muted';
