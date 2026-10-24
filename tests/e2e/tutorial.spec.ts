import { expect, test, type Locator, type Page } from '@playwright/test';

// ADR-0018: the tutorial opens on the first Play click, is played through on the table (every
// gated action on the highlighted element), and is then remembered; Replay restarts it. Runs in
// the client only (no server round trip), against the same preview as the other specs.

const PROGRESS_KEY = 'cartignon.tutorial';
const HIGHLIGHTED = '[data-tutorial-highlight]';
/** Upper bound on steps; the script has fewer, the loop stops at Finish. */
const MAX_STEPS = 60;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

async function storedProgress(page: Page): Promise<unknown> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  }, PROGRESS_KEY);
}

/** The highlighted element is fully clear of the coach note (the note must not hide it). */
async function expectUncovered(overlay: Locator, target: Locator): Promise<void> {
  const note = await overlay.boundingBox();
  const box = await target.boundingBox();
  expect(note, 'coach note box').not.toBeNull();
  expect(box, 'target box').not.toBeNull();
  if (note && box) expect(intersects(note, box), 'coach note covers the target').toBe(false);
}

/** Performs the current gated command on the highlighted element. */
async function performGatedAction(page: Page, overlay: Locator): Promise<void> {
  // End Turn or Mulligan: a global command button.
  const global = page.locator(
    `[data-testid="global-endTurn"]${HIGHLIGHTED}, [data-testid="global-mulligan"]${HIGHLIGHTED}`,
  );
  if ((await global.count()) > 0) {
    await expect(global).toHaveCount(1);
    await expectUncovered(overlay, global);
    await global.click();
    return;
  }
  const card = page.getByTestId('hand').locator(`[data-card-id]${HIGHLIGHTED}`);
  await expect(card).toHaveCount(1);
  await expectUncovered(overlay, card);
  await card.click();
  // The card's action bar appears and is highlighted too; only the scripted play is offered.
  const actions = page.locator(`[data-testid="card-actions"]${HIGHLIGHTED}`);
  await expect(actions).toBeVisible();
  const play = actions.locator(
    '[data-testid="card-playCreature"], [data-testid="card-playSpell"], [data-testid="card-nullify"]',
  );
  await expect(play).toHaveCount(1);
  await expectUncovered(overlay, play);
  await play.click();
}

/** Clicks through every step until the tutorial leaves the table. */
async function playThrough(page: Page): Promise<string[]> {
  const overlay = page.getByTestId('tutorial-overlay');
  const seen: string[] = [];
  for (let i = 0; i < MAX_STEPS; i += 1) {
    await expect(overlay).toBeVisible();
    const step = (await overlay.getAttribute('data-step')) ?? '';
    seen.push(step);
    const continueButton = page.getByTestId('tutorial-continue');
    const hint = page.getByTestId('tutorial-hint');
    // Wait for the step to settle into one of its three gate forms.
    await expect(continueButton.or(hint)).toBeVisible();
    // Card steps enlarge one hand card in place and ring the part the text explains.
    if (step === 'card-level') {
      await expect(page.locator('[data-testid="hand"] [data-tutorial-zoom="level"]')).toHaveCount(
        1,
      );
    }
    // The spell is enlarged the same way, with its full text on the card, and stays uncovered.
    if (step === 'combat-spell-secondary') {
      const spell = page.locator('[data-testid="hand"] [data-tutorial-zoom="secondary"]');
      await expect(spell).toHaveCount(1);
      await expect(spell.locator('.spell-sec')).toBeVisible();
      await expect(page.getByTestId('card-preview')).toHaveCount(0);
      await expectUncovered(overlay, spell);
    }
    // The table's own outcome card never competes with the coach.
    await expect(page.getByTestId('outcome')).toHaveCount(0);
    if (await continueButton.isVisible()) {
      const last = (await continueButton.innerText()).trim() === 'Finish';
      await expect(continueButton).toBeFocused();
      await continueButton.click();
      if (last) return seen;
    } else if ((await hint.innerText()).startsWith('Do this')) {
      await performGatedAction(page, overlay);
    }
    // Command and event steps advance on their own; wait for the next step.
    await expect(overlay).not.toHaveAttribute('data-step', step);
  }
  throw new Error(`tutorial did not finish within ${MAX_STEPS} steps: ${seen.join(', ')}`);
}

test.describe('tutorial', () => {
  test.use({ viewport: { width: 375, height: 740 } });

  test('opens on the first Play, plays through, is remembered and can be replayed', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/');
    expect(await storedProgress(page)).toBeNull();
    await page.getByTestId('menu-play').click();

    const overlay = page.getByTestId('tutorial-overlay');
    await expect(overlay).toBeVisible();
    await expect(page.getByTestId('cartignon-table')).toBeVisible();
    await expect(page.getByTestId('tutorial-progress')).toContainText('Step 1 of');
    // Escape does not skip.
    await page.keyboard.press('Escape');
    await expect(overlay).toBeVisible();

    const steps = await playThrough(page);
    expect(steps[0]).toBe('welcome');
    for (const id of [
      'flow-mulligan',
      'flow-nullify',
      'flow-base',
      'combat-spell-condition',
      'combat-spell-primary',
      'combat-spell-secondary',
      'combat-spell',
    ]) {
      expect(steps).toContain(id);
    }
    expect(steps.at(-1)).toBe('goal-done');

    // Finish lands on the bot picker and the tutorial is recorded as completed.
    await expect(page.getByTestId('bot-levels')).toBeVisible();
    await expect(overlay).toHaveCount(0);
    expect(await storedProgress(page)).toEqual({ v: 1, status: 'completed' });

    // After a reload, Play opens the Play screen directly.
    await page.reload();
    await page.getByTestId('menu-play').click();
    await expect(page.getByTestId('bot-levels')).toBeVisible();
    await expect(overlay).toHaveCount(0);

    // Replay starts it again from the first step.
    await page.getByTestId('play-tutorial').click();
    await expect(overlay).toBeVisible();
    await expect(overlay).toHaveAttribute('data-step', 'welcome');
    expect(errors).toEqual([]);
  });

  test('Skip on step 1 records the tutorial as skipped', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('menu-play').click();
    await expect(page.getByTestId('tutorial-overlay')).toHaveAttribute('data-step', 'welcome');
    await page.getByTestId('tutorial-skip').click();
    await expect(page.getByTestId('bot-levels')).toBeVisible();
    await expect(page.getByTestId('tutorial-overlay')).toHaveCount(0);
    expect(await storedProgress(page)).toEqual({ v: 1, status: 'skipped' });
  });
});
