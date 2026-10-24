import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { SUB_PATH } from './support/static-site.ts';

// Settings (theme, card colour palette) in the static build: reachable from the main menu, the
// Play screen and the running match (without leaving it); choices apply at once, persist per
// viewer in localStorage and survive a reload. Optional screenshots for visual review when
// SETTINGS_SHOTS names an output directory (skipped otherwise).

const TUTORIAL_KEY = 'cartignon.tutorial';
const TUTORIAL_DONE = JSON.stringify({ v: 1, status: 'completed' });
/** COLORBLIND_PALETTE.violet / NORMAL_PALETTE.violet in colors.ts. */
const CB_VIOLET = '#c154fb';
const NORMAL_VIOLET = '#c026d3';

async function skipTutorial(page: Page): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      localStorage.setItem(key, value);
    },
    [TUTORIAL_KEY, TUTORIAL_DONE] as const,
  );
}

async function violetVar(page: Page): Promise<string> {
  return page.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue('--cartignon-color-violet')
      .trim()
      .toLowerCase(),
  );
}

test.describe('settings', () => {
  test('main menu: theme and palette apply, persist and restore focus', async ({ page }) => {
    await skipTutorial(page);
    await page.goto(SUB_PATH);
    expect(await violetVar(page)).toBe(NORMAL_VIOLET);

    const opener = page.getByTestId('menu-settings');
    await opener.click();
    const dialog = page.getByTestId('settings-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await expect(page.getByTestId('settings-theme-system')).toBeChecked();
    await expect(page.getByTestId('settings-palette-normal')).toBeChecked();

    // Keyboard: arrow keys move within the radio group.
    await page.getByTestId('settings-theme-system').focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('settings-theme-dark')).toBeChecked();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.getByTestId('settings-palette-colorblind').check();
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'colorblind');
    expect(await violetVar(page)).toBe(CB_VIOLET);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'colorblind');
    expect(await violetVar(page)).toBe(CB_VIOLET);

    // System clears the stored theme again.
    await page.getByTestId('menu-settings').click();
    await page.getByTestId('settings-theme-system').check();
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
    expect(await page.evaluate(() => localStorage.getItem('cartignon.theme'))).toBeNull();
    await page.getByTestId('settings-close').click();
    await expect(page.getByTestId('settings-dialog')).toBeHidden();
  });

  test('Play screen header and the running match open Settings', async ({ page }) => {
    await skipTutorial(page);
    await page.goto(SUB_PATH);
    await page.getByTestId('menu-play').click();
    await page.getByTestId('settings-open').click();
    await expect(page.getByTestId('settings-replay-tutorial')).toBeVisible();
    await page.getByTestId('settings-close').click();

    await page.getByTestId('play-bot').click();
    const table = page.getByTestId('cartignon-table');
    await expect(table).toBeVisible();
    await page.getByTestId('menu-toggle').click();
    await page.getByTestId('settings-open').click();
    const dialog = page.getByTestId('settings-dialog');
    await expect(dialog).toBeVisible();
    // No Replay tutorial inside a match (it would leave the match).
    await expect(page.getByTestId('settings-replay-tutorial')).toHaveCount(0);
    await page.getByTestId('settings-palette-colorblind').check();
    await expect(table).toHaveAttribute('data-palette', 'colorblind');
    await page.getByTestId('settings-close').click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('menu-toggle')).toBeFocused();
    // Still in the same match.
    await expect(table).toBeVisible();
    await expect(page.getByTestId('phase')).toHaveAttribute('data-phase', 'active');
  });
});

const SHOTS = process.env['SETTINGS_SHOTS'] ?? '';

test.describe('settings screenshots', () => {
  test.skip(SHOTS === '', 'set SETTINGS_SHOTS to an output directory');

  for (const [width, height, size] of [
    [360, 740, 'mobile'],
    [1280, 800, 'desktop'],
  ] as const) {
    for (const theme of ['light', 'dark'] as const) {
      test(`${size} ${theme}`, async ({ page }) => {
        mkdirSync(SHOTS, { recursive: true });
        await page.setViewportSize({ width, height });
        await skipTutorial(page);
        await page.emulateMedia({ colorScheme: theme });
        await page.goto(SUB_PATH);
        await page.getByTestId('menu-play').click();
        await page.getByTestId('play-bot').click();
        await expect(page.getByTestId('cartignon-table')).toBeVisible();
        await page.waitForTimeout(800);
        for (const palette of ['normal', 'colorblind'] as const) {
          await page.getByTestId('menu-toggle').click();
          await page.getByTestId('settings-open').click();
          await page.getByTestId(`settings-palette-${palette}`).check();
          await page.mouse.move(0, 0);
          await page.screenshot({
            path: path.join(SHOTS, `${size}-${theme}-${palette}-settings.png`),
          });
          await page.getByTestId('settings-close').click();
          await expect(page.getByTestId('settings-dialog')).toBeHidden();
          await page.waitForTimeout(300);
          await page.screenshot({
            path: path.join(SHOTS, `${size}-${theme}-${palette}-table.png`),
          });
        }
      });
    }
  }
});
