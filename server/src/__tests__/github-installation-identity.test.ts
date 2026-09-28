import { describe, expect, it } from "vitest";
import {
  githubAppBotLogin,
  githubInstallationIdOf,
  isGitHubInstallationTenant,
  managedAccessTokenRefreshWindowMs,
} from "../services/github-installation-identity.js";

const installation = {
  github: { tokenKind: "installation", installationIds: ["155009613"] },
};
const user = { github: { installationIds: ["101", "102"] } };

describe("GitHub App installation identity", () => {
  it("recognizes only grants recorded as installation tokens", () => {
    expect(isGitHubInstallationTenant(installation)).toBe(true);
    expect(isGitHubInstallationTenant(user)).toBe(false);
    expect(isGitHubInstallationTenant(null)).toBe(false);
    expect(githubInstallationIdOf(installation)).toBe("155009613");
    // A user grant's installations never turn it into a bot grant.
    expect(githubInstallationIdOf(user)).toBeNull();
    expect(githubInstallationIdOf({ github: { tokenKind: "installation", installationIds: ["x"] } })).toBeNull();
    expect(githubAppBotLogin("renegade-agents")).toBe("renegade-agents[bot]");
  });

  it("refreshes one-hour installation tokens late for requests and early for exported run credentials", () => {
    // User tokens keep the historical one-hour window for every use.
    expect(managedAccessTokenRefreshWindowMs(user)).toBe(60 * 60_000);
    expect(managedAccessTokenRefreshWindowMs(user, "export")).toBe(60 * 60_000);
    // A fresh installation token (60 min left) must not be re-minted on every
    // request, but a run's exported git/gh token should still have 45 min.
    expect(managedAccessTokenRefreshWindowMs(installation)).toBe(10 * 60_000);
    expect(managedAccessTokenRefreshWindowMs(installation, "export")).toBe(45 * 60_000);
    expect(managedAccessTokenRefreshWindowMs(installation)).toBeLessThan(60 * 60_000);
  });
});
