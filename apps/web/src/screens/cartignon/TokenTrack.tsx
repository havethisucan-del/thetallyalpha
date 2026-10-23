import type { CSSProperties } from 'react';
import { tokenAriaLabel } from '../../match/cartignon/labels';
import type { Side, TokenView } from '../../match/cartignon/tableModel';
import { SWATCH_BG } from './swatch';

/**
 * The seven colour tokens as physical round tokens on the table (`.ct-token*` in table.css).
 * The tokens nobody holds lie face down (a plain dark disc, user decision 2026-10-22) on the
 * middle line as one centred, evenly spaced row in colour order, closing up (re-centring) when one
 * leaves or comes back. A won token travels into its holder's corner (own:
 * bottom-left, opponent: top-left) and flips face up there to show its colour; a stolen token
 * travels from one corner to the other. Each token is one element keyed by colour, so the move is
 * a CSS transition of its position; with reduced motion it simply appears in place. Held tokens
 * stay in the corners as a small cluster (four per row). No cells, labels or glow: the colour and
 * the corner carry it visually, the visually hidden label names colour and holder.
 * Tokens are not interactive.
 */

/** Tokens per row in a corner cluster. */
export const CORNER_COLUMNS = 4;

/**
 * CSS position and size of a token: place `place` of the `total` free tokens centred on the
 * middle line, or its slot in a corner cluster.
 */
export function tokenPlacement(
  side: Side | null,
  place: number,
  cornerIndex: number,
  total = 7,
): CSSProperties {
  if (side === null) {
    return {
      left: `calc(50% + ${place - (total - 1) / 2} * var(--tok-pitch) - var(--tok) / 2)`,
      top: 'calc(50% - var(--tok) / 2)',
      width: 'var(--tok)',
      height: 'var(--tok)',
    };
  }
  const col = cornerIndex % CORNER_COLUMNS;
  const row = Math.floor(cornerIndex / CORNER_COLUMNS);
  const left = `calc(var(--gut) + ${col} * var(--tok-c-pitch))`;
  const top =
    side === 'theirs'
      ? `calc(var(--gut) + ${row} * var(--tok-c-pitch))`
      : `calc(100% - var(--corner-mine-b) - var(--tok-c) - ${row} * var(--tok-c-pitch))`;
  return { left, top, width: 'var(--tok-c)', height: 'var(--tok-c)' };
}

/** Size of the decorative box around a corner cluster of `count` tokens. */
function cornerBox(count: number): CSSProperties {
  const cols = Math.min(count, CORNER_COLUMNS);
  const rows = Math.ceil(count / CORNER_COLUMNS);
  return {
    width: `calc(${cols} * var(--tok-c-pitch))`,
    height: `calc(${rows} * var(--tok-c-pitch))`,
  };
}

export function TokenTrack({ tokens }: { tokens: readonly TokenView[] }) {
  const corner: Record<Side, number> = { mine: 0, theirs: 0 };
  const freeCount = tokens.filter((token) => token.side === null).length;
  let free = 0;
  return (
    <>
      <ul
        aria-label="Colour tokens"
        className="ct-token-track"
        // As wide as the row of free tokens (none: no box).
        style={{
          width: freeCount === 0 ? 0 : `calc(${freeCount - 1} * var(--tok-pitch) + var(--tok))`,
        }}
        data-testid="token-track"
      >
        {tokens.map((token) => {
          const won = token.side !== null;
          const place = token.side === null ? free++ : 0;
          const cornerIndex = token.side === null ? 0 : corner[token.side]++;
          return (
            <li
              key={token.color}
              className="ct-token"
              style={tokenPlacement(token.side, place, cornerIndex, freeCount)}
              data-owner={token.side ?? 'none'}
              data-face={won ? 'up' : 'down'}
              data-testid={`token-cell-${token.color}`}
            >
              <span aria-hidden="true" className="cartignon-token">
                <span className="cartignon-token-inner" data-face={won ? 'up' : 'down'}>
                  <span className={`cartignon-token-face ${SWATCH_BG[token.color]}`} />
                  <span className="cartignon-token-face cartignon-token-back" />
                </span>
              </span>
              <span className="sr-only">{tokenAriaLabel(token)}</span>
            </li>
          );
        })}
      </ul>
      {(['theirs', 'mine'] as const).map(
        (side) =>
          corner[side] > 0 && (
            <span
              key={side}
              aria-hidden="true"
              className="ct-token-corner"
              style={cornerBox(corner[side])}
              data-side={side}
              data-testid={`${side}-tokens`}
            />
          ),
      )}
    </>
  );
}
