import type { RulesSection } from './rulesTypes';

/**
 * The player-facing rulebook (Deck screen, Rules tab). Plain text only; see `rulesTypes.ts`.
 * Source of truth: `docs/rules-decisions.md` (RD-xx) and the engine in
 * `packages/game-core/src/cartignon/`. When a rule changes there, update the matching block here.
 */
export const RULES: readonly RulesSection[] = [
  {
    id: 'overview',
    title: 'Overview',
    blocks: [
      {
        kind: 'p',
        text: 'The Tally is a card game for two players. Both play from one shared deck of 54 cards: 35 minions and 19 spells.',
      },
      {
        kind: 'p',
        text: 'A match is played in rounds. In each round both players build a stack of minions. The stack with more ATK wins the round, and the winner takes a colour token.',
      },
      {
        kind: 'list',
        items: [
          'There are 7 tokens, one per colour.',
          'The match ends when all 7 tokens are held by the players, or when the deck runs low and the final round has been played.',
          'Whoever holds more tokens wins the match.',
        ],
      },
    ],
    subsections: [
      {
        id: 'overview-what-you-see',
        title: 'What you can see',
        blocks: [
          {
            kind: 'list',
            items: [
              'Your own hand. Of the opponent you only see how many cards they hold.',
              'Both stacks, every card on them, and every effect on the table.',
              'The deck: only its card count. Nobody knows its order.',
              'The graveyard: every card in it. It is shared by both players.',
              'Armed traps, including which trap it is.',
            ],
          },
        ],
      },
      {
        id: 'overview-deal',
        title: 'Dealing and refilling',
        blocks: [
          {
            kind: 'p',
            text: 'In the first round each player is dealt 9 cards. Before every later round, both hands are refilled to 9 from the deck. Cards you did not play stay in your hand.',
          },
          {
            kind: 'note',
            text: 'During a round your hand can grow above 9 through draws. That is allowed, and you never have to discard at the refill.',
          },
        ],
      },
    ],
  },
  {
    id: 'minions',
    title: 'Minions',
    blocks: [
      {
        kind: 'p',
        text: 'Minions (also called creatures) are the cards you build your stack with. Each one has a colour, a Level, an ATK value and a row of modifiers.',
      },
    ],
    subsections: [
      {
        id: 'minions-atk',
        title: 'ATK',
        blocks: [
          {
            kind: 'p',
            text: "The big number is the minion's ATK (attack). Your stack's ATK is the sum of all its minions, plus every buff and minus every nerf on them.",
          },
          {
            kind: 'note',
            text: 'A minion never drops below 0 ATK. All its buffs and nerfs are added up first, then anything below 0 counts as 0.',
          },
        ],
      },
      {
        id: 'minions-level',
        title: 'Level',
        blocks: [
          {
            kind: 'p',
            text: 'LVL is the Level, from 1 to 5. Each colour has exactly one minion of each Level. The Level also gives the minion its name:',
          },
          {
            kind: 'list',
            items: [
              'Level 1: Rootlet',
              'Level 2: Willow',
              'Level 3: Morrow',
              'Level 4: Oddkin',
              'Level 5: Sir Eck',
            ],
          },
        ],
      },
      {
        id: 'minions-colour',
        title: 'Colour',
        blocks: [
          {
            kind: 'p',
            text: 'There are 7 colours in a circle. Each colour beats the next one, and red beats orange:',
          },
          {
            kind: 'list',
            items: [
              'Orange (A) beats Yellow (B)',
              'Yellow (B) beats Green (C)',
              'Green (C) beats Blue (D)',
              'Blue (D) beats Indigo (E)',
              'Indigo (E) beats Violet (F)',
              'Violet (F) beats Red (G)',
              'Red (G) beats Orange (A)',
            ],
          },
          {
            kind: 'p',
            text: 'Each colour beats exactly one colour and is beaten by exactly one. Against the other four it is neutral. The ATK box on a card shows the colour that beats it.',
          },
          {
            kind: 'note',
            text: 'Colour only matters in two places: at the start of a round (Nullify and the rules for the second Base), and for the token the round winner takes. After that, colours play no part.',
          },
        ],
      },
      {
        id: 'minions-stack',
        title: 'The stack (card chain)',
        blocks: [
          {
            kind: 'p',
            text: 'Each player has one stack. The first minion is your Base minion. Every next minion is linked on top of it.',
          },
          {
            kind: 'list',
            items: [
              'A new minion must be exactly one Level higher than the top one: 1, 2, 3, 4, 5.',
              'No skipping Levels and no repeats.',
              'The top minion is your Leading minion (your Leader).',
              'You only ever place minions on your own stack.',
            ],
          },
          {
            kind: 'note',
            text: 'Once your Leader is Level 5, nothing more can be stacked on it normally. Only a Link Up or a spell can add a minion then.',
          },
          {
            kind: 'p',
            text: 'Positions count from the bottom: the Base is position 0, the first minion linked onto it is position 1, the next is position 2, and so on.',
          },
          {
            kind: 'p',
            text: 'Example: on a Level 2 Base you can play a Level 3 (position 1), then a Level 4 (position 2), then a Level 5 (position 3).',
          },
        ],
      },
      {
        id: 'minions-modifiers',
        title: 'Modifiers',
        blocks: [
          {
            kind: 'p',
            text: 'The symbols on a minion are its modifiers. Each symbol belongs to one stack position: symbol 1 works at position 1, symbol 2 at position 2, and so on.',
          },
          {
            kind: 'list',
            items: [
              'A modifier works only when the minion sits at exactly that position AND is the Leader.',
              'A minion at a position it has no symbol for does nothing extra.',
              'The Base minion (position 0) never uses a modifier.',
            ],
          },
          {
            kind: 'p',
            text: 'There are five kinds of modifier:',
          },
          {
            kind: 'list',
            items: [
              'Buff: this minion gets +30 ATK.',
              "Nerf: the opponent's Leader gets -30 ATK.",
              'Draw from deck: you draw 1 card from the deck.',
              'Draw from graveyard: you draw 1 random card from the graveyard.',
              'Link Up: your next minion may be placed at any Level (see Link Up).',
            ],
          },
        ],
        subsections: [
          {
            id: 'minions-live-silenced',
            title: 'Live and silenced',
            blocks: [
              {
                kind: 'p',
                text: 'A modifier is live while its minion is the Leader at the matching position. As soon as you link another minion on top, the covered minion goes silent.',
              },
              {
                kind: 'list',
                items: [
                  'A silenced Buff stops giving its +30.',
                  "A silenced Nerf stops giving the opponent's Leader its -30.",
                  "A live Nerf always hits the opponent's current Leader. When the opponent links a new Leader, the -30 moves to it.",
                  'A Draw or a Link Up happens once, at the moment the minion becomes the live Leader.',
                ],
              },
              {
                kind: 'note',
                text: 'If the minion on top of a silenced minion is removed (for example by a spell), the silenced minion becomes the Leader again and its modifier fires again: a Buff or Nerf is live again, and a Draw draws again. It is not cumulative: a Buff never gives more than +30 at a time.',
              },
              {
                kind: 'note',
                text: 'Modifiers stop when covered; spell effects do not. A buff or nerf from a spell stays on its minion for the whole round, even when the minion is covered.',
              },
            ],
          },
          {
            id: 'minions-link-up',
            title: 'Link Up',
            blocks: [
              {
                kind: 'p',
                text: 'When a live Link Up fires, it is armed. Your next minion may then be placed at any Level, ignoring the +1 rule.',
              },
              {
                kind: 'list',
                items: [
                  'After that, the chain continues from the linked minion: a linked Level 4 can only be followed by a Level 5 (unless the linked minion arms a new Link Up).',
                  'An armed Link Up is used up by your very next placement, even if that minion would have been a legal +1 anyway.',
                  'Placements made by spells also use it up.',
                  'An unused Link Up expires at the end of the round.',
                ],
              },
              {
                kind: 'note',
                text: 'An armed Link Up belongs to the minion that armed it. If that minion leaves the field (returned to hand, sent to the graveyard or the deck), the Link Up is lost.',
              },
            ],
          },
          {
            id: 'minions-reaching-positions',
            title: 'Which symbols you can reach',
            blocks: [
              {
                kind: 'p',
                text: 'With normal stacking, a minion of Level L on a Base of Level B lands at position L minus B. So the Base Level decides which symbols can work.',
              },
              {
                kind: 'p',
                text: 'Level 1 minions carry four symbols, but a Level 1 can normally only be a Base. Their symbols matter only when they are placed through a Link Up, a spell, or a tie-break.',
              },
              {
                kind: 'p',
                text: 'Level 5 minions carry one symbol, for position 1. It works only when the Level 5 is the first minion linked onto the Base: on a Level 4 Base, or through a Link Up or a spell.',
              },
              {
                kind: 'card',
                defId: 'C-A1',
                text: 'Four symbols: Nerf at position 1, Buff at 2, Buff at 3, Link Up at 4. Being Level 1, it only reaches them through a Link Up, a spell or a tie-break.',
              },
              {
                kind: 'card',
                defId: 'C-B1',
                text: 'Link Up at positions 2 and 4. Placed through a Link Up at position 2, it arms a new Link Up right away, so the chain can jump again.',
              },
              {
                kind: 'card',
                defId: 'C-C2',
                text: 'Link Up at positions 2 and 3, Buff at position 1. On a Level 1 Base it lands at position 1 and only gets its Buff.',
              },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'round-start',
    title: 'Starting a round',
    blocks: [
      {
        kind: 'p',
        text: 'One player is P1 for the round, the other P2. P1 is chosen at random in the first round and then alternates every round.',
      },
    ],
    subsections: [
      {
        id: 'round-start-p1-base',
        title: 'P1 places a Base',
        blocks: [
          {
            kind: 'list',
            ordered: true,
            items: [
              "P1 must place one minion of any Level as P1's Base minion. Its Level becomes the Base Level.",
              'P1 may Mulligan first. P1 cannot cast spells in this step.',
              'Placing the Base passes the turn to P2 straight away.',
            ],
          },
          {
            kind: 'note',
            text: 'If P1 has no minion in hand and cannot Mulligan, P1 ends the turn instead. The round is then a draw: nobody gets a token.',
          },
        ],
      },
      {
        id: 'round-start-p2-opening',
        title: "P2's opening",
        blocks: [
          {
            kind: 'p',
            text: 'P2 answers with one of these:',
          },
          {
            kind: 'list',
            items: [
              "Nullify P1's Base (see Nullify).",
              'Place a Base minion of its own, then keep stacking in the same turn.',
              'Mulligan, or cast spells.',
              'End Turn. P1 is ahead at this point, so this normally loses the round.',
            ],
          },
          {
            kind: 'p',
            text: "P2's Base has two limits:",
          },
          {
            kind: 'list',
            items: [
              'Its Level may not be higher than the Base Level.',
              "Its colour may not be the colour that P1's Base beats.",
            ],
          },
          {
            kind: 'p',
            text: "Example: P1's Base is a red Level 3. P2's Base must be Level 1 to 3, and not orange, because red beats orange.",
          },
          {
            kind: 'p',
            text: 'After that, the players take turns, starting with P1. Both are normal turns.',
          },
          {
            kind: 'note',
            text: 'Rare case: if P2 ends the opening turn at equal ATK, P1 plays a normal turn, and P2 then gets its opening turn again.',
          },
        ],
      },
      {
        id: 'round-start-mulligan',
        title: 'Mulligan',
        blocks: [
          {
            kind: 'p',
            text: 'A Mulligan returns your whole hand to the deck, shuffles it, and you draw half as many cards, rounded up (9 cards give 5, 7 give 4, 3 give 2).',
          },
          {
            kind: 'list',
            items: [
              'You need at least 2 cards in hand, and the deck needs at least 9 cards.',
              'Allowed any time during your own turn, as often as you like.',
              'It does not end your turn and does not count as playing a card.',
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'nullify',
    title: 'Nullify',
    blocks: [
      {
        kind: 'p',
        text: "In P2's opening, P2 may Nullify P1's Base with a minion whose colour beats it. The Level does not matter.",
      },
      {
        kind: 'list',
        ordered: true,
        items: [
          'Both minions go to the graveyard.',
          "P2's turn ends.",
          'P1 places a new Base, as if the round had just started.',
        ],
      },
      {
        kind: 'p',
        text: 'This can happen again and again, as long as P2 has a minion that beats the new Base.',
      },
      {
        kind: 'note',
        text: 'A minion that can Nullify may only Nullify. You cannot place it as your Base, even if it would fit the Base rules.',
      },
      {
        kind: 'list',
        items: [
          'Only P2 can Nullify, and only in its opening, before it has a Base.',
          'P1 can never Nullify.',
          "Once a spell has changed P1's stack in this round, Nullify is no longer allowed.",
          "In a repeated opening turn, Nullify works only while P1's stack is still just its Base.",
        ],
      },
    ],
  },
  {
    id: 'turns',
    title: 'Your turn',
    blocks: [
      {
        kind: 'p',
        text: 'On your turn you may do any of these, in any order, as often as the rules allow:',
      },
      {
        kind: 'list',
        items: [
          'Play minions onto your stack (one Level higher, or any Level with an armed Link Up).',
          'Cast spells.',
          'Mulligan.',
        ],
      },
      {
        kind: 'p',
        text: 'Playing nothing is also allowed. Your turn ends only when you press End Turn.',
      },
      {
        kind: 'note',
        text: 'Spells do not end your turn. You can cast a spell and keep playing.',
      },
    ],
    subsections: [
      {
        id: 'turns-end-turn',
        title: 'End Turn and winning a round',
        blocks: [
          {
            kind: 'p',
            text: 'There is no separate attack. The round is decided by End Turn:',
          },
          {
            kind: 'list',
            items: [
              'If you end your turn while the opponent has more ATK, you lose the round.',
              'If you are ahead or equal, the turn passes to the opponent.',
              'Both players keep answering each other until someone ends a turn while behind.',
            ],
          },
          {
            kind: 'note',
            text: 'Before you press End Turn, compare the two ATK totals. Ending your turn behind always loses the round.',
          },
          {
            kind: 'p',
            text: 'Equal ATK: if the opponent ended their turn at equal ATK, and you then end yours at equal ATK without having played a card, the round goes to a tie-break. A Mulligan does not count as playing a card; a spell does.',
          },
        ],
      },
      {
        id: 'turns-tie-break',
        title: 'Tie-break',
        blocks: [
          {
            kind: 'list',
            ordered: true,
            items: [
              "P1 turns over cards from the deck until a minion appears. It is linked onto P1's stack at any Level, and its modifier works as usual.",
              'Then P2 does the same.',
              'Spells turned over this way go back into the deck, which is shuffled.',
              'If ATK is still equal, repeat. Otherwise the higher stack wins.',
            ],
          },
          {
            kind: 'note',
            text: 'If the deck runs out during a tie-break, the round is a draw. Nobody gets a token, and both stacks go back into the deck.',
          },
        ],
      },
      {
        id: 'turns-tokens',
        title: 'Tokens',
        blocks: [
          {
            kind: 'p',
            text: "The round winner takes the token of their Leader's colour.",
          },
          {
            kind: 'list',
            items: [
              'Still unclaimed: the winner takes it.',
              'Held by the opponent: the winner takes it from them.',
              'Already held by the winner: nothing changes. The token is kept safe.',
            ],
          },
        ],
      },
      {
        id: 'turns-cleanup',
        title: 'After the round',
        blocks: [
          {
            kind: 'list',
            items: [
              'The losing stack goes to the graveyard.',
              'The winning stack goes back into the deck.',
              'Spells attached to minions go to the graveyard, even when their minion returns to the deck.',
              'The deck is shuffled and both hands are refilled to 9.',
              'Buffs, nerfs, armed Link Ups and armed traps all end with the round.',
            ],
          },
          {
            kind: 'note',
            text: 'The graveyard never returns to the deck. Cards in it can only come back through draw effects.',
          },
        ],
      },
      {
        id: 'turns-empty-stack',
        title: 'An emptied stack',
        blocks: [
          {
            kind: 'p',
            text: 'Spells can remove minions. If a stack loses its Base while other minions remain, the minion above becomes the new Base, and everything shifts down one position.',
          },
          {
            kind: 'p',
            text: 'If a spell empties your whole stack, you may place any minion as a new Base on your turn, with no Level or colour limits. You may also end your turn without one, but ending it while behind still loses the round.',
          },
        ],
      },
      {
        id: 'turns-clock',
        title: 'Turn clock',
        blocks: [
          {
            kind: 'list',
            items: [
              'Each turn has a time limit. When it runs out, your turn ends exactly as if you had pressed End Turn.',
              'Two timeouts in a row by the same player forfeit the match.',
              'If you disconnect, your clock pauses, up to a limited pause allowance per match.',
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'match-end',
    title: 'End of the match',
    blocks: [
      {
        kind: 'list',
        items: [
          'The match ends as soon as all 7 tokens are held by the players.',
          'It also ends after the final round (below).',
          'The player with more tokens wins.',
        ],
      },
    ],
    subsections: [
      {
        id: 'match-end-final-round',
        title: 'The final round',
        blocks: [
          {
            kind: 'p',
            text: 'Before a round starts, the cards in the deck and in both hands are counted. If there are 18 or fewer, that round is the final round:',
          },
          {
            kind: 'list',
            items: [
              'All hand cards go back into the deck.',
              'The cards are dealt out evenly, half each. An odd card left over goes to the graveyard.',
              'After this round the match is over, even if not all 7 tokens are held: the player with more tokens wins.',
              'The table announces it when the final round starts and marks it next to the round counter.',
            ],
          },
          {
            kind: 'note',
            text: 'If the tokens are tied after the final round, it is played again, at most twice. If they are still tied, the match is a draw.',
          },
        ],
      },
      {
        id: 'match-end-rare',
        title: 'Rare endings',
        blocks: [
          {
            kind: 'list',
            items: [
              'If neither hand has a minion and neither player can Mulligan, all hands are reshuffled into the deck and dealt again.',
              'If no minion is left anywhere and no card can still draw from the graveyard, the match ends by token count.',
              'If 7 rounds in a row pass without the deck and hands shrinking, the match ends by token count.',
              'In these cases equal tokens mean a draw.',
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'spells',
    title: 'Spells',
    blocks: [
      {
        kind: 'p',
        text: 'Spells are cast from your hand on your own turn. You can cast them in every step of a round except P1 placing a Base.',
      },
    ],
    subsections: [
      {
        id: 'spells-chain',
        title: 'Condition, Primary, Secondary',
        blocks: [
          {
            kind: 'p',
            text: 'Every spell has three parts. This is the spell chain:',
          },
          {
            kind: 'list',
            ordered: true,
            items: [
              'Condition: checked at the moment you cast the spell.',
              'Primary: fires if the Condition holds and the Primary can actually be carried out.',
              'Secondary: fires instead, in every other case.',
            ],
          },
          {
            kind: 'note',
            text: 'Only one of them fires, never both. The badge on the card in your hand shows which one would fire right now: Primary or Secondary.',
          },
          {
            kind: 'list',
            items: [
              'When a spell counts cards in hands, the spell you are casting is not counted.',
              'Minions "on the field" are the minions in both stacks, Bases included.',
              "A Secondary Buff always goes on your own Leader. A Secondary Nerf always goes on the opponent's Leader. You do not pick a target.",
              'A Secondary draw takes 1 card from the deck, or 1 random card from the graveyard.',
            ],
          },
        ],
      },
      {
        id: 'spells-no-effect',
        title: 'No spell for nothing',
        blocks: [
          {
            kind: 'p',
            text: 'You cannot cast a spell when the part that would fire would have no effect. Such a spell shows as Unavailable.',
          },
          {
            kind: 'list',
            items: [
              'A Buff with no Leader of your own to buff.',
              'A Nerf when the opponent has no Leader.',
              'A draw from an empty deck or an empty graveyard.',
              'A Primary that would change nothing, such as Gambit Prism with an empty graveyard or Foresight with an empty deck.',
            ],
          },
          {
            kind: 'note',
            text: 'A pile with fewer cards than needed still counts: you draw what is there.',
          },
        ],
      },
      {
        id: 'spells-attached',
        title: 'Spells that stay on a minion',
        blocks: [
          {
            kind: 'p',
            text: 'When a spell gives a minion a buff or a nerf, the spell card stays attached to that minion. The effect lasts until the end of the round.',
          },
          {
            kind: 'list',
            items: [
              'If the minion leaves the stack (to hand, deck or graveyard), the effect ends and the spell goes to the graveyard.',
              'At the end of the round the spell goes to the graveyard.',
              'A spell effect is never silenced when the minion is covered.',
            ],
          },
          {
            kind: 'p',
            text: 'Every other spell goes to the graveyard as soon as it has resolved.',
          },
        ],
      },
      {
        id: 'spells-choices',
        title: 'Choices',
        blocks: [
          {
            kind: 'p',
            text: 'Some spells let you choose: a minion from your hand, an enemy minion, cards to discard. The game pauses until you answer.',
          },
          {
            kind: 'p',
            text: 'Your opponent sees that you are choosing, but not which cards from your hand you could pick.',
          },
        ],
      },
      {
        id: 'spells-moving-minions',
        title: 'When spells move minions',
        blocks: [
          {
            kind: 'list',
            items: [
              'A minion placed by a spell counts as a normal placement: its modifier fires and it uses up an armed Link Up.',
              'When a minion is removed, the minions above it shift down one position. The new Leader fires its modifier for its new position.',
              'A minion always returns to the hand of the player whose stack it was on.',
              'Taking control of a minion is permanent: it is yours from then on, also after it leaves the field.',
            ],
          },
          {
            kind: 'note',
            text: 'Replay lock: a minion returned to a hand by Mass Recall, Tactical Retreat, Repel, Recoil Snare or Mutual Withdrawal cannot be played again in the same turn. Spells cannot place it either.',
          },
        ],
      },
      {
        id: 'spells-traps',
        title: 'Traps',
        blocks: [
          {
            kind: 'p',
            text: "Null Snare and Recoil Snare are traps. You cast one on your turn and it stays armed, face up, during your opponent's next turn. It fires by itself when the opponent places a minion that triggers it.",
          },
          {
            kind: 'list',
            items: [
              "Every placement counts: a normal play, a Base, a Link Up placement, or a minion placed or taken over by the opponent's spell.",
              'Your own placements never trigger your own trap.',
              "If the trap has not fired by the end of the opponent's turn, it expires and its Secondary fires.",
              'If its Primary fired, there is no Secondary.',
            ],
          },
          {
            kind: 'note',
            text: "An expiring trap fires its Secondary before the End Turn check. Recoil Snare's -30 on expiry can decide who is ahead when the opponent ends their turn.",
          },
          {
            kind: 'note',
            text: 'Traps are always castable, because arming always has an effect. If their Secondary later finds no target, it simply does nothing.',
          },
        ],
      },
    ],
  },
  {
    id: 'spell-cards',
    title: 'Spell details',
    blocks: [
      {
        kind: 'p',
        text: 'Edge cases for every spell. The printed text on the card is the short version.',
      },
      {
        kind: 'card',
        defId: 'S-01',
        text: 'Condition: a Level 3 minion anywhere on the field. Primary: you look at the top 2 deck cards, keep 1, and the other goes back into a reshuffled deck. Your opponent does not see them. With only 1 card in the deck you keep it. Secondary: -30 on the enemy Leader.',
      },
      {
        kind: 'card',
        defId: 'S-02',
        text: 'Condition: your opponent holds more cards than you (this spell not counted). 2 or more extra: you draw 2 from the graveyard. Exactly 1 extra: you draw 1. Then your opponent draws 1 from the deck. Secondary: +30 on your Leader.',
      },
      {
        kind: 'card',
        defId: 'S-03',
        text: 'Condition: both players have the same number of minions on the field, at least 3 each. Primary: the whole stacks swap sides, with all their buffs, nerfs and stack effects. No modifier fires on the swap. Then your new Leader gets -100 ATK (not below 0). The minions now belong to whoever holds them. Secondary: draw 1 from the graveyard.',
      },
      {
        kind: 'card',
        defId: 'S-04',
        text: "Condition: exactly 3 minions on the field, both sides together. Primary: all 3 return to their owners' hands at once, so nothing fires in between. They cannot be played again this turn. One or both stacks may be left empty. Secondary: draw 1 from the deck.",
      },
      {
        kind: 'card',
        defId: 'S-05',
        text: 'Condition: your opponent has a Level 5 on the field and you have a minion in hand. Primary: you choose a minion from your hand and link it onto your Leader at any Level. With no minion of your own on the field it becomes your Base. Secondary: +30 on your Leader.',
      },
      {
        kind: 'card',
        defId: 'S-06',
        text: "Condition: the enemy Leader has a live modifier (one that already fired, like a draw, still counts) and you have a Leader. Primary: the copy fires on your Leader at once. A copied Buff or Nerf behaves like your Leader's own modifier for the rest of the round: silenced when covered, live again when it leads again. A copied draw draws 1 now. A copied Link Up arms your Link Up; it cannot be cast for that if you already have one armed. Secondary: -30 on the enemy Leader.",
      },
      {
        kind: 'card',
        defId: 'S-07',
        text: 'Condition: you have a Leader and a minion in hand. Primary: your Leader is shuffled into the deck and a hand minion of your choice (any Level) takes its place. Only the new Leader fires its modifier; the minion below it does not wake up in between. Secondary: draw 1 from the graveyard.',
      },
      {
        kind: 'card',
        defId: 'S-08',
        text: 'Condition: your opponent has 4 or more minions on the field. Primary: their Leader goes to the graveyard. The minion below becomes Leader again and its modifier fires again (a draw draws again). Secondary: draw 1 from the deck.',
      },
      {
        kind: 'card',
        defId: 'S-09',
        text: 'Condition: you have a Leader and a lower-Level minion in hand. Primary: your Leader returns to your hand and the chosen lower minion takes its place. Only the new Leader fires its modifier. The returned minion cannot be played again this turn. Secondary: +30 on your Leader.',
      },
      {
        kind: 'card',
        defId: 'S-10',
        text: 'Condition: you hold a minion of the same Level as your Leader. Primary: link it onto your Leader, breaking the +1 rule. You choose if you have several. Secondary: -30 on the enemy Leader.',
      },
      {
        kind: 'card',
        defId: 'S-11',
        text: "Condition: your opponent has a Level 1, 2 or 3 minion on the field, Base included. Primary: you choose one and it returns to its owner's hand. The minions above shift down; if it was the Base, the next one becomes the Base. Secondary: draw 1 from the graveyard.",
      },
      {
        kind: 'card',
        defId: 'S-12',
        text: "Trap. It fires on the first minion your opponent places in their next turn. Level 2, 3 or 4: that minion's modifier does not fire this time (no buff, nerf, draw or Link Up while it stays there); it can still fire later. A Level 2-4 Base has no modifier, so nothing is blocked, but the trap is used up. Level 1 or 5: you draw 1 from the deck instead. Not triggered: it expires and you draw 1.",
      },
      {
        kind: 'card',
        defId: 'S-13',
        text: 'Condition: your opponent has a Level 1-4 minion on the field and you hold at least 1 other card. Primary: you take one of those minions for good. It becomes your new Leader (or your Base) and its modifier fires. Then you discard 1 card of your choice, which may be a card you just drew. Secondary: +30 on your Leader.',
      },
      {
        kind: 'card',
        defId: 'S-14',
        text: 'Condition: your opponent has 2 or more minions in their stack. Primary: the minion at position 1, right above their Base, goes to the graveyard. The rest shift down, and their Leader fires its modifier for its new position. Secondary: -30 on the enemy Leader.',
      },
      {
        kind: 'card',
        defId: 'S-15',
        text: "Condition: the opponent's stack ATK is at least 125 higher than yours. Primary: their whole stack gets -50 until the end of the round, whichever minion leads. It moves with the stack if the stacks swap, and ends if that stack is emptied. The stack total cannot go below 0. Secondary: +30 on your Leader.",
      },
      {
        kind: 'card',
        defId: 'S-16',
        text: "Trap. It fires the first time your opponent places a Level 3 or higher minion in their next turn. That minion goes back to its owner's hand before its modifier fires, and cannot be played again that turn. The minion below leads again and fires again. A Link Up used by that placement stays used. Not triggered: it expires and the enemy Leader gets -30 (the trap stays attached to it).",
      },
      {
        kind: 'card',
        defId: 'S-17',
        text: 'Condition: you hold at least 2 more cards than your opponent (this spell not counted) and they have a minion on the field. Primary: you shuffle the extra cards of your choice into the deck so the hands are equal. Then you take any enemy minion for good, Base included, any Level. Secondary: draw 1 from the deck.',
      },
      {
        kind: 'card',
        defId: 'S-18',
        text: "Condition: your opponent has at least 2 more minions on the field than you, and you have at least 1. Primary: choose one enemy minion, then one of yours. Both return to their owners' hands at once and cannot be played again this turn. Secondary: draw 1 from the graveyard.",
      },
      {
        kind: 'card',
        defId: 'S-19',
        text: 'Condition: there is at least 1 card in the graveyard. No Secondary, so it cannot be played while the graveyard is empty. You draw 1 random card from the graveyard and both players see it. A minion is linked onto your Leader at any Level and colour (or becomes your Base) as a normal placement. A spell is cast at once by your opponent, for free, as if it were theirs: see Gambit Prism below.',
      },
    ],
    subsections: [
      {
        id: 'spell-cards-gambit',
        title: 'Gambit Prism in detail',
        blocks: [
          {
            kind: 'p',
            text: 'When Gambit Prism draws a spell, your opponent casts it right away. For that spell they are "you" and you are "the opponent".',
          },
          {
            kind: 'list',
            items: [
              'Its Condition is ignored and the Secondary never fires.',
              'As much of the Primary as possible happens. Steps that cannot be done are skipped.',
              'The no-effect rule does not apply to it.',
              'Your opponent answers any choice it asks for.',
              'A trap drawn this way is armed on their side. It watches your next turn, not the rest of this one.',
              'If it draws another Gambit Prism, the roles swap again.',
              'Gambit Prism can never draw itself.',
            ],
          },
          {
            kind: 'note',
            text: 'Gambit Prism is a gamble: a strong spell from the graveyard may end up helping your opponent.',
          },
        ],
      },
    ],
  },
  {
    id: 'glossary',
    title: 'Glossary',
    blocks: [
      {
        kind: 'list',
        items: [
          'Minion (creature): a card with colour, Level, ATK and modifiers.',
          'Stack: your chain of minions, Base at the bottom.',
          'Base minion: the bottom minion of a stack (position 0). It never uses a modifier.',
          "Base Level: the Level of P1's Base. It limits the Level of P2's Base.",
          'Leading minion (Leader): the top minion of a stack.',
          "Position: a minion's place in the stack, counted from 0 at the Base.",
          'Modifier: a symbol on a minion that works at one position, only while it leads.',
          'Live / silenced: a modifier works while its minion leads at the right position; covered, it is silenced.',
          'Buff / Nerf: +30 / -30 ATK from a modifier, or the amount a spell gives.',
          'Link Up: lets your next minion ignore the Level rule.',
          "Nullify: P2 removes P1's Base with a minion whose colour beats it.",
          "Condition: the check that decides between a spell's Primary and Secondary.",
          'Primary / Secondary: the two effects of a spell. Exactly one fires.',
          "Trap: a spell that waits through the opponent's next turn and fires by itself.",
          'Replay lock: a returned minion cannot be played again this turn.',
          'Deck: the shared face-down pile you draw from.',
          'Graveyard: the shared face-up pile of used cards. It never returns to the deck.',
          'Mulligan: swap your hand for half as many new cards.',
          'End Turn: pass the turn. Ending it while behind loses the round.',
          'Tie-break: both players turn over cards until a minion, while ATK is tied.',
          'Round: one fight between two stacks, won by a token.',
          'Token: one per colour. Most tokens wins the match.',
          'Match: the rounds played until all tokens are held or the deck runs low.',
        ],
      },
    ],
  },
];
