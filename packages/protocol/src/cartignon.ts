import { z } from 'zod';
import { seatSchema } from './common.js';

/**
 * Cartignon wire contracts (R6): actions a client sends inside `action` of an action message, and
 * the `public` / `private` / `events` parts of a `match:view` whose `rulesId` is `cartignon`.
 * All schemas are strict. They mirror game-core's hand-written parser and projection
 * (`packages/game-core/src/cartignon/{rules-module,projection}.ts`); a contract test keeps the two
 * aligned. Card ids are instance ids `c01`..`c54`.
 */

export const CARTIGNON_RULES_ID = 'cartignon';

/** Upper bound of one `chooseSpellOption.selection` (54 cards in the game). */
export const CARTIGNON_MAX_SELECTION = 54;

/** Upper bound of `private.legal` (choice lists are capped at 64; normal play stays below). */
export const CARTIGNON_MAX_LEGAL = 128;

export const cardIdSchema = z.string().regex(/^c\d{2}$/);
export type CartignonCardId = z.infer<typeof cardIdSchema>;

const cardIdsSchema = z.array(cardIdSchema).max(CARTIGNON_MAX_SELECTION);
const countSchema = z.int().min(0).max(1000);
const atkSchema = z.int();
const atkPairSchema = z.tuple([atkSchema, atkSchema]);
const defIdSchema = z.string().min(1).max(64);
const spellIdSchema = z.string().min(1).max(16);

export const colorSchema = z.enum(['orange', 'yellow', 'green', 'blue', 'indigo', 'violet', 'red']);
export const modifierKindSchema = z.enum([
  'buffSelf',
  'nerfEnemyLeader',
  'linkUp',
  'drawDeck',
  'drawGrave',
]);
export const choiceKindSchema = z.enum([
  'keepDrawn',
  'handCreature',
  'enemyCreature',
  'ownCreature',
  'handDiscard',
  'handToDeck',
]);
const levelSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]);
const matchEndReasonSchema = z.enum([
  'allTokensHeld',
  'finalRoundPlayed',
  'replaysExhausted',
  'replayImpossible',
  'noCreaturesLeft',
  'noProgress',
  // R7: forfeits decided by the server room (RD-43; RD-41 / RD-46).
  'forfeitTimeouts',
  'forfeitTimeoutAfterPause',
]);
/** RD-169: why a round ended (End Turn evaluation). */
const roundOverReasonSchema = z.enum(['opponentAhead', 'equalStall', 'p1NoBase']);

// ---------------------------------------------------------------------------------------------
// Actions (client -> server)

const cardPayload = z.strictObject({ cardId: cardIdSchema });
const emptyPayload = z.strictObject({});

/** A Cartignon action (`{ type, v: 1, payload }`), strict. */
export const cartignonActionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('playCreature'), v: z.literal(1), payload: cardPayload }),
  z.strictObject({ type: z.literal('nullify'), v: z.literal(1), payload: cardPayload }),
  z.strictObject({ type: z.literal('playSpell'), v: z.literal(1), payload: cardPayload }),
  z.strictObject({ type: z.literal('mulligan'), v: z.literal(1), payload: emptyPayload }),
  z.strictObject({ type: z.literal('endTurn'), v: z.literal(1), payload: emptyPayload }),
  z.strictObject({
    type: z.literal('chooseSpellOption'),
    v: z.literal(1),
    payload: z.strictObject({
      choiceId: z.int().min(0),
      selection: z.array(cardIdSchema).max(CARTIGNON_MAX_SELECTION),
    }),
  }),
]);
export type CartignonAction = z.infer<typeof cartignonActionSchema>;

/** A round command as listed in `private.legal` (convert with the action's payload fields). */
export const cartignonCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('playCreature'), cardId: cardIdSchema }),
  z.strictObject({ type: z.literal('nullify'), cardId: cardIdSchema }),
  z.strictObject({ type: z.literal('playSpell'), cardId: cardIdSchema }),
  z.strictObject({ type: z.literal('mulligan') }),
  z.strictObject({ type: z.literal('endTurn') }),
  z.strictObject({
    type: z.literal('chooseSpellOption'),
    choiceId: z.int().min(0),
    selection: z.array(cardIdSchema).max(CARTIGNON_MAX_SELECTION),
  }),
]);
export type CartignonCommand = z.infer<typeof cartignonCommandSchema>;

// ---------------------------------------------------------------------------------------------
// Shared view / event parts

const attachedEffectSchema = z.strictObject({
  effectId: z.string().max(32),
  kind: z.literal('atkDelta'),
  amount: atkSchema,
  sourceCardId: cardIdSchema,
  targetCardId: cardIdSchema,
});

const stackEffectSchema = z.strictObject({
  effectId: z.string().max(32),
  kind: z.literal('stackAtkDelta'),
  seat: seatSchema,
  amount: atkSchema,
  sourceCardId: cardIdSchema,
});

const copiedModifierSchema = z.strictObject({
  effectId: z.string().max(32),
  kind: z.enum(['buffSelf', 'nerfEnemyLeader']),
  carrierCardId: cardIdSchema,
  sourceCardId: cardIdSchema,
});

const liveModifierSchema = z.strictObject({
  seat: seatSchema,
  cardId: cardIdSchema,
  kind: modifierKindSchema,
  position: countSchema,
});

const matchStatusSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('playing') }),
  z.strictObject({
    kind: z.literal('matchOver'),
    reason: matchEndReasonSchema,
    winner: seatSchema.nullable(),
    tokenCounts: z.tuple([countSchema, countSchema]),
  }),
]);

const roundOutcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('win'),
    winner: seatSchema,
    decidedBy: z.enum(['opponentAhead', 'tieBreak']),
    atk: atkPairSchema,
    tieBreakIterations: countSchema,
  }),
  z.strictObject({
    kind: z.literal('draw'),
    reason: z.enum(['p1NoBase', 'tieBreakDeckOut']),
    atk: atkPairSchema,
    tieBreakIterations: countSchema,
  }),
]);

const pendingChoiceViewSchema = z.union([
  z.strictObject({
    choiceId: z.int().min(0),
    seat: seatSchema,
    kind: choiceKindSchema,
    spellId: spellIdSchema,
    options: cardIdsSchema,
    min: countSchema,
    max: countSchema,
  }),
  z.strictObject({
    seat: seatSchema,
    kind: choiceKindSchema,
    spellId: spellIdSchema,
    /** RD-142: absent for `handCreature`. */
    optionCount: countSchema.optional(),
    min: countSchema,
    max: countSchema,
  }),
]);

// ---------------------------------------------------------------------------------------------
// Views

const phaseViewSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('p1Base'), active: seatSchema }),
  // RD-169: `equalEndBy` = the seat whose End Turn at equal ATK handed this turn over, else null.
  z.strictObject({
    kind: z.literal('p2Opening'),
    active: seatSchema,
    equalEndBy: seatSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal('turn'),
    active: seatSchema,
    equalEndBy: seatSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal('roundOver'),
    reason: roundOverReasonSchema,
    /** The seat whose turn end ended the round. */
    seat: seatSchema,
    atk: atkPairSchema,
  }),
]);

const cardSummarySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('creature'),
    color: colorSchema,
    level: levelSchema,
    atk: atkSchema,
    modifiers: z.array(modifierKindSchema).max(8),
  }),
  z.strictObject({ kind: z.literal('spell'), name: z.string().max(64) }),
]);

const seatTokenSchema = seatSchema.nullable();

/** `public` of a Cartignon view: identical for both seats, no hidden information. */
export const cartignonPublicViewSchema = z.strictObject({
  match: z.strictObject({
    roundNumber: z.int().min(1),
    tokens: z.strictObject({
      orange: seatTokenSchema,
      yellow: seatTokenSchema,
      green: seatTokenSchema,
      blue: seatTokenSchema,
      indigo: seatTokenSchema,
      violet: seatTokenSchema,
      red: seatTokenSchema,
    }),
    finalRound: z.boolean(),
    replays: countSchema,
    status: matchStatusSchema,
    lastOutcome: roundOutcomeSchema.nullable(),
  }),
  round: z.strictObject({
    p1: seatSchema,
    phase: phaseViewSchema,
    baseLevel: levelSchema.nullable(),
    turnNumber: z.int().min(0),
    playedThisTurn: z.boolean(),
    stackEmptiedBySpell: z.boolean(),
    p1StackTouchedBySpell: z.boolean(),
    turnLocks: z.array(z.strictObject({ seat: seatSchema, cardId: cardIdSchema })).max(54),
  }),
  board: z.strictObject({
    stacks: z.tuple([cardIdsSchema, cardIdsSchema]),
    attachedEffects: z.array(attachedEffectSchema).max(256),
    attachedSpells: z
      .array(z.strictObject({ cardId: cardIdSchema, seat: seatSchema, targetCardId: cardIdSchema }))
      .max(54),
    stackEffects: z.array(stackEffectSchema).max(256),
    copiedModifiers: z.array(copiedModifierSchema.extend({ live: z.boolean() })).max(256),
    linkUp: z.strictObject({
      pending: z.tuple([z.boolean(), z.boolean()]),
      source: z.tuple([cardIdSchema.nullable(), cardIdSchema.nullable()]),
    }),
    armedTraps: z
      .array(
        z.strictObject({
          cardId: cardIdSchema,
          seat: seatSchema,
          spellId: spellIdSchema,
          dormant: z.boolean(),
        }),
      )
      .max(54),
    negatedModifiers: z
      .array(z.strictObject({ cardId: cardIdSchema, position: countSchema }))
      .max(256),
  }),
  liveModifiers: z.array(liveModifierSchema).max(2),
  atk: atkPairSchema,
  handCounts: z.tuple([countSchema, countSchema]),
  deckCount: countSchema,
  graveyardCount: countSchema,
  /** RD-170: the shared graveyard in order (oldest first). Map ids with `cardDefs`. */
  graveyard: cardIdsSchema,
  lookingAt: z.strictObject({ seat: seatSchema, count: countSchema }).nullable(),
  cardDefs: z.record(cardIdSchema, defIdSchema),
  defs: z.record(defIdSchema, cardSummarySchema),
});
export type CartignonPublicView = z.infer<typeof cartignonPublicViewSchema>;

/** `private` of a Cartignon view: only the receiving seat's hidden data. */
export const cartignonPrivateViewSchema = z.strictObject({
  seat: seatSchema,
  hand: cardIdsSchema,
  lookingAt: cardIdsSchema.nullable(),
  pendingChoiceView: pendingChoiceViewSchema.nullable(),
  legal: z.array(cartignonCommandSchema).max(CARTIGNON_MAX_LEGAL),
  /**
   * One entry per spell in the own hand (hand order): the effect it would fire if cast now
   * (`branch`; null = not playable in this build), whether `playSpell` is legal now, and the
   * rejection code otherwise (`reason`).
   */
  spellHints: z
    .array(
      z.strictObject({
        cardId: cardIdSchema,
        branch: z.enum(['primary', 'secondary']).nullable(),
        castable: z.boolean(),
        reason: z.string().max(64).nullable(),
      }),
    )
    .max(CARTIGNON_MAX_SELECTION),
});
export type CartignonPrivateView = z.infer<typeof cartignonPrivateViewSchema>;

// ---------------------------------------------------------------------------------------------
// Events (as one seat receives them)

const drawReasonSchema = z.enum([
  'deal',
  'mulligan',
  'refill',
  'finalDeal',
  'redeal',
  'modifierDeck',
  'modifierGraveyard',
  'spellDeck',
  'spellGraveyard',
]);

const stackExitSchema = z.discriminatedUnion('zone', [
  z.strictObject({ zone: z.literal('deck') }),
  z.strictObject({ zone: z.literal('graveyard') }),
  z.strictObject({ zone: z.literal('hand'), seat: seatSchema }),
]);

const ev = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.strictObject({ type: z.literal(type), ...shape });

/**
 * One event of a Cartignon `match:view` (`events`). Hidden-information events come in two
 * strict shapes: with ids (the seat the event is about) or with counts (the other seat).
 * Optional fields (`playedVia`, `dormant`, `attachedTo`, ...) are absent when not applicable.
 *
 * Narration (draws): `spellPlayed.seat` is the caster (through S-19 Gambit Prism: the S-19
 * caster's opponent, with `playedVia` = the S-19 card) and `branch` the effect that fired. Every
 * spell draw emits `cardsDrawn` (ids for the drawing seat, `count` for the other) followed by the
 * public `spellDrawResolved { seat, from, requested, drawn }`; `drawn < requested` means the source
 * (graveyard or deck) ran short. Creature modifier draws (`modifierDeck` / `modifierGraveyard`)
 * always request 1 (RD-123); an empty `cardIds` / `count: 0` means the source was empty.
 */
export const cartignonSeatEventSchema = z.union([
  // Round
  ev('roundStarted', { p1: seatSchema }),
  ev('handsDealt', { firstSeat: seatSchema, packetSize: countSchema }),
  ev('cardsDrawn', { seat: seatSchema, reason: drawReasonSchema, cardIds: cardIdsSchema }),
  ev('cardsDrawn', { seat: seatSchema, reason: drawReasonSchema, count: countSchema }),
  ev('turnStarted', { seat: seatSchema, turnNumber: countSchema }),
  ev('turnEnded', { seat: seatSchema }),
  ev('creaturePlayed', {
    seat: seatSchema,
    cardId: cardIdSchema,
    role: z.enum(['p1Base', 'p2Base', 'stack', 'midRoundBase']),
  }),
  ev('nullified', { seat: seatSchema, cardId: cardIdSchema, nullifiedCardId: cardIdSchema }),
  ev('mulliganed', { seat: seatSchema, returned: countSchema, drawnCount: countSchema }),
  ev('roundOver', { reason: roundOverReasonSchema, seat: seatSchema, atk: atkPairSchema }),
  // Spells
  ev('spellPlayed', {
    seat: seatSchema,
    cardId: cardIdSchema,
    branch: z.enum(['primary', 'secondary']),
    playedVia: cardIdSchema.optional(),
  }),
  ev('gambitDrawn', {
    seat: seatSchema,
    cardId: cardIdSchema,
    drawnCardId: cardIdSchema.optional(),
    drawnKind: z.enum(['creature', 'spell']).optional(),
  }),
  ev('effectAttached', { effect: attachedEffectSchema }),
  ev('spellDrawResolved', {
    seat: seatSchema,
    from: z.enum(['deck', 'graveyard']),
    requested: countSchema,
    drawn: countSchema,
  }),
  ev('modifierCopied', { seat: seatSchema, sourceCardId: cardIdSchema, kind: modifierKindSchema }),
  ev('cardsLookedAt', { seat: seatSchema, cardIds: cardIdsSchema }),
  ev('cardsLookedAt', { seat: seatSchema, count: countSchema }),
  ev('lookedAtSettled', {
    seat: seatSchema,
    kept: cardIdsSchema,
    returned: cardIdsSchema,
    deckShuffled: z.boolean(),
  }),
  ev('lookedAtSettled', {
    seat: seatSchema,
    keptCount: countSchema,
    returnedCount: countSchema,
    deckShuffled: z.boolean(),
  }),
  ev('spellChoiceRequested', {
    seat: seatSchema,
    spellId: spellIdSchema,
    cardId: cardIdSchema,
    kind: choiceKindSchema,
    optionCount: countSchema.optional(),
  }),
  ev('spellChoiceMade', {
    seat: seatSchema,
    choiceId: z.int().min(0),
    kind: choiceKindSchema,
    selection: cardIdsSchema,
  }),
  ev('spellChoiceMade', {
    seat: seatSchema,
    choiceId: z.int().min(0),
    kind: choiceKindSchema,
    selectionCount: countSchema,
  }),
  ev('cardsDiscarded', { seat: seatSchema, cardIds: cardIdsSchema }),
  ev('handCardsReturned', { seat: seatSchema, cardIds: cardIdsSchema }),
  ev('handCardsReturned', { seat: seatSchema, count: countSchema }),
  ev('deckShuffled', { seat: seatSchema }),
  ev('replayLocked', { seat: seatSchema, cardId: cardIdSchema }),
  ev('spellResolved', {
    seat: seatSchema,
    cardId: cardIdSchema,
    destination: z.enum(['graveyard', 'attached', 'armed']),
    targetCardId: cardIdSchema.optional(),
  }),
  // Traps (public, RD-130)
  ev('trapArmed', {
    seat: seatSchema,
    cardId: cardIdSchema,
    spellId: spellIdSchema,
    dormant: z.literal(true).optional(),
  }),
  ev('trapWindowOpened', { seat: seatSchema, cardId: cardIdSchema, spellId: spellIdSchema }),
  ev('trapTriggered', {
    seat: seatSchema,
    cardId: cardIdSchema,
    spellId: spellIdSchema,
    targetSeat: seatSchema,
    triggerCardId: cardIdSchema,
    outcome: z.enum(['negated', 'secondary', 'returned']),
    negatedKind: modifierKindSchema.optional(),
  }),
  ev('trapLapsed', {
    seat: seatSchema,
    cardId: cardIdSchema,
    spellId: spellIdSchema,
    attachedTo: cardIdSchema.optional(),
  }),
  // Board
  ev('creatureStacked', {
    seat: seatSchema,
    cardId: cardIdSchema,
    position: countSchema,
    viaLinkUp: z.boolean(),
  }),
  ev('creatureLinked', { seat: seatSchema, cardId: cardIdSchema, position: countSchema }),
  ev('creatureRemoved', {
    seat: seatSchema,
    cardId: cardIdSchema,
    position: countSchema,
    to: stackExitSchema,
  }),
  ev('controlTaken', {
    seat: seatSchema,
    from: seatSchema,
    cardId: cardIdSchema,
    fromPosition: countSchema,
    position: countSchema,
    viaLinkUp: z.boolean(),
  }),
  ev('linkUpConsumed', { seat: seatSchema }),
  ev('linkUpArmed', { seat: seatSchema, sourceCardId: cardIdSchema }),
  ev('linkUpLapsed', { seat: seatSchema, sourceCardId: cardIdSchema }),
  ev('effectDiscarded', { effect: attachedEffectSchema }),
  ev('copiedModifierAdded', { modifier: copiedModifierSchema }),
  ev('copiedModifierDiscarded', { modifier: copiedModifierSchema }),
  ev('stacksSwapped', {}),
  ev('stackEffectAdded', { effect: stackEffectSchema }),
  ev('stackEffectEnded', { effect: stackEffectSchema }),
  ev('attachedSpellDiscarded', { cardId: cardIdSchema, targetCardId: cardIdSchema }),
  ev('modifierLive', {
    seat: seatSchema,
    cardId: cardIdSchema,
    kind: modifierKindSchema,
    position: countSchema,
  }),
  ev('modifierSilenced', {
    seat: seatSchema,
    cardId: cardIdSchema,
    kind: modifierKindSchema,
    position: countSchema,
  }),
  // Match
  ev('tieBreakStarted', { iteration: countSchema, atk: atkPairSchema }),
  ev('tieBreakCardsReturned', { seat: seatSchema, count: countSchema }),
  ev('tieBreakDeckOut', { seat: seatSchema }),
  ev('roundResolved', { outcome: roundOutcomeSchema }),
  ev('tokenChanged', {
    change: z.strictObject({
      seat: seatSchema,
      color: colorSchema,
      kind: z.enum(['awarded', 'stolen', 'protected']),
      leadingCardId: cardIdSchema,
    }),
  }),
  ev('roundCleanedUp', { toGraveyard: countSchema, toDeck: countSchema }),
  ev('deckExhausted', {
    reason: z.enum(['finalRound', 'finalRoundReplay']),
    returnedFromHands: countSchema,
    perSeat: countSchema,
    toGraveyard: countSchema,
  }),
  ev('handsRefilled', { firstSeat: seatSchema, packetSize: countSchema }),
  ev('handsRedealt', { firstSeat: seatSchema, returnedFromHands: countSchema }),
  ev('finalRoundReplay', { replay: countSchema }),
  ev('matchOver', {
    reason: matchEndReasonSchema,
    winner: seatSchema.nullable(),
    tokenCounts: z.tuple([countSchema, countSchema]),
  }),
]);
export type CartignonSeatEvent = z.infer<typeof cartignonSeatEventSchema>;

export const cartignonSeatEventsSchema = z.array(cartignonSeatEventSchema).max(512);
