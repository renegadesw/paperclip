CREATE TABLE "vector_ingress_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"installation_id" varchar(256) NOT NULL,
	"profile_id" varchar(256) NOT NULL,
	"owner_sha256" varchar(64) NOT NULL,
	"external_session_id" varchar(512) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vector_ingress_turns" (
	"comment_id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vector_ingress_conversations" ADD CONSTRAINT "vector_ingress_conversations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vector_ingress_conversations" ADD CONSTRAINT "vector_ingress_conversations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vector_ingress_conversations" ADD CONSTRAINT "vector_ingress_conversations_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vector_ingress_turns" ADD CONSTRAINT "vector_ingress_turns_comment_id_issue_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vector_ingress_turns" ADD CONSTRAINT "vector_ingress_turns_conversation_id_vector_ingress_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."vector_ingress_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vector_ingress_conversations_issue_uq" ON "vector_ingress_conversations" USING btree ("issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vector_ingress_conversations_owner_session_uq" ON "vector_ingress_conversations" USING btree ("company_id","agent_id","installation_id","profile_id","owner_sha256","external_session_id");--> statement-breakpoint
CREATE INDEX "vector_ingress_conversations_owner_created_idx" ON "vector_ingress_conversations" USING btree ("company_id","agent_id","installation_id","profile_id","owner_sha256","created_at","external_session_id");--> statement-breakpoint
CREATE INDEX "vector_ingress_turns_conversation_created_idx" ON "vector_ingress_turns" USING btree ("conversation_id","created_at","comment_id");