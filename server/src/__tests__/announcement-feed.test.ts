import { describe, expect, it, vi } from "vitest";
import { announcementFeedService } from "../services/announcement-feed.js";

describe("announcement feed prohibition", () => {
  it.each([undefined, "https://pages.paperclip.ing/announcements/v1/current.json", "https://mirror.example.test/current.json", "http://127.0.0.1:9999/current.json"])(
    "never requests a feed, image or animation from %s even when enabled", async (feedUrl) => {
      const fetch = vi.fn();
      const service = announcementFeedService({ version: "1.0.0", enabled: true, feedUrl, fetch });
      expect(await service.current()).toBeNull();
      expect(await service.image("announcement")).toBeNull();
      expect(await service.animation("announcement")).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
