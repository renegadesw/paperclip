export const GITHUB_CONNECTOR_PROFILE_IDS = ["github.code"] as const;

export type GitHubConnectorProfileId = (typeof GITHUB_CONNECTOR_PROFILE_IDS)[number];

/**
 * Hosted GitHub MCP toolsets requested for `github.code`. The server's
 * defaults (context, repos, issues, pull_requests, users) omit labels and
 * Actions, which an engineering agent needs for the pull-request lifecycle.
 * See github/github-mcp-server docs/remote-server.md (`X-MCP-Toolsets`).
 */
export const GITHUB_CODE_MCP_TOOLSETS = [
  "context", "repos", "issues", "pull_requests", "users", "labels", "actions",
] as const;

export const GITHUB_CONNECTOR_PROFILES: Readonly<Record<GitHubConnectorProfileId, {
  appSlug: "github";
  serverUrl: string;
  scopes: readonly string[];
  headers: Readonly<Record<string, string>>;
  writeTools: readonly string[];
}>> = {
  "github.code": {
    appSlug: "github",
    serverUrl: "https://api.githubcopilot.com/mcp/",
    // GitHub App permissions are configured on the App registration. GitHub
    // returns an empty OAuth scope string for user-to-server tokens.
    scopes: [],
    headers: { "X-MCP-Toolsets": GITHUB_CODE_MCP_TOOLSETS.join(",") },
    // The mutating hosted GitHub MCP tools this profile admits, by their
    // upstream names (github/github-mcp-server README): branches, commits and
    // file pushes; issues and comments; the full pull-request lifecycle
    // including reviews and merge; labels; and workflow runs. A write tool not
    // listed here is disabled in the catalog. Repository creation, deletion,
    // and forking are deliberately absent.
    writeTools: [
      "create_branch",
      "create_or_update_file",
      "push_files",
      "delete_file",
      "issue_write",
      "sub_issue_write",
      "add_issue_comment",
      "update_issue_comment",
      "create_pull_request",
      "update_pull_request",
      "update_pull_request_branch",
      "merge_pull_request",
      "pull_request_review_write",
      "add_comment_to_pending_review",
      "add_reply_to_pull_request_comment",
      "label_write",
      "actions_run_trigger",
    ],
  },
};

export function isGitHubConnectorProfileId(value: string): value is GitHubConnectorProfileId {
  return Object.prototype.hasOwnProperty.call(GITHUB_CONNECTOR_PROFILES, value);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The managed GitHub profile a connection config selects, if any. */
export function githubConnectorProfileForConfig(connectionConfig: unknown): GitHubConnectorProfileId | null {
  const config = record(connectionConfig);
  const profile = record(config.oauth).connectorProfile;
  return config.sourceTemplateKey === "github" && typeof profile === "string" && isGitHubConnectorProfileId(profile)
    ? profile
    : null;
}

/** Upstream request headers a managed GitHub connection's profile requires. */
export function githubConnectorProfileHeaders(connectionConfig: unknown): Record<string, string> {
  const profile = githubConnectorProfileForConfig(connectionConfig);
  return profile ? { ...GITHUB_CONNECTOR_PROFILES[profile].headers } : {};
}

function githubToolLeafName(name: string): string {
  return (name.split(/[.:/]/).pop() ?? name).replace(/-/g, "_").toLowerCase();
}

/**
 * Whether a `github.code` catalog tool is admitted. Read tools always are; a
 * write or destructive tool only when the profile lists it in `writeTools`.
 */
export function isGitHubConnectorToolAllowed(
  profileId: GitHubConnectorProfileId,
  toolName: string,
  riskLevel: string,
): boolean {
  if (riskLevel === "read") return true;
  const leaf = githubToolLeafName(toolName);
  return GITHUB_CONNECTOR_PROFILES[profileId].writeTools.some((tool) => githubToolLeafName(tool) === leaf);
}
