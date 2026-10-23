import { defineConfig } from 'drizzle-kit';

// `generate` only diffs the schema against existing migration files; it needs no database.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  strict: true,
});
