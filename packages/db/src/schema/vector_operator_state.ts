import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const llm = pgSchema("llm");

// Vector owns the user-facing tool semantics; Paperclip owns this additive
// migration because the tables become required state for its callback runs.
export const vectorPaperclipTodos = llm.table(
  "paperclip_todos",
  {
    todoId: uuid("todo_id").primaryKey().defaultRandom(),
    ownerId: text("owner_id").notNull(),
    sessionId: text("session_id").notNull().default(""),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    status: text("status").notNull().default("open"),
    createdBy: text("created_by").notNull(),
    startedSessionId: text("started_session_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ownerSessionUpdatedIdx: index("paperclip_todos_owner_session_updated_idx").on(table.ownerId, table.sessionId, table.updatedAt),
    statusCheck: check("paperclip_todos_status_check", sql`${table.status} IN ('open', 'in_progress', 'done', 'archived')`),
    creatorCheck: check("paperclip_todos_created_by_check", sql`${table.createdBy} IN ('user', 'agent')`),
    titleCheck: check("paperclip_todos_title_check", sql`length(btrim(${table.title})) BETWEEN 1 AND 500`),
  }),
);

export const vectorPaperclipQuestions = llm.table(
  "paperclip_questions",
  {
    questionId: uuid("question_id").primaryKey().defaultRandom(),
    ownerId: text("owner_id").notNull(),
    sessionId: text("session_id").notNull(),
    question: text("question").notNull(),
    choices: jsonb("choices"),
    answer: text("answer"),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ownerPendingIdx: index("paperclip_questions_owner_pending_idx").on(table.ownerId, table.answeredAt, table.cancelledAt, table.createdAt),
    questionCheck: check("paperclip_questions_question_check", sql`length(btrim(${table.question})) BETWEEN 1 AND 2000`),
    terminalCheck: check("paperclip_questions_terminal_check", sql`(
      (${table.answeredAt} IS NULL AND ${table.answer} IS NULL AND ${table.cancelledAt} IS NULL AND ${table.cancelReason} IS NULL)
      OR (${table.answeredAt} IS NOT NULL AND ${table.answer} IS NOT NULL AND ${table.cancelledAt} IS NULL AND ${table.cancelReason} IS NULL)
      OR (${table.answeredAt} IS NULL AND ${table.answer} IS NULL AND ${table.cancelledAt} IS NOT NULL AND ${table.cancelReason} IS NOT NULL)
    )`),
  }),
);
