import { describe, expect, it } from "vitest";
import { isLocalBoardUserId, localBoardUserId } from "../local-board-identity.js";

describe("installation-bound synthetic board identity", () => {
  it("preserves standalone identity and separates Vector hosts", () => {
    expect(localBoardUserId({})).toBe("local-board");
    expect(localBoardUserId({ PAPERCLIP_VECTOR_INSTALLATION_ID: "fd-native" })).toBe("local-board:fd-native");
    expect(localBoardUserId({ PAPERCLIP_VECTOR_INSTALLATION_ID: "vector-os-standard" })).toBe("local-board:vector-os-standard");
    expect(() => localBoardUserId({ PAPERCLIP_VECTOR_INSTALLATION_ID: "bad/id" })).toThrow();
  });
  it("retains synthetic-author classification for scoped IDs", () => {
    for (const value of ["local-board", "local-board:fd-native"]) expect(isLocalBoardUserId(value)).toBe(true);
    for (const value of [null, undefined, "real-user", "local-board:", "local-board:../bad"]) expect(isLocalBoardUserId(value)).toBe(false);
  });
});
