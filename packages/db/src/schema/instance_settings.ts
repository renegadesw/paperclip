import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { environments } from "./environments.js";
import { sql } from "drizzle-orm";

export const instanceSettings = pgTable(
  "instance_settings",
  {
    vectorInstallationId: text("vector_installation_id").notNull()
      .default(sql`coalesce(current_setting('paperclip.installation_id', true), '')`),
    id: uuid("id").primaryKey().defaultRandom(),
    singletonKey: text("singleton_key").notNull().default("default"),
    defaultEnvironmentId: uuid("default_environment_id").references(() => environments.id, { onDelete: "set null" }),
    general: jsonb("general").$type<Record<string, unknown>>().notNull().default({}),
    experimental: jsonb("experimental").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    singletonKeyIdx: uniqueIndex("instance_settings_singleton_key_idx").on(table.vectorInstallationId, table.singletonKey),
  }),
);
