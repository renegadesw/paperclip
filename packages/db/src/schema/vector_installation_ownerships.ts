import { pgTable, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Immutable ownership of one Vector-managed Paperclip company.
 *
 * Runtime pools use this immutable binding in their restrictive RLS policies.
 * The runtime role can read but cannot rewrite it. Startup also verifies the
 * profile and agent roster before acquiring installation-scoped ownership.
 */
export const vectorInstallationOwnerships = pgTable(
  "vector_installation_ownerships",
  {
    companyId: uuid("company_id")
      .primaryKey()
      .references(() => companies.id, { onDelete: "cascade" }),
    installationId: varchar("installation_id", { length: 64 }).notNull(),
    profile: varchar("profile", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    installationUq: uniqueIndex("vector_installation_ownerships_installation_uq").on(
      table.installationId,
    ),
  }),
);
