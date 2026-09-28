import { SELF_HOSTED_BROKER_RELAY_PREFIX } from "@paperclipai/shared";

/**
 * Public mount point for the Paperclip board.
 *
 * Vite bakes `BASE_URL` into the UI artifact. A normal standalone build uses
 * `/`; Vector's composite release builds the same UI for `/__paperclip/` and
 * reverse-proxies that private, admin-gated prefix to the loopback server.
 */
export function normalizeBasePath(value: string | undefined): string {
  const raw = (value ?? "/").trim();
  if (raw === "" || raw === "/") return "";
  if (!raw.startsWith("/") || raw.includes("?") || raw.includes("#") || raw.includes("\\")) {
    throw new Error("Paperclip UI base path must be an absolute URL path");
  }

  const parts = raw.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error("Paperclip UI base path cannot contain dot segments");
  }
  return `/${parts.join("/")}`;
}

export function joinBasePath(basePath: string, path: string): string {
  if (!path.startsWith("/")) {
    throw new Error("Paperclip rooted path must start with /");
  }
  const normalizedBasePath = normalizeBasePath(basePath);
  if (normalizedBasePath && (path === normalizedBasePath || path.startsWith(`${normalizedBasePath}/`))) {
    return path;
  }
  return `${normalizedBasePath}${path}` || "/";
}

export const paperclipUiBasePath = normalizeBasePath(import.meta.env.BASE_URL);

export function paperclipPath(path: string): string {
  return joinBasePath(paperclipUiBasePath, path);
}

export function paperclipApiPath(path = ""): string {
  const suffix = path === "" ? "" : path.startsWith("/") ? path : `/${path}`;
  return paperclipPath(`/api${suffix}`);
}

const PUBLIC_ROOT = /^(?:\/api(?:\/|$)|\/_plugins(?:\/|$)|\/assets(?:\/|$)|\/brands(?:\/|$))/;
const BROWSER_URL_FIELD = /(?:url|href|src|image|avatar|logo|icon|asset)$/i;
const PATH_FIELD = /path$/i;
const ROOTED_PATH = /^\/(?!\/)/;

/**
 * Paperclip APIs return browser-ready content/open/download/logo paths. Keep
 * those paths inside the configured mount as they cross the shared JSON
 * client, without rewriting arbitrary prose that happens to mention `/api`.
 */
export function qualifyPublicPathsForBase(value: unknown, basePath: string, fieldName = ""): unknown {
  const normalizedBasePath = normalizeBasePath(basePath);
  if (typeof value === "string") {
    // The host (not Paperclip) serves the self-hosted connector broker's
    // browser paths at the origin root; they must not move under the mount.
    const browserUrl = BROWSER_URL_FIELD.test(fieldName) && ROOTED_PATH.test(value)
      && !value.startsWith(SELF_HOSTED_BROKER_RELAY_PREFIX);
    const publicPath = PATH_FIELD.test(fieldName) && PUBLIC_ROOT.test(value);
    if (!browserUrl && !publicPath) return value;
    if (normalizedBasePath && value.startsWith(`${normalizedBasePath}/`)) return value;
    return joinBasePath(normalizedBasePath, value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => qualifyPublicPathsForBase(entry, normalizedBasePath, fieldName));
  }
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      qualifyPublicPathsForBase(entry, normalizedBasePath, key),
    ]),
  );
}

export function qualifyPublicPaths(value: unknown, fieldName = ""): unknown {
  return qualifyPublicPathsForBase(value, paperclipUiBasePath, fieldName);
}
