ALTER TABLE "vector_ingress_conversations" ADD COLUMN "model" varchar(256);--> statement-breakpoint
ALTER TABLE "vector_ingress_conversations" ADD COLUMN "thinking" varchar(16);--> statement-breakpoint
ALTER TABLE "vector_ingress_turns" ADD COLUMN "turn_id" bigint NOT NULL GENERATED ALWAYS AS IDENTITY (sequence name "vector_ingress_turns_turn_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1);--> statement-breakpoint
ALTER TABLE "vector_ingress_turns" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "vector_ingress_turns" ADD COLUMN "base_cursor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "vector_ingress_turns" ALTER COLUMN "base_cursor" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "vector_ingress_turns" ADD COLUMN "model" varchar(256);--> statement-breakpoint
ALTER TABLE "vector_ingress_turns" ADD COLUMN "thinking" varchar(16);--> statement-breakpoint
ALTER TABLE "vector_ingress_turns" ADD CONSTRAINT "vector_ingress_turns_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vector_ingress_turns_turn_id_uq" ON "vector_ingress_turns" USING btree ("turn_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vector_ingress_turns_run_id_uq" ON "vector_ingress_turns" USING btree ("run_id");
