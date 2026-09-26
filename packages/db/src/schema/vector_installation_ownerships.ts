import { pgTable, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Immutable ownership of one Vector-managed Paperclip company.
 *
 * This is deliberately narrower than execution isolation. The existing
 * vector-embedded singleton remains the process-level scheduler guard; this
 * binding prevents a process from starting against another installation's
 * provisioned company while later execution-path scoping is audited.
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
