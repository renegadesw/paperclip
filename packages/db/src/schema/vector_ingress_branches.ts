import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { vectorIngressConversations, vectorIngressTurns } from "./vector_ingress_conversations.js";

/** Retained, provider-authentic Pi JSONL branches for one Vector conversation generation. */
export const vectorIngressBranches = pgTable(
  "vector_ingress_branches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => vectorIngressConversations.id, { onDelete: "cascade" }),
    sessionGeneration: integer("session_generation").notNull(),
    parentBranchId: uuid("parent_branch_id").references(
      (): AnyPgColumn => vectorIngressBranches.id,
      { onDelete: "restrict" },
    ),
    sessionParamsJson: jsonb("session_params_json").$type<Record<string, unknown>>().notNull(),
    sessionDisplayId: text("session_display_id"),
    piSessionId: varchar("pi_session_id", { length: 256 }).notNull(),
    forkEntryId: varchar("fork_entry_id", { length: 256 }),
    forkText: text("fork_text"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    generationCheck: check("vector_ingress_branches_generation_check", sql`${table.sessionGeneration} >= 0`),
    ownerIdUq: unique("vector_ingress_branches_owner_id_uq").on(
      table.companyId,
      table.conversationId,
      table.sessionGeneration,
      table.id,
    ),
    generationCreatedIdx: index("vector_ingress_branches_generation_created_idx").on(
      table.companyId,
      table.conversationId,
      table.sessionGeneration,
      table.createdAt,
      table.id,
    ),
    providerSessionUq: uniqueIndex("vector_ingress_branches_provider_session_uq").on(
      table.companyId,
      table.conversationId,
      table.sessionGeneration,
      table.piSessionId,
    ),
  }),
);

/**
 * One generation-scoped active branch and a crash-expiring control fence.
 *
 * The fence is durable so a concurrent turn cannot start between the idle
 * check and Pi's filesystem mutation. Every commit rechecks its operation id.
 */
export const vectorIngressBranchHeads = pgTable(
  "vector_ingress_branch_heads",
  {
    companyId: uuid("company_id").notNull().references(() => companies.id),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => vectorIngressConversations.id, { onDelete: "cascade" }),
    sessionGeneration: integer("session_generation").notNull(),
    activeBranchId: uuid("active_branch_id"),
    controlOperationId: uuid("control_operation_id"),
    controlKind: varchar("control_kind", { length: 16 }),
    controlExpiresAt: timestamp("control_expires_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      name: "vector_ingress_branch_heads_pk",
      columns: [table.companyId, table.conversationId, table.sessionGeneration],
    }),
    generationCheck: check("vector_ingress_branch_heads_generation_check", sql`${table.sessionGeneration} >= 0`),
    controlShapeCheck: check(
      "vector_ingress_branch_heads_control_shape_check",
      sql`(${table.controlOperationId} IS NULL AND ${table.controlKind} IS NULL AND ${table.controlExpiresAt} IS NULL) OR (${table.controlOperationId} IS NOT NULL AND ${table.controlKind} IN ('list','fork','switch') AND ${table.controlExpiresAt} IS NOT NULL)`,
    ),
    activeOwnerFk: foreignKey({
      columns: [table.companyId, table.conversationId, table.sessionGeneration, table.activeBranchId],
      foreignColumns: [
        vectorIngressBranches.companyId,
        vectorIngressBranches.conversationId,
        vectorIngressBranches.sessionGeneration,
        vectorIngressBranches.id,
      ],
      name: "vector_ingress_branch_heads_active_owner_fk",
    }),
    conversationGenerationIdx: index("vector_ingress_branch_heads_conversation_generation_idx").on(
      table.conversationId,
      table.sessionGeneration,
    ),
  }),
);

/** Ordered projection of immutable accepted turns onto a retained Pi branch. */
export const vectorIngressBranchTurns = pgTable(
  "vector_ingress_branch_turns",
  {
    companyId: uuid("company_id").notNull().references(() => companies.id),
    conversationId: uuid("conversation_id").notNull(),
    sessionGeneration: integer("session_generation").notNull(),
    branchId: uuid("branch_id").notNull(),
    commentId: uuid("comment_id")
      .notNull()
      .references(() => vectorIngressTurns.commentId, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      name: "vector_ingress_branch_turns_pk",
      columns: [table.branchId, table.commentId],
    }),
    ordinalCheck: check("vector_ingress_branch_turns_ordinal_check", sql`${table.ordinal} >= 0`),
    branchOrdinalUq: uniqueIndex("vector_ingress_branch_turns_branch_ordinal_uq").on(
      table.branchId,
      table.ordinal,
    ),
    branchOwnerFk: foreignKey({
      columns: [table.companyId, table.conversationId, table.sessionGeneration, table.branchId],
      foreignColumns: [
        vectorIngressBranches.companyId,
        vectorIngressBranches.conversationId,
        vectorIngressBranches.sessionGeneration,
        vectorIngressBranches.id,
      ],
      name: "vector_ingress_branch_turns_branch_owner_fk",
    }).onDelete("cascade"),
    ownerOrdinalIdx: index("vector_ingress_branch_turns_owner_ordinal_idx").on(
      table.companyId,
      table.conversationId,
      table.sessionGeneration,
      table.branchId,
      table.ordinal,
    ),
    commentIdx: index("vector_ingress_branch_turns_comment_idx").on(table.commentId),
  }),
);
