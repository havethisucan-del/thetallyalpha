import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { STATIC_ORIGIN, SUB_PATH } from './support/static-site.ts';

// ADR-0017: the static build, served under a Pages-like sub-path, plays a whole solo match against
// the in-browser bot with no server: no `/api` request, no WebSocket, no request outside the
// sub-path, no failed request and no console error. The engine is CSPRNG-seeded (no test seed in
// the static bundle), so the loop below only ever takes a move the UI offers and is bounded.

const PROGRESS_KEY = 'cartignon.tutorial';
const TUTORIAL_DONE = JSON.stringify({ v: 1, status: 'completed' });
/** Upper bound on loop passes; an L1 match needs far fewer. */
const MAX_PASSES = 3_000;
/** Longest wait for the bot to hand the move back (its cosmetic delay is under 2 s per move). */
const BOT_WAIT_MS = 30_000;

interface Traffic {
  requests: string[];
  websockets: string[];
  failures: string[];
  consoleErrors: string[];
}

/** Records everything the page (and its bot worker) sends, plus console and page errors. */
function watchTraffic(context: BrowserContext, page: Page): Traffic {
  const traffic: Traffic = { requests: [], websockets: [], failures: [], consoleErrors: [] };
  context.on('request', (request) => traffic.requests.push(request.url()));
  context.on('requestfailed', (request) => {
    traffic.failures.push(`${request.url()} (${request.failure()?.errorText ?? 'failed'})`);
  });
  context.on('response', (response) => {
    if (response.status() >= 400) traffic.failures.push(`${response.url()} (${response.status()})`);
  });
  page.on('websocket', (socket) => traffic.websockets.push(socket.url()));
  page.on('console', (message) => {
    if (message.type() === 'error') traffic.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => traffic.consoleErrors.push(error.message));
  return traffic;
}

function expectOffline(traffic: Traffic): void {
  const site = `${STATIC_ORIGIN}${SUB_PATH}`;
  expect(traffic.requests.length, 'some requests were seen').toBeGreaterThan(0);
  expect(traffic.websockets, 'WebSocket connections').toEqual([]);
  expect(
    traffic.requests.filter((url) => /\/api(\/|$)|^wss?:/.test(url)),
    'requests to /api or ws',
  ).toEqual([]);
  expect(
    traffic.requests.filter(
      (url) => !url.startsWith(site) && !url.startsWith('data:') && !url.startsWith('blob:'),
    ),
    'requests outside the sub-path',
  ).toEqual([]);
  expect(traffic.failures, 'failed requests').toEqual([]);
  expect(traffic.consoleErrors, 'console errors').toEqual([]);
}

async function isEnabled(locator: Locator): Promise<boolean> {
  return (await locator.isVisible()) && (await locator.isEnabled());
}

/** Answers the open choice sheet: picks options in order until Confirm is allowed, then confirms. */
async function answerChoice(sheet: Locator): Promise<void> {
  const confirm = sheet.getByTestId('choice-confirm');
  const options = sheet.locator(
    'label[data-testid^="choice-option-"]:not([data-testid="choice-option-none"])',
  );
  const count = await options.count();
  for (let i = 0; i < count && !(await confirm.isEnabled()); i += 1) {
    const option = options.nth(i);
    if ((await option.getAttribute('data-selected')) === 'true') continue;
    if (await option.locator('input').isDisabled()) continue;
    await option.click();
  }
  await expect(confirm, 'a valid selection enables Confirm').toBeEnabled();
  await confirm.click();
}

/** Plays the first hand card that has a move now; false if none has. */
async function playSomeCard(page: Page): Promise<boolean> {
  const cards = page.getByTestId('hand').locator('[data-testid^="hand-card-"]');
  const count = await cards.count();
  for (let i = 0; i < count; i += 1) {
    await cards.nth(i).click();
    const actions = page.getByTestId('card-actions');
    await expect(actions).toBeVisible();
    const move = actions.locator('button[data-testid^="card-"]:not([data-testid="card-deselect"])');
    if ((await move.count()) > 0 && (await move.first().isEnabled())) {
      await move.first().click();
      return true;
    }
    await actions.getByTestId('card-deselect').click();
    await expect(actions).toHaveCount(0);
  }
  return false;
}

/** Takes moves offered by the UI until the outcome card appears; returns the number of moves. */
async function playToTheEnd(page: Page): Promise<number> {
  const outcome = page.getByTestId('outcome');
  const sheet = page.locator('[data-testid="choice-sheet"]:not([hidden])');
  const openChoice = page.getByTestId('open-choice');
  const myTurn = page.locator('[data-testid="turn"][data-my-turn="true"]');
  const endTurn = page.getByTestId('global-endTurn');
  const mulligan = page.getByTestId('global-mulligan');
  let moves = 0;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    if (await outcome.isVisible()) return moves;
    if (await sheet.isVisible()) {
      await answerChoice(sheet);
      moves += 1;
      continue;
    }
    if (await openChoice.isVisible()) {
      await openChoice.click();
      continue;
    }
    if (!(await myTurn.isVisible())) {
      // The bot (or the round transition) is acting: wait until something is ours again.
      await expect(outcome.or(myTurn).or(sheet).or(openChoice).first()).toBeVisible({
        timeout: BOT_WAIT_MS,
      });
      continue;
    }
    if (await playSomeCard(page)) {
      moves += 1;
      continue;
    }
    if (await isEnabled(endTurn)) {
      await endTurn.click();
      moves += 1;
      continue;
    }
    if (await isEnabled(mulligan)) {
      await mulligan.click();
      moves += 1;
      continue;
    }
    // Our turn but nothing offered yet: let the view settle.
    await page.waitForTimeout(100);
  }
  throw new Error(`match did not end within ${MAX_PASSES} loop passes (${moves} moves taken)`);
}

test.describe('static build under a sub-path', () => {
  test('plays a whole solo match against the L1 bot with no server', async ({ context, page }) => {
    await context.addInitScript(
      ([key, value]) => {
        localStorage.setItem(key, value);
      },
      [PROGRESS_KEY, TUTORIAL_DONE] as const,
    );
    const traffic = watchTraffic(context, page);
    await page.goto(SUB_PATH);
    await page.getByTestId('menu-play').click();
    await expect(page.getByTestId('bot-levels')).toBeVisible();
    await page.getByTestId('bot-level-1').check();
    await expect(page.getByTestId('play-bot')).toContainText('L1');
    await page.getByTestId('play-bot').click();
    await expect(page.getByTestId('cartignon-table')).toBeVisible();
    await expect(page.getByTestId('tutorial-overlay')).toHaveCount(0);

    const moves = await playToTheEnd(page);
    expect(moves, 'the human took moves').toBeGreaterThan(0);
    await expect(page.getByTestId('outcome')).not.toBeEmpty();
    const result = (await page.getByTestId('outcome').innerText()).trim();
    test
      .info()
      .annotations.push({ type: 'outcome', description: `${result} after ${moves} moves` });
    await expect(page.getByTestId('back-home')).toBeVisible();
    expectOffline(traffic);
  });

  test('the tutorial starts on the first Play', async ({ context, page }) => {
    const traffic = watchTraffic(context, page);
    await page.goto(SUB_PATH);
    await page.getByTestId('menu-play').click();
    const overlay = page.getByTestId('tutorial-overlay');
    await expect(overlay).toBeVisible();
    await expect(overlay).toHaveAttribute('data-step', 'welcome');
    await expect(page.getByTestId('tutorial-progress')).toContainText('Step 1 of');
    await expect(page.getByTestId('cartignon-table')).toBeVisible();
    expectOffline(traffic);
  });
});
