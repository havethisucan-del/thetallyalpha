ALTER TABLE "match_snapshots" DROP CONSTRAINT "match_snapshots_rng";--> statement-breakpoint
ALTER TABLE "match_snapshots" ALTER COLUMN "rng_state" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "match_snapshots" ADD CONSTRAINT "match_snapshots_rng" CHECK ("match_snapshots"."rng_state" ~ '^[0-9a-f]{32}$' AND "match_snapshots"."rng_state" <> '00000000000000000000000000000000');