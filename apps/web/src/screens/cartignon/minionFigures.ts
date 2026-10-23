import type { MinionFigure } from '../../match/cartignon/minionArt';
import morrowLines from '../../assets/cards/Morrow_Blacklines.svg';
import morrowFill from '../../assets/cards/Morrow_Blackout.svg';
import oddkinLines from '../../assets/cards/Oddkin_Blacklines.svg';
import oddkinFill from '../../assets/cards/Oddkin_Blackout.svg';
import rootletLines from '../../assets/cards/Rootlet_Blacklines.svg';
import rootletFill from '../../assets/cards/Rootlet_Blackout.svg';
import sirEckLines from '../../assets/cards/SirEck_Blacklines.svg';
import sirEckFill from '../../assets/cards/SirEck_Blackout.svg';
import willowLines from '../../assets/cards/Willow_Blacklines.svg';
import willowFill from '../../assets/cards/Willow_Blackout.svg';

/**
 * Bundled URLs of the minion figures (copies of `assets/cards/*`; Vite fingerprints them).
 * `lines` = black line art drawn as an image, `fill` = solid silhouette used as a CSS mask.
 */
export const FIGURE_URLS: Readonly<Record<MinionFigure, { lines: string; fill: string }>> = {
  Rootlet: { lines: rootletLines, fill: rootletFill },
  Willow: { lines: willowLines, fill: willowFill },
  Morrow: { lines: morrowLines, fill: morrowFill },
  Oddkin: { lines: oddkinLines, fill: oddkinFill },
  SirEck: { lines: sirEckLines, fill: sirEckFill },
};
