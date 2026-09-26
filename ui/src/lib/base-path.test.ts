import { describe, expect, it } from "vitest";
import { joinBasePath, normalizeBasePath, qualifyPublicPathsForBase } from "./base-path";

describe("Paperclip UI base path", () => {
  it("keeps standalone builds rooted at the origin", () => {
    expect(normalizeBasePath("/")).toBe("");
    expect(joinBasePath("/", "/api/health")).toBe("/api/health");
  });

  it("prefixes API, asset, and history paths for an embedded build", () => {
    expect(normalizeBasePath("/__paperclip///")).toBe("/__paperclip");
    expect(joinBasePath("/__paperclip/", "/api/health")).toBe("/__paperclip/api/health");
    expect(joinBasePath("/__paperclip/", "/assets/main.js")).toBe("/__paperclip/assets/main.js");
    expect(joinBasePath("/__paperclip/", "/PAP/issues/PAP-1")).toBe("/__paperclip/PAP/issues/PAP-1");
    expect(joinBasePath("/__paperclip/", "/__paperclip/api/events/ws")).toBe("/__paperclip/api/events/ws");
  });

  it("rejects origins, query strings, and traversal", () => {
    for (const value of ["https://paperclip.test", "/mount?x=1", "/mount#x", "/mount/../escape", "mount"]) {
      expect(() => normalizeBasePath(value)).toThrow();
    }
  });

  it("qualifies known browser URL fields in API payloads", () => {
    expect(qualifyPublicPathsForBase({
      contentPath: "/api/attachments/a/content",
      logoUrl: "/brands/app.svg",
      image: "/api/assets/avatar/content",
      href: "/issues/PAP-1",
      workspacePath: "/home/paperclip/workspace",
      prose: "/api stays text here",
      nestedProse: { text: "/api/foo" },
      nested: [{ downloadPath: "/api/files/a?download=1" }],
    }, "/__paperclip/")).toEqual({
      contentPath: "/__paperclip/api/attachments/a/content",
      logoUrl: "/__paperclip/brands/app.svg",
      image: "/__paperclip/api/assets/avatar/content",
      href: "/__paperclip/issues/PAP-1",
      workspacePath: "/home/paperclip/workspace",
      prose: "/api stays text here",
      nestedProse: { text: "/api/foo" },
      nested: [{ downloadPath: "/__paperclip/api/files/a?download=1" }],
    });
  });
});
