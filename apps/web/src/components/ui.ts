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

export const alertClass =
  'rounded-md border-l-4 border-rubric bg-rubric-surface px-3 py-2 text-base text-rubric';

/** Secondary text on any paper surface (>= 5.8:1 in both themes). */
export const mutedTextClass = 'text-ink-muted';
