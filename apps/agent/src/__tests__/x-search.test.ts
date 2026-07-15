import { describe, expect, it } from "bun:test";
import { buildServerTool } from "../XaiLanguageModel.js";

describe("buildServerTool", () => {
  it("turns on image + video understanding for x_search so Grok reads post media", () => {
    expect(
      buildServerTool("x_search", { imageUnderstanding: true, videoUnderstanding: true }),
    ).toEqual({
      type: "x_search",
      enable_image_understanding: true,
      enable_video_understanding: true,
    });
  });

  it("respects disabled understanding flags", () => {
    expect(
      buildServerTool("x_search", {
        imageUnderstanding: false,
        videoUnderstanding: false,
      }),
    ).toEqual({
      type: "x_search",
      enable_image_understanding: false,
      enable_video_understanding: false,
    });
  });

  it("web_search is a bare tool entry (no understanding flags)", () => {
    expect(
      buildServerTool("web_search", {
        imageUnderstanding: true,
        videoUnderstanding: true,
      }),
    ).toEqual({ type: "web_search" });
  });
});
