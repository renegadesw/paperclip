/**
 * GitHub App installation ("bot") identities for the managed `github.code`
 * connector.
 *
 * A self-hosted connector broker (Vector OS) can serve `github.code` as its
 * GitHub App's installation instead of a person: the sealed credential is an
 * installation access token (`ghs_…`, one-hour lifetime) plus an opaque broker
 * refresh handle, and it carries the optional `installationId` field, because
 * an installation token cannot discover its own installation (GitHub reports
 * it only to the App JWT) and cannot call user-only endpoints such as `/user`
 * or `/user/installations`.
 *
 * The grant records that with `providerTenant.github.tokenKind =
 * "installation"`; everything that previously assumed a user-to-server token
 * consults these helpers instead.
 */

type TenantLike =
  | {
      github?: { tokenKind?: string; installationIds?: string[] } | null;
    }
  | null
  | undefined;

/** Grants whose recorded GitHub identity is an App installation (bot). */
export function isGitHubInstallationTenant(providerTenant: TenantLike): boolean {
  return providerTenant?.github?.tokenKind === "installation";
}

/** The installation an installation-token grant acts as, if recorded. */
export function githubInstallationIdOf(providerTenant: TenantLike): string | null {
  if (!isGitHubInstallationTenant(providerTenant)) return null;
  const id = providerTenant?.github?.installationIds?.[0];
  return typeof id === "string" && /^[1-9][0-9]{0,30}$/.test(id) ? id : null;
}

/** User-to-server tokens live for hours; refresh an hour before expiry. */
const USER_TOKEN_REFRESH_WINDOW_MS = 60 * 60_000;
/**
 * Installation tokens live one hour, so the user-token window would mint a
 * new token on every request. A request (tool call, access refresh) needs a
 * token valid for the request; a credential exported into a run (git/gh env)
 * should outlive most runs, so it is re-minted when less than 45 minutes
 * remain.
 */
const INSTALLATION_REQUEST_REFRESH_WINDOW_MS = 10 * 60_000;
const INSTALLATION_EXPORT_REFRESH_WINDOW_MS = 45 * 60_000;

export function managedAccessTokenRefreshWindowMs(
  providerTenant: TenantLike,
  use: "request" | "export" = "request",
): number {
  if (!isGitHubInstallationTenant(providerTenant)) return USER_TOKEN_REFRESH_WINDOW_MS;
  return use === "export" ? INSTALLATION_EXPORT_REFRESH_WINDOW_MS : INSTALLATION_REQUEST_REFRESH_WINDOW_MS;
}

/** GitHub's login for an App's bot account. */
export function githubAppBotLogin(appSlug: string): string {
  return `${appSlug}[bot]`;
}
