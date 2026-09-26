DROP INDEX "account_issuer_account_id_uq";--> statement-breakpoint
-- 0279 created the inline primary key with PostgreSQL's default name.
ALTER TABLE "announcement_publications" DROP CONSTRAINT "announcement_publications_pkey";--> statement-breakpoint
ALTER TABLE "announcement_dismissals" ADD COLUMN "vector_installation_id" text DEFAULT coalesce(current_setting('paperclip.installation_id', true), '') NOT NULL;--> statement-breakpoint
ALTER TABLE "announcement_publications" ADD COLUMN "vector_installation_id" text DEFAULT coalesce(current_setting('paperclip.installation_id', true), '') NOT NULL;--> statement-breakpoint
ALTER TABLE "announcement_publications" ADD CONSTRAINT "announcement_publications_vector_installation_id_announcement_id_pk" PRIMARY KEY("vector_installation_id","announcement_id");--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "vector_installation_id" text DEFAULT coalesce(current_setting('paperclip.installation_id', true), '') NOT NULL;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "vector_installation_id" text DEFAULT coalesce(current_setting('paperclip.installation_id', true), '') NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "vector_installation_id" text DEFAULT coalesce(current_setting('paperclip.installation_id', true), '') NOT NULL;--> statement-breakpoint
ALTER TABLE "verification" ADD COLUMN "vector_installation_id" text DEFAULT coalesce(current_setting('paperclip.installation_id', true), '') NOT NULL;--> statement-breakpoint
ALTER TABLE "board_api_keys" ADD COLUMN "vector_installation_id" text DEFAULT coalesce(current_setting('paperclip.installation_id', true), '') NOT NULL;--> statement-breakpoint
ALTER TABLE "instance_user_roles" ADD COLUMN "vector_installation_id" text DEFAULT coalesce(current_setting('paperclip.installation_id', true), '') NOT NULL;--> statement-breakpoint
ALTER TABLE "user_sidebar_preferences" ADD COLUMN "vector_installation_id" text DEFAULT coalesce(current_setting('paperclip.installation_id', true), '') NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "account_issuer_account_id_uq" ON "account" USING btree ("vector_installation_id","issuer","account_id");
