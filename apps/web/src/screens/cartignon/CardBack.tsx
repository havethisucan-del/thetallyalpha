import backFrameUrl from '../../assets/cards/BackFrame.mask.svg';
import { CardTexture } from './CardTexture';
import './spellCard.css';

/**
 * The back of every face-down card (deck pile, opponent hand), user decision 2026-10-22: the
 * user's frame (`assets/cards/BackFrame.svg`, here `BackFrame.mask.svg`, an
 * optimised derivative for use as a mask: the single path converted to absolute coordinates with
 * the group translate folded in, rounded to 0.1 viewBox unit (< 0.02 px at the 240 px preview) and
 * written back as relative steps between the rounded points, metadata and colour dropped, and
 * `preserveAspectRatio="none"` added) in paper `#efe4cc` on ink `#1c1917` (the spell
 * colours inverted), stretched to an equal 4 % margin, with the shared texture and the ink edge.
 * Decorative: the surrounding control or text names what it stands for.
 */

const FRAME_MASK = `url("${backFrameUrl}")`;

export function CardBack({ className = '' }: { className?: string }) {
  return (
    <div aria-hidden="true" className={`card-back card-edge ${className}`} data-testid="card-back">
      <div
        className="card-back-frame"
        style={{ WebkitMaskImage: FRAME_MASK, maskImage: FRAME_MASK }}
      />
      <CardTexture />
    </div>
  );
}
