import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { SUB_PATH } from './support/static-site.ts';

// Deck screen in the static build: reachable from the main menu, Cards / Rules tabs (mouse and
// keyboard), the card preview opens from a catalog card, Back returns to the menu, and the page
// never scrolls sideways at phone width. Optional screenshots for visual review when DECK_SHOTS
// names an output directory (skipped otherwise).

const TUTORIAL_KEY = 'cartignon.tutorial';
const TUTORIAL_DONE = JSON.stringify({ v: 1, status: 'completed' });
const SHOTS = process.env['DECK_SHOTS'];

async function openDeck(page: Page): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      localStorage.setItem(key, value);
    },
    [TUTORIAL_KEY, TUTORIAL_DONE] as const,
  );
  await page.goto(SUB_PATH);
  await page.getByTestId('menu-deck').click();
  await expect(page.getByTestId('deck-screen')).toBeVisible();
}

async function noSideScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}-top.png`) });
}

test.describe('deck', () => {
  test('tabs, preview and Back on desktop', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await openDeck(page);

    const cardsTab = page.getByRole('tab', { name: 'Cards' });
    const rulesTab = page.getByRole('tab', { name: 'Rules' });
    await expect(cardsTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'Level 1' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Spells', level: 2 })).toBeVisible();
    await shot(page, 'desktop-cards');

    // A catalog card opens the table's enlarged preview.
    // (Any scroll or resize closes it, e.g. one left over from the full-page screenshot, so the
    // click is retried until the preview stays.)
    const spell = page.locator('[data-card-id="S-01"]');
    await spell.scrollIntoViewIfNeeded();
    await expect(async () => {
      await spell.click();
      await expect(page.getByTestId('card-preview')).toBeVisible({ timeout: 1_000 });
    }).toPass();
    await page.keyboard.press('Escape');
    await page.mouse.move(0, 0);
    await expect(page.getByTestId('card-preview')).toHaveCount(0);

    await rulesTab.click();
    await expect(rulesTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('deck-panel-rules')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Rules contents' })).toBeVisible();
    await shot(page, 'desktop-rules');

    // Keyboard: arrows move between the tabs and select them.
    await rulesTab.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(cardsTab).toBeFocused();
    await expect(cardsTab).toHaveAttribute('aria-selected', 'true');

    await page.getByTestId('deck-back').click();
    await expect(page.getByTestId('menu-deck')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('phone width: no sideways scroll on either tab', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await openDeck(page);
    await noSideScroll(page);
    await shot(page, 'phone-cards');
    await page.getByRole('tab', { name: 'Rules' }).click();
    await expect(page.getByTestId('deck-panel-rules')).toBeVisible();
    await noSideScroll(page);
    await shot(page, 'phone-rules');
  });
});
