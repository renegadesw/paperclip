/** Sealed self-hosted App credentials, selected only in server/credential code. */
export type InstallationToken = { id: string; owner: string; token: string };
export function installationTokens(value: string): InstallationToken[] | null {
 if (!value.startsWith("vgit1.")) return null;
 try {
  if (value.length > 1_000_000) throw new Error();
  const rows: unknown = JSON.parse(Buffer.from(value.slice(6), "base64url").toString("utf8"));
  if (!Array.isArray(rows) || !rows.length || rows.length > 1000 || !rows.every((r) => r && typeof r === "object" && /^[1-9][0-9]*$/.test(r.id) && /^[A-Za-z0-9-]+$/.test(r.owner) && typeof r.token === "string" && r.token.length > 0 && !/\s/.test(r.token))) throw new Error();
  if (new Set(rows.map((r) => r.owner.toLowerCase())).size !== rows.length) throw new Error();
  return rows as InstallationToken[];
 } catch { throw new Error("GitHub installation credentials are invalid"); }
}
export function installationToken(value: string, parameters?: unknown): string {
 const rows = installationTokens(value); if (!rows) return value;
 const p = parameters && typeof parameters === "object" ? parameters as Record<string, unknown> : {};
 let owner = typeof p.owner === "string" ? p.owner : typeof p.org === "string" ? p.org : typeof p.organization === "string" ? p.organization : "";
 if (!owner && typeof p.repo === "string" && p.repo.includes("/")) owner = p.repo.split("/")[0];
 if (!owner && typeof p.query === "string") owner = /(?:repo|org|user):([A-Za-z0-9-]+)(?:\/|\b)/.exec(p.query)?.[1] ?? "";
 if (!owner) return rows[0]!.token;
 const selected = rows.find((r) => r.owner.toLowerCase() === owner.toLowerCase());
 if (!selected) throw new Error("GitHub App is not installed for the requested owner");
 return selected.token;
}
