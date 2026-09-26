DROP INDEX "environments_local_driver_idx";--> statement-breakpoint
DROP INDEX "environments_managed_sandbox_idx";--> statement-breakpoint
DROP INDEX "environments_name_idx";--> statement-breakpoint
DROP INDEX "instance_settings_singleton_key_idx";--> statement-breakpoint
DROP INDEX "plugins_plugin_key_idx";--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "vector_installation_id" text DEFAULT coalesce(current_setting('paperclip.installation_id', true), '') NOT NULL;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "vector_installation_id" text DEFAULT coalesce(current_setting('paperclip.installation_id', true), '') NOT NULL;--> statement-breakpoint
ALTER TABLE "plugins" ADD COLUMN "vector_installation_id" text DEFAULT coalesce(current_setting('paperclip.installation_id', true), '') NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "environments_local_driver_idx" ON "environments" USING btree ("vector_installation_id","driver") WHERE "environments"."driver" = 'local';--> statement-breakpoint
CREATE UNIQUE INDEX "environments_managed_sandbox_idx" ON "environments" USING btree ("vector_installation_id","driver") WHERE "environments"."driver" = 'sandbox' AND ("environments"."metadata" ->> 'managedByPaperclip')::boolean = true;--> statement-breakpoint
CREATE UNIQUE INDEX "environments_name_idx" ON "environments" USING btree ("vector_installation_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "instance_settings_singleton_key_idx" ON "instance_settings" USING btree ("vector_installation_id","singleton_key");--> statement-breakpoint
CREATE UNIQUE INDEX "plugins_plugin_key_idx" ON "plugins" USING btree ("vector_installation_id","plugin_key");