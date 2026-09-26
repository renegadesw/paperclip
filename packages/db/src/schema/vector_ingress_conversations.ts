import {
  bigint,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issueComments } from "./issue_comments.js";
import { issues } from "./issues.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/**
 * Private lookup metadata for Vector's signed loopback ingress.
 *
 * The opaque owner handle is never stored. Its digest groups conversations
 * for one authenticated Vector owner, while the non-secret client session ID
 * is retained solely so inventory can return the identifier NexusLink owns.
 */
export const vectorIngressConversations = pgTable(
  "vector_ingress_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    installationId: varchar("installation_id", { length: 256 }).notNull(),
    profileId: varchar("profile_id", { length: 256 }).notNull(),
    ownerSha256: varchar("owner_sha256", { length: 64 }).notNull(),
    externalSessionId: varchar("external_session_id", { length: 512 }).notNull(),
    model: varchar("model", { length: 256 }),
    thinking: varchar("thinking", { length: 16 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    issueUq: uniqueIndex("vector_ingress_conversations_issue_uq").on(
      table.issueId,
    ),
    ownerSessionUq: uniqueIndex(
      "vector_ingress_conversations_owner_session_uq",
    ).on(
      table.companyId,
      table.agentId,
      table.installationId,
      table.profileId,
      table.ownerSha256,
      table.externalSessionId,
    ),
    ownerCreatedIdx: index(
      "vector_ingress_conversations_owner_created_idx",
    ).on(
      table.companyId,
      table.agentId,
      table.installationId,
      table.profileId,
      table.ownerSha256,
      table.createdAt,
      table.externalSessionId,
    ),
  }),
);

/**
 * Exact provenance for user turns accepted through Vector ingress.
 *
 * Paperclip issue threads may also contain board/operator comments. Keeping a
 * dedicated edge prevents transcript replay from relabeling those comments as
 * NexusLink user turns.
 */
export const vectorIngressTurns = pgTable(
  "vector_ingress_turns",
  {
    commentId: uuid("comment_id")
      .primaryKey()
      .references(() => issueComments.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => vectorIngressConversations.id, { onDelete: "cascade" }),
    turnId: bigint("turn_id", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    baseCursor: bigint("base_cursor", { mode: "number" }).notNull(),
    model: varchar("model", { length: 256 }),
    thinking: varchar("thinking", { length: 16 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    conversationCreatedIdx: index(
      "vector_ingress_turns_conversation_created_idx",
    ).on(table.conversationId, table.createdAt, table.commentId),
    turnIdUq: uniqueIndex("vector_ingress_turns_turn_id_uq").on(table.turnId),
    runIdUq: uniqueIndex("vector_ingress_turns_run_id_uq").on(table.runId),
  }),
);
