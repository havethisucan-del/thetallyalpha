import type { TutorialScript } from './types';

/**
 * ADR-0018: the tutorial script (user requirements 2026-10-23): one battle already in progress,
 * explained in the mandatory order card -> game flow -> combat -> goal, within two player turns.
 *
 * The human is seat 0 (P2 of this round), the bot seat 1 (P1). The prelude is played with real
 * commands before the tutorial opens. ATK arithmetic (default catalog, `docs/cards/*.csv`):
 *
 *   prelude   bot  C-G2 red L2 32 (Base)                                     = 32
 *             you  C-B1 yellow L1 22 (Base) + C-C2 green L2 76, + buff live  = 22 + 106 = 128
 *             bot  + C-B3 yellow L3 91, + buff live (position 1)             = 32 + 121 = 153
 *   start     you 128 vs bot 153 (behind)
 *   you       + C-F3 violet L3 88, position 2 = + buff (C-C2's buff silenced) = 22+76+118 = 216
 *             End Turn (ahead)
 *   bot       + C-C4 green L4 176, position 2 = ▲ nerf on your Leader (C-B3's buff silenced)
 *             bot 32+91+176 = 299; you 22+76+(88+30-30) = 186
 *   you       S-15 Underdog's Stand: Condition "opponent >= 125 ahead" fails (113), so the
 *             Secondary: +30 on your Leader (C-F3) -> 216
 *             + C-D4 blue L4 177, position 3 = no modifier; C-F3's buff silenced, the nerf moves
 *             to C-D4: 22 + 76 + (88+30) + (177-30) = 363 vs 299. End Turn (ahead)
 *   bot       no Level 5 in hand: End Turn while behind -> you win the round (RD-169)
 *   goal      winner's Leading minion C-D4 is blue; blue is in the supply -> awarded (RD-26).
 *             All 7 tokens are then held, 4 to 3 -> the match ends, you win (RD-24).
 *
 * No scripted move draws a card or uses randomness (no draw or Link Up modifier goes live).
 */
export const TUTORIAL_SCRIPT: TutorialScript = {
  version: 1,
  // ASCII "tutorial-tally-1"; the scripted moves never draw from the RNG.
  engineSeed: '7475746f7269616c2d74616c6c792d31',
  preset: {
    p1: 1,
    hands: [
      ['C-B1', 'C-C2', 'C-F3', 'S-15', 'C-D4', 'C-A5', 'C-E2'],
      ['C-G2', 'C-B3', 'C-C4', 'C-G1', 'C-A2'],
    ],
    graveyard: ['C-D2', 'C-E4', 'S-10', 'C-F1'],
    tokens: { green: 0, violet: 0, red: 0, orange: 1, yellow: 1, indigo: 1 },
    roundNumber: 7,
  },
  prelude: [
    { seat: 1, command: { type: 'playCreature', defId: 'C-G2' } },
    { seat: 0, command: { type: 'playCreature', defId: 'C-B1' } },
    { seat: 0, command: { type: 'playCreature', defId: 'C-C2' } },
    { seat: 0, command: { type: 'endTurn' } },
    { seat: 1, command: { type: 'playCreature', defId: 'C-B3' } },
    { seat: 1, command: { type: 'endTurn' } },
  ],
  botMoves: [{ type: 'playCreature', defId: 'C-C4' }, { type: 'endTurn' }, { type: 'endTurn' }],
  steps: [
    // 1. The card
    {
      id: 'welcome',
      section: 'card',
      text: 'Welcome to The Tally! A battle is under way: your stack is at the bottom, the bot’s at the top. First, how to read a card.',
      targets: ['my-stack', 'their-stack'],
      gate: { kind: 'continue' },
    },
    {
      id: 'card-atk',
      section: 'card',
      text: 'This is a minion from your hand. The big number is its ATK (attack). A stack’s ATK is the sum of all its minions.',
      targets: ['card:C-F3'],
      anatomy: { defId: 'C-F3', focus: 'atk' },
      gate: { kind: 'continue' },
    },
    {
      id: 'card-level',
      section: 'card',
      text: 'LVL is its Level, 1 to 5. Each Level has its own figure and name: Rootlet, Willow, Morrow, Oddkin and Sir Eck.',
      anatomy: { defId: 'C-F3', focus: 'level' },
      gate: { kind: 'continue' },
    },
    {
      id: 'card-colour',
      section: 'card',
      text: 'The background is its colour. The ATK box shows the colour that beats it; the figure is filled with the colour it beats.',
      anatomy: { defId: 'C-F3', focus: 'colour' },
      gate: { kind: 'continue' },
    },
    {
      id: 'card-modifiers',
      section: 'card',
      text: 'Symbols are modifiers: ▲ nerf (enemy Leader −30), + buff (itself +30), ✱ Link Up, ● draw from graveyard, ■ draw from deck.',
      anatomy: { defId: 'C-F3', focus: 'modifiers' },
      gate: { kind: 'continue' },
    },
    {
      id: 'card-positions',
      section: 'card',
      text: 'Symbol 1 counts when the card is 2nd in a stack, symbol 2 when it is 3rd, and so on. The Base at the bottom has none.',
      anatomy: { defId: 'C-F3', focus: 'modifiers' },
      gate: { kind: 'continue' },
    },
    {
      id: 'card-leading',
      section: 'card',
      text: 'Only the top card, the Leading minion, has an active modifier: its symbols are solid. Everywhere else they are hollow.',
      targets: ['my-stack'],
      anatomy: { defId: 'C-F3', focus: 'leading', leading: true },
      gate: { kind: 'continue' },
    },
    {
      id: 'card-spell',
      section: 'card',
      text: 'This is a spell. If its Condition is met when you cast it, the Primary effect fires; otherwise the Secondary does.',
      targets: ['card:S-15'],
      anatomy: { defId: 'S-15', focus: 'spell' },
      gate: { kind: 'continue' },
    },
    // 2. Game flow
    {
      id: 'flow-turns',
      section: 'flow',
      text: 'Players take turns. A round starts with Base minions: the bot placed its Base first, then you answered with yours.',
      targets: ['turn-banner', 'their-stack'],
      gate: { kind: 'continue' },
    },
    {
      id: 'flow-stacking',
      section: 'flow',
      text: 'On your turn you stack minions on your Base. Each new one must be exactly one Level above your Leading minion.',
      targets: ['my-stack'],
      gate: { kind: 'continue' },
    },
    {
      id: 'flow-play',
      section: 'flow',
      text: 'Your Leader is a Level 2 Willow, so a Level 3 fits. Select your violet Morrow and play it.',
      targets: ['card:C-F3', 'card-actions'],
      gate: { kind: 'command', command: { type: 'playCreature', defId: 'C-F3' } },
    },
    {
      id: 'flow-end-turn',
      section: 'flow',
      text: 'You may play several cards in a turn. When you are done, press End Turn. You are ahead now, so it is safe.',
      targets: ['end-turn'],
      gate: { kind: 'command', command: { type: 'endTurn' } },
    },
    // 3. Combat
    {
      id: 'combat-bot-turn',
      section: 'combat',
      text: 'The bot’s turn. Watch it stack a Level 4 minion on its Level 3.',
      targets: ['their-stack'],
      gate: { kind: 'event', match: { type: 'turnStarted', seat: 0 } },
    },
    {
      id: 'combat-nerf',
      section: 'combat',
      text: 'Its green Oddkin is 3rd in its stack, so its ▲ nerf is active: your Leader gets −30. Its covered minion went silent.',
      targets: ['their-stack', 'card:C-C4'],
      gate: { kind: 'continue' },
    },
    {
      id: 'combat-totals',
      section: 'combat',
      text: 'ATK is the sum of a stack: the bot has 299, you 186. End your turn while behind and you lose the round.',
      targets: ['my-atk', 'their-atk'],
      gate: { kind: 'continue' },
    },
    {
      id: 'combat-spell',
      section: 'combat',
      text: 'Cast Underdog’s Stand. The bot is not 125 ahead, so the Condition fails and the Secondary gives your Leader +30.',
      targets: ['card:S-15', 'card-actions'],
      gate: { kind: 'command', command: { type: 'playSpell', defId: 'S-15' } },
    },
    {
      id: 'combat-l4',
      section: 'combat',
      text: 'You have 216 now. Play your blue Oddkin (Level 4) on top of your Morrow. Several plays in one turn are fine.',
      targets: ['card:C-D4', 'card-actions'],
      gate: { kind: 'command', command: { type: 'playCreature', defId: 'C-D4' } },
    },
    {
      id: 'combat-silenced',
      section: 'combat',
      text: 'Your Morrow is covered, so its buff is silenced. The nerf now hits your new Leader, but you lead 363 to 299.',
      targets: ['my-stack', 'my-atk'],
      gate: { kind: 'continue' },
    },
    {
      id: 'combat-end-turn',
      section: 'combat',
      text: 'You are ahead, so End Turn is safe. Press it.',
      targets: ['end-turn'],
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
      text: 'Ending behind loses: you win the round! The winner takes the token of its Leading minion’s colour, here blue.',
      targets: ['token-track', 'center-strip'],
      gate: { kind: 'continue' },
    },
    {
      id: 'goal-steal',
      section: 'goal',
      text: 'Blue was still free. A token the opponent holds is stolen from them; one you already hold simply stays yours.',
      targets: ['token-track'],
      gate: { kind: 'continue' },
    },
    {
      id: 'goal-match',
      section: 'goal',
      text: 'The match ends when all 7 tokens are held, or after a last round once the deck runs low. Most tokens wins.',
      targets: ['token-track', 'piles'],
      gate: { kind: 'continue' },
    },
    {
      id: 'goal-done',
      section: 'goal',
      text: 'All 7 tokens are held now and you have 4 of them: you win the match! That is all you need. Have fun!',
      targets: ['token-track'],
      gate: { kind: 'continue' },
    },
  ],
};
