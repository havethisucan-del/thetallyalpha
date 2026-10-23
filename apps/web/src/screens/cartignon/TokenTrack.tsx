import { tokenAriaLabel, tokenOwnerText } from '../../match/cartignon/labels';
import type { TokenView } from '../../match/cartignon/tableModel';
import { SWATCH_BG } from './swatch';

/**
 * The seven colour tokens on a "colour line": one horizontal strip of seven contiguous square
 * cells, each filled with its colour (`--cartignon-color-*`, so a palette switch applies), with
 * each token lying centred on its own cell like a board field. The cell shows around the token, so
 * the colours still in play stay visible while tokens lie face-down. The strip is drawn with the
 * ink line: one outer outline (a decorative overlay, so the dark-theme halo stays outside the
 * strip) and ink dividers between the cells.
 *
 * A face-up token shows only its colour (user decision 2026-10-22: no letter or shape glyph;
 * colour-blind support will be a separate palette toggle); its colour is named in the visually
 * hidden label. A token nobody has won yet lies face-down: a plain dark disc (user decision
 * 2026-10-22). When a seat wins it, it flips face-up (CSS 3D transition on the same element, keyed
 * by colour, so a token that was already won when the table mounted simply shows face-up). Tokens
 * the viewing player holds glow: a round amber halo that pulses slowly, unlike the static
 * rectangular rings used on cards (selected / Leading / focus). With reduced motion there is no
 * flip and no pulse, only the static end state. The owner is always also written under the cell
 * (You / Opp / Free), so neither the face nor the glow is the only cue. Tokens are not interactive
 * (no touch target needed).
 * Styles: `.cartignon-token*` in index.css.
 */
export function TokenTrack({ tokens }: { tokens: readonly TokenView[] }) {
  return (
    <div className="relative mx-auto w-full max-w-[22rem]">
      <ul aria-label="Colour tokens" className="grid w-full grid-cols-7" data-testid="token-track">
        {tokens.map((token) => {
          const won = token.side !== null;
          const mine = token.side === 'mine';
          return (
            <li
              key={token.color}
              className="group flex min-w-0 flex-col items-center gap-1"
              data-owner={token.side ?? 'none'}
              data-face={won ? 'up' : 'down'}
            >
              <span
                aria-hidden="true"
                className={`flex aspect-square w-full items-center justify-center border-l-(length:--line-width) border-line group-first:rounded-l-md group-first:border-l-0 group-last:rounded-r-md ${SWATCH_BG[token.color]}`}
                data-testid={`token-cell-${token.color}`}
              >
                <span className={`cartignon-token ${mine ? 'cartignon-token-mine' : ''}`}>
                  <span className="cartignon-token-inner" data-face={won ? 'up' : 'down'}>
                    <span className={`cartignon-token-face ${SWATCH_BG[token.color]}`} />
                    <span className="cartignon-token-face cartignon-token-back" />
                  </span>
                </span>
              </span>
              <span
                aria-hidden="true"
                className={`text-xs leading-none ${
                  mine ? 'font-bold text-ink' : 'font-semibold text-ink-muted'
                }`}
              >
                {tokenOwnerText(token.side)}
              </span>
              <span className="sr-only">{tokenAriaLabel(token)}</span>
            </li>
          );
        })}
      </ul>
      {/* Outer outline of the cell strip: seven square cells, so the strip is 7:1. Painted over
          the cell edges but under the tokens (z-index 1), so the viewer's glow stays on top. */}
      <span
        aria-hidden="true"
        className="ink-line pointer-events-none absolute inset-x-0 top-0 aspect-[7/1] rounded-md"
      />
    </div>
  );
}
