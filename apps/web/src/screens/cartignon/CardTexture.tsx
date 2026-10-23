import { TEXTURE_LAYERS } from '../../match/cartignon/minionArt';
import './cardFace.css';

/**
 * The calibrated paper texture shared by every card face (minion, spell, back): four soft-light
 * grey-noise layers (`TEXTURE_LAYERS`), so the mean colour stays on its token. Decorative.
 */
export function CardTexture() {
  return (
    <>
      {TEXTURE_LAYERS.map((layer, index) => (
        <div
          key={layer}
          aria-hidden="true"
          className={`card-tex card-tex-${index}`}
          style={{ backgroundImage: layer }}
        />
      ))}
    </>
  );
}
