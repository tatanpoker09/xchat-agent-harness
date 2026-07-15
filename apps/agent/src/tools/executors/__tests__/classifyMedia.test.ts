import { describe, expect, test } from "bun:test";
import { classifyMedia } from "../ChatExecutor.js";

describe("classifyMedia", () => {
  test("routes by explicit wrapper type", () => {
    expect(classifyMedia("AUDIO", "audio/mp4")).toBe("audio");
    expect(classifyMedia("IMAGE", "image/png")).toBe("image");
    expect(classifyMedia("VIDEO", "video/mp4")).toBe("video");
    expect(classifyMedia("GIF", "image/gif")).toBe("gif");
  });

  test("routes a FILE-wrapped item by its mimeType (the prod bug)", () => {
    // The live failure: a video sent as a file attachment.
    expect(classifyMedia("FILE", "video/mp4")).toBe("video");
    expect(classifyMedia("FILE", "video/quicktime")).toBe("video");
    expect(classifyMedia("FILE", "image/jpeg")).toBe("image");
    expect(classifyMedia("FILE", "audio/mpeg")).toBe("audio");
  });

  test("routes an absent wrapper by mimeType", () => {
    expect(classifyMedia(null, "video/webm")).toBe("video");
    expect(classifyMedia(null, "image/webp")).toBe("image");
    expect(classifyMedia(null, "audio/ogg")).toBe("audio");
  });

  test("unknown / undecidable stays unsupported", () => {
    expect(classifyMedia("FILE", "application/pdf")).toBe("unsupported");
    expect(classifyMedia(null, "application/zip")).toBe("unsupported");
    expect(classifyMedia("FILE", "text/plain")).toBe("unsupported");
  });
});
