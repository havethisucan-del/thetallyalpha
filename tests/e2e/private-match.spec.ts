import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

// Acceptance criterion #16: two independent guests play a private synthetic match end to end.
// Each player gets its own browser context, i.e. its own cookie jar and guest session.

const INVITE_CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;
const ROOM_FULL_MESSAGE = 'That room is already full.';
// Sums to the default target (10), uses every button, and gives each player three moves.
const MOVES = [1, 2, 1, 3, 1, 2] as const;
const ERROR_BANNERS = ['room-error', 'home-error', 'session-error'] as const;
// The only browser log lines a healthy run produces: the first-visit session probe answers 401
// before the guest is created (ApiClient.ensureSession), and C's rejected join answers 409.
const SESSION_PROBE_401 =
  'Failed to load resource: the server responded with a status of 401 (Unauthorized)';
const ROOM_FULL_409 =
  'Failed to load resource: the server responded with a status of 409 (Conflict)';

interface Player {
  readonly label: string;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly consoleErrors: string[];
}

interface SeenBanner {
  readonly id: string;
  readonly text: string;
}

/**
 * Runs in the page before any app code: records every error banner that is ever rendered (even
 * briefly), so a transient or stale banner between two checkpoints is caught as well.
 */
function recordErrorBanners(ids: readonly string[]): void {
  const seen: SeenBanner[] = [];
  (window as unknown as { __seenBanners: SeenBanner[] }).__seenBanners = seen;
  const selector = ids.map((id) => `[data-testid="${id}"]`).join(',');
  const known = new WeakMap<Element, string>();
  const scan = () => {
    for (const element of document.querySelectorAll(selector)) {
      const text = element.textContent.trim();
      if (known.get(element) === text) continue;
      known.set(element, text);
      seen.push({ id: element.getAttribute('data-testid') ?? '?', text });
    }
  };
  new MutationObserver(scan).observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
  });
}

async function seenBanners(page: Page): Promise<SeenBanner[]> {
  return page.evaluate(
    () => (window as unknown as { __seenBanners?: SeenBanner[] }).__seenBanners ?? [],
  );
}

/** No error banner is shown now; once in a room, the connection status is "connected". */
async function expectHealthy(player: Player, inRoom: boolean): Promise<void> {
  for (const id of ERROR_BANNERS) {
    await expect(player.page.getByTestId(id), `${id} on ${player.label}`).toHaveCount(0);
  }
  if (inRoom) {
    await expect(
      player.page.getByTestId('connection-status'),
      `connection on ${player.label}`,
    ).toHaveAttribute('data-status', 'connected');
  }
}

async function openGuest(browser: Browser, label: string): Promise<Player> {
  const context = await browser.newContext();
  // ADR-0018: the first Play click would open the tutorial; this scenario is about online play.
  await context.addInitScript(() => {
    localStorage.setItem('cartignon.tutorial', JSON.stringify({ v: 1, status: 'completed' }));
  });
  await context.addInitScript(recordErrorBanners, ERROR_BANNERS);
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => {
    consoleErrors.push(`pageerror: ${error.message}`);
  });
  await page.goto('/');
  await page.getByTestId('menu-play').click();
  await expect(page.getByTestId('guest-name')).toHaveText(/\S/);
  const player = { label, context, page, consoleErrors };
  await expectHealthy(player, false);
  return player;
}

/** Seat index of the player's own seat in the lobby (the one marked data-me="true"). */
async function mySeat(page: Page): Promise<0 | 1> {
  const mine = page.locator('[data-testid^="seat-"][data-me="true"]');
  await expect(mine).toHaveCount(1);
  return (await mine.getAttribute('data-testid')) === 'seat-0' ? 0 : 1;
}

function secrets(page: Page) {
  return page.getByTestId('my-secrets').locator('li');
}

async function secretTexts(page: Page): Promise<string[]> {
  if ((await page.getByTestId('my-secrets').count()) === 0) return [];
  return (await secrets(page).allInnerTexts()).map((text) => text.trim());
}

async function expectButtons(page: Page, enabled: boolean): Promise<void> {
  for (const amount of [1, 2, 3]) {
    const button = page.getByTestId(`increment-${amount}`);
    if (enabled) await expect(button).toBeEnabled();
    else await expect(button).toBeDisabled();
  }
}

test('two guests create, join and finish a private match', async ({ browser }, testInfo) => {
  const players: Player[] = [];
  try {
    const a = await openGuest(browser, 'A');
    players.push(a);
    const b = await openGuest(browser, 'B');
    players.push(b);
    const nameA = (await a.page.getByTestId('guest-name').innerText()).trim();
    const nameB = (await b.page.getByTestId('guest-name').innerText()).trim();

    // The two contexts really are two guest sessions (separate session cookies).
    const cookiesA = (await a.context.cookies()).map((c) => `${c.name}=${c.value}`);
    const cookiesB = (await b.context.cookies()).map((c) => `${c.name}=${c.value}`);
    expect(cookiesA.length).toBeGreaterThan(0);
    expect(cookiesA.some((cookie) => cookiesB.includes(cookie))).toBe(false);

    // --- A creates a private room and reads the invite code.
    await a.page.getByTestId('create-room').click();
    const inviteA = a.page.getByTestId('invite-code');
    await expect(inviteA).toHaveText(INVITE_CODE);
    const code = (await inviteA.innerText()).trim();
    await expectHealthy(a, true);

    // --- B joins with the code.
    await b.page.getByTestId('join-code-input').fill(code);
    await b.page.getByTestId('join-room').click();
    await expect(b.page.getByTestId('invite-code')).toHaveText(code);
    await expectHealthy(a, true);
    await expectHealthy(b, true);

    // --- Both see each other in the lobby, online and not ready.
    const seatA = await mySeat(a.page);
    const seatB = await mySeat(b.page);
    expect(seatB).toBe(seatA === 0 ? 1 : 0);
    for (const player of [a, b]) {
      const { page } = player;
      await expect(page.getByTestId(`seat-${seatA}`)).toContainText(nameA);
      await expect(page.getByTestId(`seat-${seatB}`)).toContainText(nameB);
      for (const seat of [0, 1]) {
        await expect(page.getByTestId(`seat-${seat}-connected`)).toHaveText('Online');
        await expect(page.getByTestId(`seat-${seat}-ready`)).toHaveText('Not ready');
      }
      await expect(page.getByTestId('phase')).toHaveAttribute('data-phase', 'lobby');
      await expectHealthy(player, true);
    }

    // --- A third guest cannot join the full room.
    const c = await openGuest(browser, 'C');
    players.push(c);
    await c.page.getByTestId('join-code-input').fill(code);
    await c.page.getByTestId('join-room').click();
    await expect(c.page.getByTestId('home-error')).toHaveText(ROOM_FULL_MESSAGE);
    await expect(c.page.getByTestId('create-room')).toBeVisible(); // still on the home screen
    await expect(c.page.getByTestId('room-error')).toHaveCount(0);
    await expect(c.page.getByTestId('session-error')).toHaveCount(0);
    // ...and the two seated players are unaffected.
    await expect(a.page.getByTestId(`seat-${seatB}`)).toContainText(nameB);
    await expect(b.page.getByTestId(`seat-${seatA}`)).toContainText(nameA);
    await expectHealthy(a, true);
    await expectHealthy(b, true);

    // --- Both press Ready and reach the match screen.
    await a.page.getByTestId('ready-toggle').click();
    await expect(b.page.getByTestId(`seat-${seatA}-ready`)).toHaveText('Ready');
    await expectHealthy(a, true);
    await expectHealthy(b, true);
    await b.page.getByTestId('ready-toggle').click();
    for (const player of [a, b]) {
      const { page } = player;
      await expect(page.getByTestId('match-canvas')).toBeVisible();
      await expect(page.getByTestId('turn')).toBeVisible();
      await expect(page.getByTestId('phase')).not.toHaveAttribute('data-phase', 'finished');
      await expect(page.getByTestId('outcome')).toHaveCount(0);
      await expectHealthy(player, true);
    }

    // --- Play to the end; only the active player's buttons are enabled.
    const moves = { A: 0, B: 0 };
    let lastMover: Player | undefined;
    for (const [index, amount] of MOVES.entries()) {
      const aTurn = a.page.getByTestId('turn');
      await expect(aTurn).toHaveAttribute('data-my-turn', /^(true|false)$/);
      const active = (await aTurn.getAttribute('data-my-turn')) === 'true' ? a : b;
      const waiting = active === a ? b : a;
      await expect(active.page.getByTestId('turn')).toHaveText('Your turn');
      await expect(waiting.page.getByTestId('turn')).toHaveAttribute('data-my-turn', 'false');
      await expect(waiting.page.getByTestId('turn')).toHaveText("Opponent's turn");
      await expectButtons(active.page, true);
      await expectButtons(waiting.page, false);
      await expectHealthy(active, true);
      await expectHealthy(waiting, true);

      await active.page.getByTestId(`increment-${amount}`).click();
      moves[active.label as 'A' | 'B'] += 1;
      lastMover = active;

      await expect(active.page.getByTestId('action-result')).toContainText('Accepted');
      if (index < MOVES.length - 1) {
        await expect(waiting.page.getByTestId('turn')).toHaveAttribute('data-my-turn', 'true');
        await expect(active.page.getByTestId('turn')).toHaveAttribute('data-my-turn', 'false');
      }
      // Each move draws one hidden secret for the mover only.
      await expect(secrets(active.page)).toHaveCount(moves[active.label as 'A' | 'B']);
      const waitingMoves = moves[waiting.label as 'A' | 'B'];
      if (waitingMoves === 0) await expect(waiting.page.getByTestId('my-secrets')).toHaveCount(0);
      else await expect(secrets(waiting.page)).toHaveCount(waitingMoves);
      await expectHealthy(active, true);
      await expectHealthy(waiting, true);
    }
    expect(moves).toEqual({ A: 3, B: 3 });
    if (lastMover === undefined) throw new Error('no move was made');
    const loser = lastMover === a ? b : a;

    // --- Both see the outcome: the last mover reached the target.
    await expect(lastMover.page.getByTestId('outcome')).toHaveText('You won');
    await expect(loser.page.getByTestId('outcome')).toHaveText('Your opponent won');
    for (const player of [a, b]) {
      const { page } = player;
      await expect(page.getByTestId('phase')).toHaveAttribute('data-phase', 'finished');
      await expect(page.getByTestId('turn')).toHaveAttribute('data-my-turn', 'false');
      await expectButtons(page, false);
      await expect(page.getByTestId('back-home')).toBeVisible();
      await expectHealthy(player, true);
    }

    // --- Hidden information: neither page shows the other player's secrets.
    const secretsA = await secretTexts(a.page);
    const secretsB = await secretTexts(b.page);
    expect(secretsA).toHaveLength(3);
    expect(secretsB).toHaveLength(3);
    for (const value of [...secretsA, ...secretsB]) expect(value).toMatch(/^\d{1,3}$/);
    const listTextA = (await a.page.getByTestId('my-secrets').innerText()).trim();
    const listTextB = (await b.page.getByTestId('my-secrets').innerText()).trim();
    expect(listTextA).not.toBe(listTextB);
    expect(await b.page.locator('body').innerText()).not.toContain(listTextA);
    expect(await a.page.locator('body').innerText()).not.toContain(listTextB);
    // The only secrets list on each page holds that player's own three values.
    await expect(a.page.getByTestId('my-secrets')).toHaveCount(1);
    await expect(b.page.getByTestId('my-secrets')).toHaveCount(1);

    // --- No error banner was rendered at any time, not even briefly; C saw only ROOM_FULL.
    expect(await seenBanners(a.page), 'error banners ever shown on A').toEqual([]);
    expect(await seenBanners(b.page), 'error banners ever shown on B').toEqual([]);
    expect(await seenBanners(c.page), 'error banners ever shown on C').toEqual([
      { id: 'home-error', text: ROOM_FULL_MESSAGE },
    ]);

    // --- Browser console: exactly the expected lines, nothing else.
    expect(a.consoleErrors, 'console errors on A').toEqual([SESSION_PROBE_401]);
    expect(b.consoleErrors, 'console errors on B').toEqual([SESSION_PROBE_401]);
    expect(c.consoleErrors, 'console errors on C').toEqual([SESSION_PROBE_401, ROOM_FULL_409]);
  } finally {
    for (const player of players) {
      if (player.consoleErrors.length > 0) {
        await testInfo.attach(`console-${player.label}`, {
          body: player.consoleErrors.join('\n'),
          contentType: 'text/plain',
        });
      }
      await player.context.close();
    }
  }
});
