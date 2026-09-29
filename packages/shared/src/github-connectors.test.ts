import { describe, expect, it } from "vitest";
import {
  GITHUB_CONNECTOR_PROFILES,
  githubConnectorProfileHeaders,
  isGitHubConnectorToolAllowed,
} from "./github-connectors.js";

const managed = { sourceTemplateKey: "github", oauth: { connectorProfile: "github.code" } };

describe("github.code connector profile", () => {
  it("admits every read tool and exactly the listed write tools", () => {
    expect(isGitHubConnectorToolAllowed("github.code", "pull_request_read", "read")).toBe(true);
    for (const tool of [
      "create_branch", "push_files", "create_or_update_file", "create_pull_request", "update_pull_request",
      "merge_pull_request", "pull_request_review_write", "add_issue_comment", "issue_write", "label_write",
      "actions_run_trigger",
    ]) {
      expect(isGitHubConnectorToolAllowed("github.code", tool, "write"), tool).toBe(true);
    }
    expect(isGitHubConnectorToolAllowed("github.code", "github.merge_pull_request", "write")).toBe(true);
    for (const tool of ["delete_repository", "create_repository", "fork_repository"]) {
      expect(isGitHubConnectorToolAllowed("github.code", tool, "destructive"), tool).toBe(false);
    }
    expect(GITHUB_CONNECTOR_PROFILES["github.code"].writeTools).not.toContain("delete_repository");
  });

  it("requests the pull-request toolsets from the hosted server, only for the managed profile", () => {
    expect(githubConnectorProfileHeaders(managed)).toEqual({
      "X-MCP-Toolsets": "context,repos,issues,pull_requests,users,labels,actions",
    });
    expect(githubConnectorProfileHeaders({ sourceTemplateKey: "github" })).toEqual({});
    expect(githubConnectorProfileHeaders({ sourceTemplateKey: "notion", oauth: { connectorProfile: "github.code" } })).toEqual({});
  });
});
