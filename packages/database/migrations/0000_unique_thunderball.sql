CREATE TYPE "public"."identity_kind" AS ENUM('guest');--> statement-breakpoint
CREATE TYPE "public"."match_kind" AS ENUM('private', 'casual');--> statement-breakpoint
CREATE TYPE "public"."match_status" AS ENUM('active', 'finished', 'aborted');--> statement-breakpoint
CREATE TABLE "identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "identity_kind" DEFAULT 'guest' NOT NULL,
	"display_name" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_actions" (
	"match_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"action_id" uuid NOT NULL,
	"seat" smallint NOT NULL,
	"action" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "match_actions_match_id_revision_pk" PRIMARY KEY("match_id","revision"),
	CONSTRAINT "match_actions_action_id_uq" UNIQUE("match_id","action_id"),
	CONSTRAINT "match_actions_revision" CHECK ("match_actions"."revision" >= 1),
	CONSTRAINT "match_actions_seat" CHECK ("match_actions"."seat" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE "match_participants" (
	"match_id" uuid NOT NULL,
	"seat" smallint NOT NULL,
	"identity_id" uuid NOT NULL,
	"pause_budget_ms" integer NOT NULL,
	"pause_used_ms" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "match_participants_match_id_seat_pk" PRIMARY KEY("match_id","seat"),
	CONSTRAINT "match_participants_identity_uq" UNIQUE("match_id","identity_id"),
	CONSTRAINT "match_participants_seat" CHECK ("match_participants"."seat" IN (0, 1)),
	CONSTRAINT "match_participants_pause" CHECK ("match_participants"."pause_used_ms" >= 0 AND "match_participants"."pause_budget_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "match_snapshots" (
	"match_id" uuid PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"rng_state" bigint NOT NULL,
	"state" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "match_snapshots_revision" CHECK ("match_snapshots"."revision" >= 0),
	CONSTRAINT "match_snapshots_rng" CHECK ("match_snapshots"."rng_state" BETWEEN 0 AND 4294967295)
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "match_kind" NOT NULL,
	"status" "match_status" DEFAULT 'active' NOT NULL,
	"rules_id" text NOT NULL,
	"rules_version" text NOT NULL,
	"outcome" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "matches_ended_consistent" CHECK (("matches"."status" = 'active') = ("matches"."ended_at" IS NULL)),
	CONSTRAINT "matches_outcome_only_finished" CHECK ("matches"."outcome" IS NULL OR "matches"."status" = 'finished')
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identity_id" uuid NOT NULL,
	"token_hash" char(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "match_actions" ADD CONSTRAINT "match_actions_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_participants" ADD CONSTRAINT "match_participants_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_participants" ADD CONSTRAINT "match_participants_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_snapshots" ADD CONSTRAINT "match_snapshots_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "match_participants_identity_idx" ON "match_participants" USING btree ("identity_id");--> statement-breakpoint
CREATE INDEX "matches_status_idx" ON "matches" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sessions_identity_idx" ON "sessions" USING btree ("identity_id");