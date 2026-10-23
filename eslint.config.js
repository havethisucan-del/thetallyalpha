import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '.claude/**', 'docs/**'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: { allowDefaultProject: ['*.js', '*.ts', 'packages/*/*.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    // Layer boundaries: shared packages stay framework-independent.
    files: ['packages/game-core/src/**', 'packages/protocol/src/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(colyseus|@colyseus/|react|react-dom|phaser|express|pg|drizzle-orm|node:)',
              message: 'Shared packages must not depend on frameworks, I/O or Node APIs.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/game-core/src/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ regex: '^[^.]', message: 'game-core has no runtime dependencies.' }] },
      ],
    },
  },
  {
    // ADR-0016: the bot runs in the browser (and in Node tools/tests): it depends on game-core
    // only, and on no framework, I/O or Node API. Node-only code lives in packages/ai/tools/.
    files: ['packages/ai/src/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?!@cartignon/game-core$)[^.]',
              message: 'ai depends only on @cartignon/game-core (browser-safe, no Node APIs).',
            },
          ],
        },
      ],
    },
  },
  {
    // ADR-0016: only the web client may depend on the bot (separate rule name, so it does not
    // replace the `no-restricted-imports` layer rules above).
    files: ['packages/*/src/**', 'apps/*/src/**'],
    ignores: ['packages/ai/**', 'apps/web/**'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^@cartignon/ai(/|$)',
              message: 'Only apps/web may depend on @cartignon/ai (ADR-0016).',
            },
          ],
        },
      ],
    },
  },
  {
    // Small-integer test seeds are brute-forceable: production app code must seed from CSPRNG
    // bytes (createRngFromSeedBytes) or resume (createRngFromState). Tests may still use them.
    files: ['apps/*/src/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@cartignon/game-core',
              importNames: ['createSeededRng', 'expandTestSeed'],
              message:
                'Test/dev-only RNG seeding; use createRngFromSeedBytes(randomBytes(16)) or createRngFromState.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
