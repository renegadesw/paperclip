// @ts-nocheck
/*
 * Read-only access to the operator's Vault snapshot for Vector's FunkyDev
 * engineering profile.
 *
 * This is intentionally the same tool contract as vector-os/agents' current
 * pinative extension.  It has no callback, credential, database, or legacy
 * Agents dependency, so it is the first FunkyDev extension that can move into
 * Paperclip without inventing a compatibility service.  The deployment owns
 * PI_VAULT_REFERENCE_ROOT and mounts the snapshot read-only.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { promises as fs } from "node:fs";
import * as path from "node:path";

const ROOT_VALUE = (process.env.PI_VAULT_REFERENCE_ROOT ?? "").trim();
const ROOT = ROOT_VALUE ? path.resolve(ROOT_VALUE) : "";
const MAX_FILE_BYTES = 2 * 1024 * 1024;

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
}

function result(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
}

function failure(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], details: { error: message } };
}

function insideRoot(relativePath: string): string | null {
  if (!ROOT || !path.isAbsolute(ROOT)) return null;
  const candidate = path.resolve(ROOT, relativePath);
  return candidate === ROOT || candidate.startsWith(ROOT + path.sep) ? candidate : null;
}

async function existingInsideRoot(relativePath: string): Promise<string | null> {
  const candidate = insideRoot(relativePath);
  if (!candidate) return null;
  try {
    const [realRoot, realCandidate] = await Promise.all([fs.realpath(ROOT), fs.realpath(candidate)]);
    return realCandidate === realRoot || realCandidate.startsWith(realRoot + path.sep)
      ? realCandidate
      : null;
  } catch {
    return null;
  }
}

async function markdownFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await markdownFiles(absolute, base));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) out.push(path.relative(base, absolute));
  }
  return out;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "vault_search",
    label: "Search operator Vault",
    description: "Search the read-only snapshot of the operator's Obsidian Vault. Results are attributed reference material, not your own memories.",
    parameters: Type.Object({
      query: Type.String({ description: "Words or phrase to find in Markdown note names and contents." }),
      limit: Type.Optional(Type.Integer({ description: "Maximum results from 1 to 20. Default 8." })),
    }),
    async execute(_id, params) {
      const query = params.query.trim().toLowerCase();
      if (!query) return failure("query is required");
      if (!ROOT) return failure("Vault reference is not configured");
      const limit = Math.max(1, Math.min(20, params.limit ?? 8));
      const terms = query.split(/\s+/).filter(Boolean);
      const matches: Array<{ path: string; title: string; snippet: string; score: number }> = [];
      for (const relative of await markdownFiles(ROOT)) {
        const absolute = await existingInsideRoot(relative);
        if (!absolute) continue;
        try {
          const stat = await fs.stat(absolute);
          if (stat.size > MAX_FILE_BYTES) continue;
          const body = await fs.readFile(absolute, "utf8");
          const haystack = `${relative}\n${body}`.toLowerCase();
          if (!terms.every((term) => haystack.includes(term))) continue;
          const bodyLower = body.toLowerCase();
          const bodyIndexes = terms.map((term) => bodyLower.indexOf(term)).filter((i) => i >= 0);
          const first = bodyIndexes.length > 0 ? Math.min(...bodyIndexes) : 0;
          const start = Math.max(0, first - 180);
          const snippet = body.slice(start, start + 600).replace(/\s+/g, " ").trim();
          const title = body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? path.basename(relative, ".md");
          const nameHits = terms.filter((term) => relative.toLowerCase().includes(term)).length;
          matches.push({ path: relative, title, snippet, score: nameHits * 10 + terms.length });
        } catch { /* a changing snapshot may race one file; continue */ }
      }
      matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
      return result({ source: "operator-vault-reference", query: params.query, results: matches.slice(0, limit) });
    },
  });

  pi.registerTool({
    name: "vault_read",
    label: "Read operator Vault note",
    description: "Read one Markdown note from the read-only Vault snapshot by the relative path returned from vault_search.",
    parameters: Type.Object({
      path: Type.String({ description: "Relative Markdown path returned by vault_search." }),
      offset: Type.Optional(Type.Integer({ description: "Character offset. Default 0." })),
      maxChars: Type.Optional(Type.Integer({ description: "Characters to return from 1000 to 40000. Default 12000." })),
    }),
    async execute(_id, params) {
      const relative = params.path.trim();
      if (!relative.toLowerCase().endsWith(".md")) return failure("only Markdown notes may be read");
      const absolute = await existingInsideRoot(relative);
      if (!absolute) return failure("path must remain inside the Vault reference root");
      try {
        const stat = await fs.stat(absolute);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return failure("note is unavailable or too large");
        const body = await fs.readFile(absolute, "utf8");
        const offset = Math.max(0, Math.min(body.length, params.offset ?? 0));
        const maxChars = Math.max(1000, Math.min(40000, params.maxChars ?? 12000));
        const text = body.slice(offset, offset + maxChars);
        return result({ source: "operator-vault-reference", path: relative, offset, text, truncated: offset + text.length < body.length });
      } catch (error: unknown) {
        return failure(`cannot read Vault note: ${(error as Error).message}`);
      }
    },
  });
}
