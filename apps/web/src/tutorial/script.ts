import type { TutorialScript } from './types';

/**
 * ADR-0018 (revision 2026-10-23): the tutorial script. One round from its start (deal, Mulligan,
 * Nullify, Base) to the round and match win, explained in the mandatory order
 * card -> game flow -> combat -> goal, within three player turns.
 *
 * The human is seat 0 (P2 of this round), the bot seat 1 (P1). Nothing is played before the
 * tutorial opens (no prelude). ATK arithmetic (default catalog, `docs/cards/*.csv`):
 *
 *   bot       Base C-G3 red L3 133 (Base Level 3)
 *   you       hand: Base Level 3 allows only orange minions at Level 1-3, and red beats orange;
 *             no violet card (violet beats red) -> Mulligan: 9 cards back, 5 drawn
 *             (C-F2, C-C2, C-D3, S-15, C-D4; the deck is ordered for it, `mulliganDraw`)
 *   you       Nullify with C-F2 violet (violet beats red): C-G3 and C-F2 to the graveyard
 *   bot       Base C-G2 red L2 32 (Base Level 2)
 *   you       Base C-C2 green L2 76 (Level <= 2, green not beaten by red)
 *             + C-D3 blue L3 64, position 1 = + buff                       = 76 + 94 = 170
 *             End Turn (ahead 170 to 32)
 *   bot       + C-B3 yellow L3 91, position 1 = + buff                      = 32 + 121 = 153
 *             + C-C4 green L4 176, position 2 = ▲ nerf on your Leader (C-B3's buff silenced)
 *             bot 32 + 91 + 176 = 299; you 76 + (64 + 30 - 30) = 140. End Turn (ahead)
 *   you       S-15 Underdog's Stand: Condition "opponent >= 125 ahead" holds (159), so the
 *             Primary: -50 on the bot's whole stack -> 249 (the Secondary, +30 on your Leader,
 *             fires only when the Condition fails; it is explained, not played)
 *             + C-D4 blue L4 177, position 2 = + buff; C-D3's buff silenced, the nerf moves to
 *             C-D4: 76 + 64 + (177 + 30 - 30) = 317 vs 249. End Turn (ahead)
 *   bot       no Level 5 in hand: End Turn while behind -> you win the round (RD-169)
 *   goal      winner's Leading minion C-D4 is blue; blue is in the supply -> awarded (RD-26).
 *             All 7 tokens are then held, 4 to 3 -> the match ends, you win (RD-24).
 *
 * Randomness: only the Mulligan shuffles. No scripted move draws (no draw or Link Up modifier
 * goes live: Bases have none, and every live symbol above is a buff or a nerf).
 */
export const TUTORIAL_SCRIPT: TutorialScript = {
  version: 1,
  // ASCII "tutorial-tally-1": the RNG state the Mulligan shuffles with.
  engineSeed: '7475746f7269616c2d74616c6c792d31',
  preset: {
    p1: 1,
    hands: [
      ['C-A1', 'C-A3', 'C-B4', 'C-E4', 'C-A4', 'C-B5', 'C-E5', 'C-G5', 'C-A5'],
      ['C-G3', 'C-G2', 'C-B3', 'C-C4', 'C-G1', 'C-B2', 'C-F1'],
    ],
    graveyard: ['C-D2', 'C-E1', 'S-10', 'C-E3'],
    tokens: { green: 0, violet: 0, red: 0, orange: 1, yellow: 1, indigo: 1 },
    roundNumber: 7,
  },
  prelude: [],
  mulliganDraw: { seat: 0, defIds: ['C-F2', 'C-C2', 'C-D3', 'S-15', 'C-D4'] },
  botMoves: [
    { type: 'playCreature', defId: 'C-G3' },
    { type: 'playCreature', defId: 'C-G2' },
    { type: 'playCreature', defId: 'C-B3' },
    { type: 'playCreature', defId: 'C-C4' },
    { type: 'endTurn' },
    { type: 'endTurn' },
  ],
  steps: [
    // 1. The card: one hand card, enlarged in place.
    {
      id: 'welcome',
      section: 'card',
      text: 'Welcome to The Tally! A new round has been dealt: your hand is at the bottom. First, how to read a card.',
      targets: ['hand'],
      gate: { kind: 'continue' },
    },
    {
      id: 'card-atk',
      section: 'card',
      text: 'This minion is from your hand. The big number is its ATK (attack). A stack’s ATK is the sum of its minions.',
      targets: ['card:C-A1'],
      zoom: { defId: 'C-A1', part: 'atk' },
      gate: { kind: 'continue' },
    },
    {
      id: 'card-level',
      section: 'card',
      text: 'LVL is its Level, 1 to 5. Stacks climb one Level at a time: 1, 2, 3 …',
      targets: ['card:C-A1'],
      zoom: { defId: 'C-A1', part: 'level' },
      gate: { kind: 'continue' },
    },
    {
      id: 'card-colour',
      section: 'card',
      text: 'The background is its colour, here orange. The ATK box shows the colour that beats it: red.',
      targets: ['card:C-A1'],
      zoom: { defId: 'C-A1', part: 'colour' },
      gate: { kind: 'continue' },
    },
    {
      id: 'card-modifiers',
      section: 'card',
      text: 'The symbols are modifiers (+ buff, ▲ nerf …). Symbol 1 works when the card is 2nd in a stack, 2 when 3rd, and only on top.',
      targets: ['card:C-A1'],
      zoom: { defId: 'C-A1', part: 'modifiers' },
      gate: { kind: 'continue' },
    },
    // 2. Game flow: Base, Mulligan, Nullify, stacking.
    {
      id: 'flow-bot-base',
      section: 'flow',
      text: 'The bot is P1 this round, so it opens: watch it place its Base minion. The Base’s Level is the Base Level.',
      targets: ['their-stack'],
      gate: { kind: 'event', match: { type: 'turnStarted', seat: 0 } },
    },
    {
      id: 'flow-mulligan',
      section: 'flow',
      text: 'Its red Base is Level 3. Your Base must be Level 3 or lower and not orange (red beats it). Nothing fits: press Mulligan.',
      // Only the button: on a phone the note can then sit at the top without covering it.
      targets: ['mulligan'],
      gate: { kind: 'command', command: { type: 'mulligan' } },
    },
    {
      id: 'flow-nullify',
      section: 'flow',
      text: 'Your hand went back into the deck and you drew half as many. Violet beats red: select your violet card and Nullify.',
      targets: ['card:C-F2', 'card-actions'],
      gate: { kind: 'command', command: { type: 'nullify', defId: 'C-F2' } },
    },
    {
      id: 'flow-bot-rebase',
      section: 'flow',
      text: 'Both cards went to the graveyard and the bot has to open again. Watch its new Base.',
      targets: ['their-stack'],
      gate: { kind: 'event', match: { type: 'turnStarted', seat: 0 } },
    },
    {
      id: 'flow-base',
      section: 'flow',
      text: 'A Level 2 Base: the Base Level is 2 now. Place your green Level 2 as your Base.',
      targets: ['card:C-C2', 'card-actions'],
      gate: { kind: 'command', command: { type: 'playCreature', defId: 'C-C2' } },
    },
    {
      id: 'flow-stack',
      section: 'flow',
      text: 'You build on your Base, exactly one Level higher each time. On a Level 2 goes a Level 3: play your blue one.',
      targets: ['card:C-D3', 'card-actions'],
      gate: { kind: 'command', command: { type: 'playCreature', defId: 'C-D3' } },
    },
    {
      id: 'flow-end-turn',
      section: 'flow',
      text: 'It is 2nd in your stack, so its symbol 1, a + buff, is live: 170 to 32. You are ahead, so End Turn is safe.',
      targets: ['end-turn', 'my-atk', 'their-atk'],
      gate: { kind: 'command', command: { type: 'endTurn' } },
    },
    // 3. Combat
    {
      id: 'combat-bot-turn',
      section: 'combat',
      text: 'The bot’s turn. Watch it stack a Level 3 and a Level 4.',
      targets: ['their-stack'],
      gate: { kind: 'event', match: { type: 'turnStarted', seat: 0 } },
    },
    {
      id: 'combat-nerf',
      section: 'combat',
      text: 'Its Oddkin is 3rd, so its ▲ nerf is live: your Leader gets −30. It leads 299 to 140. End Turn behind and you lose the round.',
      targets: ['their-stack', 'my-atk', 'their-atk'],
      gate: { kind: 'continue' },
    },
    // The spell, enlarged in place like the minion: Condition -> Primary -> Secondary, then cast.
    {
      id: 'combat-spell-condition',
      section: 'combat',
      text: 'This spell is in your hand. Its Condition is checked when you cast it: is the opponent 125 or more ahead? It is 159 ahead: yes.',
      targets: ['card:S-15'],
      zoom: { defId: 'S-15', part: 'condition' },
      gate: { kind: 'continue' },
    },
    {
      id: 'combat-spell-primary',
      section: 'combat',
      text: 'If the Condition holds, the Primary fires: the bot’s whole stack gets −50 ATK until the end of the round.',
      targets: ['card:S-15'],
      zoom: { defId: 'S-15', part: 'primary' },
      gate: { kind: 'continue' },
    },
    {
      id: 'combat-spell-secondary',
      section: 'combat',
      text: 'If it does not hold, the Secondary fires instead: your Leader gets +30 ATK until the end of the round. Only one of them fires.',
      targets: ['card:S-15'],
      zoom: { defId: 'S-15', part: 'secondary' },
      gate: { kind: 'continue' },
    },
    {
      id: 'combat-spell',
      section: 'combat',
      text: 'The Condition holds, so the Primary will fire. Select the spell and cast it.',
      targets: ['card:S-15', 'card-actions'],
      gate: { kind: 'command', command: { type: 'playSpell', defId: 'S-15' } },
    },
    {
      id: 'combat-l4',
      section: 'combat',
      text: 'The bot is down to 249. Now play your blue Level 4 on your Level 3. Several plays in one turn are fine.',
      targets: ['card:C-D4', 'card-actions'],
      gate: { kind: 'command', command: { type: 'playCreature', defId: 'C-D4' } },
    },
    {
      id: 'combat-end-turn',
      section: 'combat',
      text: 'The covered minion went silent and the nerf moved to your new Leader, yet you lead 317 to 249. End Turn.',
      targets: ['end-turn', 'my-stack', 'my-atk'],
      gate: { kind: 'command', command: { type: 'endTurn' } },
    },
    // 4. The goal
    {
      id: 'goal-bot-ends',
      section: 'goal',
      text: 'The bot has no Level 5 to stack, so it has to end its turn while behind.',
      targets: ['their-stack'],
      gate: { kind: 'event', match: { type: 'roundResolved' } },
    },
    {
      id: 'goal-round-won',
      section: 'goal',
      text: 'You win the round! The winner takes the token of its Leader’s colour, here blue, even from the opponent.',
      targets: ['token-track', 'center-strip'],
      gate: { kind: 'continue' },
    },
    {
      id: 'goal-done',
      section: 'goal',
      text: 'The match ends when all 7 tokens are held (or the deck runs low). You hold 4 of 7: you win! Have fun!',
      targets: ['token-track'],
      gate: { kind: 'continue' },
    },
  ],
};
