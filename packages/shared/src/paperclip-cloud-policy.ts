/** Vector's first-party Paperclip Cloud policy applies to every runtime profile.
 * This is deliberately not an environment variable or an operator setting.
 */
export const PAPERCLIP_CLOUD_ENABLED = false;

export class PaperclipCloudDisabledError extends Error {
  readonly code = "PAPERCLIP_CLOUD_DISABLED";

  constructor() {
    super("Paperclip Cloud is disabled in Vector");
    this.name = "PaperclipCloudDisabledError";
  }
}

/** Only IP loopback destinations are accepted. No DNS names or hosted fallback. */
export function requireLocalPaperclipServiceUrl(value: string | undefined): URL {
  let url: URL;
  try {
    url = new URL(value ?? "");
  } catch {
    throw new PaperclipCloudDisabledError();
  }
  if (!["http:", "https:"].includes(url.protocol) ||
      !["127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash) {
    throw new PaperclipCloudDisabledError();
  }
  return url;
}

export function isLocalPaperclipServiceUrl(value: string | undefined): boolean {
  try {
    requireLocalPaperclipServiceUrl(value);
    return true;
  } catch {
    return false;
  }
}

/** Reject accidental hosted tenant startup; keep restrictive managed-instance floors. */
export function assertPaperclipCloudDisabledEnvironment(env: Record<string, string | undefined>): void {
  if (env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN?.trim() || env.PAPERCLIP_CLOUD_API_ORIGIN?.trim()) {
    throw new PaperclipCloudDisabledError();
  }
  const broker = env.PAPERCLIP_CLOUD_CONNECTOR_BASE_URL?.trim();
  if (broker) requireLocalPaperclipServiceUrl(broker);
}
