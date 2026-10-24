import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { playMatch, summarize, type PolicyName, type SelfPlayResult } from './self-play.js';

/**
 * R5b: self-play with the real card catalog. Every match must terminate (no exception, below the
 * step cap) and every command taken from `legalMatchCommands` (incl. `enumerateSelections`
 * choices) must be accepted by `applyMatchCommand` (the driver throws `IllegalLegalCommandError`
 * otherwise). The large statistics run is env-gated:
 *   CARTIGNON_SELFPLAY_STATS=1000 pnpm vitest run --project unit \
 *     packages/game-core/test/cartignon/self-play.test.ts
 * (optional CARTIGNON_SELFPLAY_OUT=<file> appends the summary lines to that file).
 */

const POLICIES: readonly PolicyName[] = ['random', 'eager'];
const SEEDS = 100;
const STEP_CAP = 50_000;

describe('self-play with the real catalog (R5b)', () => {
  for (const policy of POLICIES) {
    it(`${policy}: ${SEEDS} seeded matches terminate with only legal commands`, () => {
      const results: SelfPlayResult[] = [];
      for (let seed = 1; seed <= SEEDS; seed++) {
        results.push(playMatch({ seed, policy, maxSteps: STEP_CAP, checkInvariants: true }));
      }
      for (const r of results) {
        expect(r.end, `seed ${r.seed}`).not.toBe('stepCap');
        expect(r.steps).toBeLessThan(STEP_CAP);
        expect(r.rounds).toBeGreaterThan(0);
      }
    });
  }

  // RQ-34: accepted by the user 2026-10-19 (no per-turn play limit; the RD-25 clock bounds it).
  it('documents a rules gap: two Grave Draw spells can be swapped forever within one turn', () => {
    // Seed 54 (seed 330 until RD-172 / RD-173 changed the trajectories; seed 13 before the
    // xoshiro128** RNG, ADR-0009), eager without a play budget: the active seat alternates S-02
    // and S-03, each drawing the other back from the graveyard before landing there itself
    // (spells.ts: the spent spell goes to the graveyard after resolving), so hand, deck and
    // graveyard sizes never change. Nothing bounds plays per turn (RD-13, RD-83); only RD-25's
    // turn clock would. If a rule change bounds this, update this test.
    const r = playMatch({
      seed: 54,
      policy: 'eager',
      eagerPlayBudget: Number.POSITIVE_INFINITY,
      maxSteps: 3_000,
      traceTail: 4,
    });
    expect(r.end).toBe('stepCap');
    expect(r.rounds).toBe(0);
    expect(r.trace.map((t) => t.spellId).sort()).toEqual(['S-02', 'S-02', 'S-03', 'S-03']);
    expect(new Set(r.trace.map((t) => `${t.roundNumber}:${t.turnNumber}`)).size).toBe(1);
  });

  // Regression for RQ-33 (found by R5b self-play, fixed 2026-10-19). Seed 1591, random policy: in
  // round 1 `p2Opening`, seat 1 (P2, no Base) holds one Grave Draw spell (S-02 / S-07 alternate;
  // the graveyard holds the other), with no deck left for a Mulligan. Before the fix `playSpell`
  // was the only legal command forever; since RD-169 End Turn is always legal there.
  it('seed 1591 (random) terminates: a seat is never forced into an endless spell loop', () => {
    const r = playMatch({ seed: 1591, policy: 'random', maxSteps: 2_000, traceTail: 3 });
    expect(r.end).not.toBe('stepCap');
  });

  it('is deterministic per seed and policy', () => {
    expect(playMatch({ seed: 7, policy: 'random' })).toEqual(
      playMatch({ seed: 7, policy: 'random' }),
    );
  });
});

const STATS_MATCHES = Number(process.env['CARTIGNON_SELFPLAY_STATS'] ?? 0);

describe.skipIf(!(STATS_MATCHES > 0))('self-play statistics (env-gated)', () => {
  for (const disableNoProgress of [false, true]) {
    for (const policy of POLICIES) {
      it(`${policy}, no-progress rule ${disableNoProgress ? 'OFF' : 'ON'}`, () => {
        const results: SelfPlayResult[] = [];
        const errors: string[] = [];
        for (let seed = 1; seed <= STATS_MATCHES; seed++) {
          try {
            results.push(
              playMatch({ seed, policy, disableNoProgress, maxSteps: 200_000, maxRounds: 500 }),
            );
          } catch (e) {
            errors.push(String(e));
          }
        }
        const label = `policy=${policy} noProgress=${disableNoProgress ? 'off' : 'on'}`;
        const lines = [
          `STATS ${label} ` +
            JSON.stringify({ ...summarize(results), errors: errors.length, first: errors[0] }),
        ];
        if (disableNoProgress) {
          // Matches whose shadow counter reached 3: how did they end without the rule?
          const stalled = results.filter((r) => r.maxNoProgressStreak >= 3);
          lines.push(`STALLED ${label} ` + JSON.stringify(summarize(stalled)));
        }
        console.log(lines.join('\n'));
        const out = process.env['CARTIGNON_SELFPLAY_OUT'];
        if (out !== undefined) appendFileSync(out, `${lines.join('\n')}\n`);
        expect(errors).toEqual([]);
      }, 600_000);
    }
  }
});
