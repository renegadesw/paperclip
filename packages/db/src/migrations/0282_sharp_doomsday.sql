CREATE SCHEMA IF NOT EXISTS "llm";
--> statement-breakpoint
CREATE TABLE "llm"."paperclip_questions" (
	"question_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"session_id" text NOT NULL,
	"question" text NOT NULL,
	"choices" jsonb,
	"answer" text,
	"answered_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paperclip_questions_question_check" CHECK (length(btrim("llm"."paperclip_questions"."question")) BETWEEN 1 AND 2000),
	CONSTRAINT "paperclip_questions_terminal_check" CHECK ((
      ("llm"."paperclip_questions"."answered_at" IS NULL AND "llm"."paperclip_questions"."answer" IS NULL AND "llm"."paperclip_questions"."cancelled_at" IS NULL AND "llm"."paperclip_questions"."cancel_reason" IS NULL)
      OR ("llm"."paperclip_questions"."answered_at" IS NOT NULL AND "llm"."paperclip_questions"."answer" IS NOT NULL AND "llm"."paperclip_questions"."cancelled_at" IS NULL AND "llm"."paperclip_questions"."cancel_reason" IS NULL)
      OR ("llm"."paperclip_questions"."answered_at" IS NULL AND "llm"."paperclip_questions"."answer" IS NULL AND "llm"."paperclip_questions"."cancelled_at" IS NOT NULL AND "llm"."paperclip_questions"."cancel_reason" IS NOT NULL)
    ))
);
--> statement-breakpoint
CREATE TABLE "llm"."paperclip_todos" (
	"todo_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"session_id" text DEFAULT '' NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_by" text NOT NULL,
	"started_session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paperclip_todos_status_check" CHECK ("llm"."paperclip_todos"."status" IN ('open', 'in_progress', 'done', 'archived')),
	CONSTRAINT "paperclip_todos_created_by_check" CHECK ("llm"."paperclip_todos"."created_by" IN ('user', 'agent')),
	CONSTRAINT "paperclip_todos_title_check" CHECK (length(btrim("llm"."paperclip_todos"."title")) BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE INDEX "paperclip_questions_owner_pending_idx" ON "llm"."paperclip_questions" USING btree ("owner_id","answered_at","cancelled_at","created_at");--> statement-breakpoint
CREATE INDEX "paperclip_todos_owner_session_updated_idx" ON "llm"."paperclip_todos" USING btree ("owner_id","session_id","updated_at");
