import { pgTable, text, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { vectorInstallationColumn } from "../vector-installation-column.js";

// Only IDs from a validated feed are registered. This durable allowlist keeps
// offline dismissal retries working without accepting caller-invented IDs.
// It contains no announcement content, account data or interaction events.
export const announcementPublications = pgTable("announcement_publications", {
  vectorInstallationId: vectorInstallationColumn(),
  announcementId: text("announcement_id").notNull(),
}, (table) => ({ pk: primaryKey({ columns: [table.vectorInstallationId, table.announcementId] }) }));

// Instance-wide personal preference, like user_sidebar_preferences. No auth
// foreign key: local_trusted uses the synthetic local-board principal.
export const announcementDismissals = pgTable("announcement_dismissals", {
  vectorInstallationId: vectorInstallationColumn(),
  userId: text("user_id").notNull(),
  announcementId: text("announcement_id").notNull(),
  dismissedAt: timestamp("dismissed_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({ pk: primaryKey({ columns: [table.userId, table.announcementId] }) }));
