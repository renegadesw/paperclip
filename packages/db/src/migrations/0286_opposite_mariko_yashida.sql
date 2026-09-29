CREATE TABLE "vector_ingress_branch_heads" (
	"company_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"session_generation" integer NOT NULL,
	"active_branch_id" uuid,
	"control_operation_id" uuid,
	"control_kind" varchar(16),
	"control_expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vector_ingress_branch_heads_pk" PRIMARY KEY("company_id","conversation_id","session_generation"),
	CONSTRAINT "vector_ingress_branch_heads_generation_check" CHECK ("vector_ingress_branch_heads"."session_generation" >= 0),
	CONSTRAINT "vector_ingress_branch_heads_control_shape_check" CHECK (("vector_ingress_branch_heads"."control_operation_id" IS NULL AND "vector_ingress_branch_heads"."control_kind" IS NULL AND "vector_ingress_branch_heads"."control_expires_at" IS NULL) OR ("vector_ingress_branch_heads"."control_operation_id" IS NOT NULL AND "vector_ingress_branch_heads"."control_kind" IN ('list','fork','switch') AND "vector_ingress_branch_heads"."control_expires_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "vector_ingress_branch_turns" (
	"company_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"session_generation" integer NOT NULL,
	"branch_id" uuid NOT NULL,
	"comment_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vector_ingress_branch_turns_pk" PRIMARY KEY("branch_id","comment_id"),
	CONSTRAINT "vector_ingress_branch_turns_ordinal_check" CHECK ("vector_ingress_branch_turns"."ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "vector_ingress_branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"session_generation" integer NOT NULL,
	"parent_branch_id" uuid,
	"session_params_json" jsonb NOT NULL,
	"session_display_id" text,
	"pi_session_id" varchar(256) NOT NULL,
	"fork_entry_id" varchar(256),
	"fork_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vector_ingress_branches_owner_id_uq" UNIQUE("company_id","conversation_id","session_generation","id"),
	CONSTRAINT "vector_ingress_branches_generation_check" CHECK ("vector_ingress_branches"."session_generation" >= 0)
);
--> statement-breakpoint
ALTER TABLE "vector_ingress_branch_heads" ADD CONSTRAINT "vector_ingress_branch_heads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vector_ingress_branch_heads" ADD CONSTRAINT "vector_ingress_branch_heads_conversation_id_vector_ingress_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."vector_ingress_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vector_ingress_branch_heads" ADD CONSTRAINT "vector_ingress_branch_heads_active_owner_fk" FOREIGN KEY ("company_id","conversation_id","session_generation","active_branch_id") REFERENCES "public"."vector_ingress_branches"("company_id","conversation_id","session_generation","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vector_ingress_branch_turns" ADD CONSTRAINT "vector_ingress_branch_turns_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vector_ingress_branch_turns" ADD CONSTRAINT "vector_ingress_branch_turns_comment_id_vector_ingress_turns_comment_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."vector_ingress_turns"("comment_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vector_ingress_branch_turns" ADD CONSTRAINT "vector_ingress_branch_turns_branch_owner_fk" FOREIGN KEY ("company_id","conversation_id","session_generation","branch_id") REFERENCES "public"."vector_ingress_branches"("company_id","conversation_id","session_generation","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vector_ingress_branches" ADD CONSTRAINT "vector_ingress_branches_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vector_ingress_branches" ADD CONSTRAINT "vector_ingress_branches_conversation_id_vector_ingress_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."vector_ingress_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vector_ingress_branches" ADD CONSTRAINT "vector_ingress_branches_parent_branch_id_vector_ingress_branches_id_fk" FOREIGN KEY ("parent_branch_id") REFERENCES "public"."vector_ingress_branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vector_ingress_branch_heads_conversation_generation_idx" ON "vector_ingress_branch_heads" USING btree ("conversation_id","session_generation");--> statement-breakpoint
CREATE UNIQUE INDEX "vector_ingress_branch_turns_branch_ordinal_uq" ON "vector_ingress_branch_turns" USING btree ("branch_id","ordinal");--> statement-breakpoint
CREATE INDEX "vector_ingress_branch_turns_owner_ordinal_idx" ON "vector_ingress_branch_turns" USING btree ("company_id","conversation_id","session_generation","branch_id","ordinal");--> statement-breakpoint
CREATE INDEX "vector_ingress_branch_turns_comment_idx" ON "vector_ingress_branch_turns" USING btree ("comment_id");--> statement-breakpoint
CREATE INDEX "vector_ingress_branches_generation_created_idx" ON "vector_ingress_branches" USING btree ("company_id","conversation_id","session_generation","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "vector_ingress_branches_provider_session_uq" ON "vector_ingress_branches" USING btree ("company_id","conversation_id","session_generation","pi_session_id");