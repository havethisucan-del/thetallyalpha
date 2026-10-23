import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { rulesFor, selectRules } from '../src/rooms/rules.js';

const DATABASE_URL = 'postgres://user:placeholder@127.0.0.1:5432/db';

describe('MATCH_RULES', () => {
  it('defaults to cartignon and accepts synthetic', () => {
    expect(loadConfig({ DATABASE_URL }).matchRules).toBe('cartignon');
    expect(loadConfig({ DATABASE_URL, MATCH_RULES: '' }).matchRules).toBe('cartignon');
    expect(loadConfig({ DATABASE_URL, MATCH_RULES: 'synthetic' }).matchRules).toBe('synthetic');
  });

  it('rejects unknown rules without echoing the value', () => {
    expect(() => loadConfig({ DATABASE_URL, MATCH_RULES: 'chess' })).toThrow(ConfigError);
    expect(() => loadConfig({ DATABASE_URL, MATCH_RULES: 'chess' })).toThrow(/MATCH_RULES/);
  });

  it('refuses synthetic rules in production (fail closed)', () => {
    const prod = {
      DATABASE_URL,
      NODE_ENV: 'production',
      ALLOWED_ORIGINS: 'https://game.example',
      COOKIE_SECURE: 'true',
    };
    expect(loadConfig(prod).matchRules).toBe('cartignon');
    expect(loadConfig({ ...prod, MATCH_RULES: 'cartignon' }).matchRules).toBe('cartignon');
    const synthetic = () => loadConfig({ ...prod, MATCH_RULES: 'synthetic' });
    expect(synthetic).toThrow(ConfigError);
    // A fixed message; no environment value (e.g. the DATABASE_URL password) is echoed.
    expect(synthetic).toThrow(
      'Invalid configuration:\n  MATCH_RULES: synthetic rules are not allowed in production',
    );
    expect(synthetic).not.toThrow(/placeholder|game\.example/);
  });
});

describe('selectRules', () => {
  it('builds the Cartignon module from the shipped catalog and keeps the synthetic one', () => {
    const cartignon = selectRules('cartignon');
    expect(cartignon.current.rulesId).toBe('cartignon');
    expect(cartignon.current.rulesVersion).toMatch(/^2\+cards\.[0-9a-f]{8}$/);
    expect(selectRules('synthetic').current.rulesId).toBe('synthetic');
    // Resumed snapshots resolve by rulesId, whichever module starts new matches.
    expect(rulesFor(cartignon, { rulesId: 'synthetic' })?.rulesId).toBe('synthetic');
    expect(rulesFor(cartignon, { rulesId: 'cartignon' })).toBe(cartignon.current);
    expect(rulesFor(cartignon, { rulesId: 'unknown' })).toBeUndefined();
  });
});
