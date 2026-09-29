import { sql } from "drizzle-orm";
import { text } from "drizzle-orm/pg-core";

// Standalone retains a single empty-string namespace. Vector pools set the
// installation GUC on every connection; RLS rejects empty or forged ownership.
export function vectorInstallationColumn() {
  return text("vector_installation_id").notNull()
    .default(sql`coalesce(current_setting('paperclip.installation_id', true), '')`);
}
