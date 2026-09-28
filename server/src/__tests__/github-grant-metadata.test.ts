import { describe, expect, it, vi } from "vitest";
import { loadGitHubGrantMetadata } from "../services/tool-access.js";

function json(value: unknown, next = false): Response {
  return new Response(JSON.stringify(value), {
    headers: {
      "content-type": "application/json",
      ...(next ? { link: '<https://api.github.com/next>; rel="next"' } : {}),
    },
  });
}

describe("GitHub grant metadata", () => {
  it("lists every page of installations and repositories, persisting only display metadata", async () => {
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      const secondPage = url.searchParams.get("page") === "2";
      if (url.pathname === "/user") return json({ id: 42, login: "octocat", avatar_url: "https://avatars.example/octocat" });
      if (url.pathname === "/user/installations") {
        return json({ installations: secondPage
          ? [{ id: 102, repository_selection: "all", account: { login: "octocat" } }]
          : [{ id: 101, repository_selection: "selected", html_url: "https://github.com/settings/installations/101", account: { login: "paperclipai" } }],
        }, !secondPage);
      }
      if (url.pathname === "/user/installations/101/repositories") {
        return json({ total_count: 2, repositories: secondPage
          ? [{ id: 2, full_name: "paperclipai/b", private: true, description: "must-not-persist", clone_url: "must-not-persist" }]
          : [{ id: 1, full_name: "paperclipai/a", private: false }],
        }, !secondPage);
      }
      if (url.pathname === "/user/installations/102/repositories") {
        return json({ total_count: 1, repositories: [{ id: 3, full_name: "octocat/c" }] });
      }
      throw new Error(`Unexpected GitHub path: ${url.pathname}`);
    });

    const metadata = await loadGitHubGrantMetadata("ghu_secret", request, "paperclip-development");
    expect(metadata).toMatchObject({
      userId: "42",
      login: "octocat",
      installationCount: 2,
      repositoryCount: 3,
      repositorySelection: "mixed",
      installationIds: ["101", "102"],
      installationOwnerLogins: ["paperclipai", "octocat"],
      repositories: [
        { id: "3", fullName: "octocat/c", installationId: "102" },
        { id: "1", fullName: "paperclipai/a", installationId: "101", private: false },
        { id: "2", fullName: "paperclipai/b", installationId: "101", private: true },
      ],
      installationUrl: "https://github.com/apps/paperclip-development/installations/new",
      managementUrl: "https://github.com/settings/installations/101",
      appSlug: "paperclip-development",
      webhookHealth: "pending",
    });
    expect(metadata.repositories[0]).not.toHaveProperty("private");
    expect(JSON.stringify(metadata)).not.toContain("must-not-persist");
    expect(request).toHaveBeenCalledTimes(6);
    for (const [input, init] of request.mock.calls) {
      expect(new URL(String(input)).origin).toBe("https://api.github.com");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer ghu_secret");
    }
  });

  it("recovers a legacy grant's app chooser from GitHub installation metadata", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ id: 42, login: "octocat" }))
      .mockResolvedValueOnce(json({ installations: [{ id: 101, app_slug: "paperclip-staging", repository_selection: "selected" }] }))
      .mockResolvedValueOnce(json({ repositories: [{ id: 1, full_name: "octocat/a" }] }));
    await expect(loadGitHubGrantMetadata("ghu_secret", request)).resolves.toMatchObject({
      appSlug: "paperclip-staging",
      installationUrl: "https://github.com/apps/paperclip-staging/installations/new",
    });
  });

  it("requires at least one installation with an accessible repository", async () => {
    const request = vi.fn<typeof fetch>(async (input) => String(input).endsWith("/user")
      ? json({ id: 42, login: "octocat" })
      : json({ installations: [] }));
    await expect(loadGitHubGrantMetadata("ghu_secret", request)).rejects.toMatchObject({
      details: expect.objectContaining({ code: "github_installation_required" }),
    });
  });

  it("does not report a partial repository list when a later page fails", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ id: 42, login: "octocat" }))
      .mockResolvedValueOnce(json({ installations: [{ id: 101, repository_selection: "selected" }] }))
      .mockResolvedValueOnce(json({ repositories: [{ id: 1, full_name: "octocat/a" }] }, true))
      .mockResolvedValueOnce(new Response("Unavailable", { status: 503 }));
    await expect(loadGitHubGrantMetadata("ghu_secret", request)).rejects.toMatchObject({
      details: expect.objectContaining({ code: "github_access_check_failed" }),
    });
  });

  describe("GitHub App installation (bot) tokens", () => {
    function installationRequest(overrides: { bot?: unknown; secondPageOwnerType?: string } = {}) {
      return vi.fn<typeof fetch>(async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/user" || url.pathname.startsWith("/user/")) {
          // What GitHub answers an installation token on user-only endpoints.
          return new Response(JSON.stringify({ message: "Resource not accessible by integration" }), { status: 403 });
        }
        if (url.pathname === "/users/renegade-agents%5Bbot%5D") {
          return json(overrides.bot ?? { id: 900001, login: "renegade-agents[bot]", type: "Bot", avatar_url: "https://avatars.example/bot" });
        }
        if (url.pathname === "/installation/repositories") {
          const secondPage = url.searchParams.get("page") === "2";
          return json({
            total_count: 3,
            repository_selection: "all",
            repositories: secondPage
              ? [{ id: 3, full_name: "renegadesw/vector-os", private: true, owner: { login: "renegadesw", type: overrides.secondPageOwnerType ?? "Organization" }, clone_url: "must-not-persist" }]
              : [
                  { id: 1, full_name: "renegadesw/vector", private: true, owner: { login: "renegadesw", type: "Organization" } },
                  { id: 2, full_name: "renegadesw/paperclip", private: false, owner: { login: "renegadesw", type: "Organization" } },
                ],
          }, !secondPage);
        }
        throw new Error(`Unexpected GitHub path: ${url.pathname}`);
      });
    }

    it("builds the bot identity from the installation's repositories without user-only endpoints", async () => {
      const request = installationRequest();
      const metadata = await loadGitHubGrantMetadata("ghs_installation", request, "renegade-agents", { installationId: "155009613" });
      expect(metadata).toMatchObject({
        userId: "900001",
        login: "renegade-agents[bot]",
        avatarUrl: "https://avatars.example/bot",
        installationCount: 1,
        repositoryCount: 3,
        repositorySelection: "all",
        installationIds: ["155009613"],
        installationOwnerLogins: ["renegadesw"],
        repositories: [
          { id: "2", fullName: "renegadesw/paperclip", installationId: "155009613", private: false },
          { id: "1", fullName: "renegadesw/vector", installationId: "155009613", private: true },
          { id: "3", fullName: "renegadesw/vector-os", installationId: "155009613", private: true },
        ],
        installationUrl: "https://github.com/apps/renegade-agents/installations/new",
        managementUrl: "https://github.com/organizations/renegadesw/settings/installations/155009613",
        appSlug: "renegade-agents",
        webhookHealth: "pending",
        tokenKind: "installation",
      });
      expect(JSON.stringify(metadata)).not.toContain("must-not-persist");
      const paths = request.mock.calls.map(([input]) => new URL(String(input)).pathname);
      expect(paths.some((path) => path === "/user" || path.startsWith("/user/"))).toBe(false);
      for (const [input, init] of request.mock.calls) {
        expect(new URL(String(input)).origin).toBe("https://api.github.com");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer ghs_installation");
      }
    });

    it("keeps user tokens on the user endpoints (no installation id means a person)", async () => {
      await expect(loadGitHubGrantMetadata("ghs_installation", installationRequest(), "renegade-agents")).rejects.toMatchObject({
        details: expect.objectContaining({ code: "github_access_check_failed" }),
      });
    });

    it("refuses an installation credential without a usable app slug or installation id", async () => {
      for (const [slug, installationId] of [[undefined, "155009613"], ["Bad Slug", "155009613"], ["renegade-agents", "0"], ["renegade-agents", "abc"]] as const) {
        await expect(loadGitHubGrantMetadata("ghs_installation", installationRequest(), slug, { installationId })).rejects.toMatchObject({
          details: expect.objectContaining({ code: "github_bad_response" }),
        });
      }
    });

    it("refuses a bot account GitHub reports under another login", async () => {
      await expect(loadGitHubGrantMetadata("ghs_installation", installationRequest({ bot: { id: 7, login: "someone-else" } }), "renegade-agents", { installationId: "155009613" })).rejects.toMatchObject({
        details: expect.objectContaining({ code: "github_bad_response" }),
      });
    });

    it("requires at least one repository and points at the App's install page", async () => {
      const request = vi.fn<typeof fetch>(async (input) => String(input).includes("/users/")
        ? json({ id: 900001, login: "renegade-agents[bot]" })
        : json({ total_count: 0, repository_selection: "selected", repositories: [] }));
      await expect(loadGitHubGrantMetadata("ghs_installation", request, "renegade-agents", { installationId: "155009613" })).rejects.toMatchObject({
        details: expect.objectContaining({
          code: "github_installation_required",
          installationUrl: "https://github.com/apps/renegade-agents/installations/new",
        }),
      });
    });

    it("maps an expired installation token to reauthorization, like a user token", async () => {
      const request = vi.fn<typeof fetch>(async () => new Response("{}", { status: 401 }));
      await expect(loadGitHubGrantMetadata("ghs_expired", request, "renegade-agents", { installationId: "155009613" })).rejects.toMatchObject({
        details: expect.objectContaining({ code: "oauth_reauthorization_required" }),
      });
    });
  });
});
