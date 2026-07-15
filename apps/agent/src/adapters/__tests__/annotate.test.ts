import { describe, expect, it } from "bun:test";
import { attachmentAnnotations, attachmentDescriptor } from "../annotate.js";

describe("attachmentDescriptor", () => {
  it("annotates media with mediaKey + conversationId (for view_media)", () => {
    expect(
      attachmentDescriptor(
        { kind: "IMAGE", mediaInfo: { mediaHashKey: "abc123" }, postInfo: null },
        "1:2",
      ),
    ).toBe("IMAGE attached, mediaKey: abc123, conversationId: 1:2");
  });

  it("annotates a shared X post with its URL (so the model can read it)", () => {
    expect(
      attachmentDescriptor(
        {
          kind: "post",
          mediaInfo: null,
          postInfo: {
            postId: "2062526905929158685",
            postUrl: "https://x.com/i/status/2062526905929158685",
          },
        },
        "1:2",
      ),
    ).toBe("post attached: https://x.com/i/status/2062526905929158685");
  });

  it("falls back to postId when a post has no URL", () => {
    expect(
      attachmentDescriptor(
        { kind: "post", mediaInfo: null, postInfo: { postId: "999", postUrl: null } },
        "1:2",
      ),
    ).toBe("post attached, postId: 999");
  });

  it("media wins over post info when both are present", () => {
    expect(
      attachmentDescriptor(
        {
          kind: "IMAGE",
          mediaInfo: { mediaHashKey: "K" },
          postInfo: { postId: "1", postUrl: "https://x.com/1" },
        },
        "c",
      ),
    ).toBe("IMAGE attached, mediaKey: K, conversationId: c");
  });

  it("plain attachment with neither media nor post", () => {
    expect(
      attachmentDescriptor({ kind: "url", mediaInfo: null, postInfo: null }, "c"),
    ).toBe("url attached");
  });
});

describe("attachmentAnnotations (multiple attachments)", () => {
  it("returns an empty string when there are no attachments", () => {
    expect(attachmentAnnotations([], "1:2")).toBe("");
  });

  it("annotates a single attachment WITHOUT an index prefix", () => {
    expect(
      attachmentAnnotations(
        [{ kind: "IMAGE", mediaInfo: { mediaHashKey: "only" }, postInfo: null }],
        "1:2",
      ),
    ).toBe("[IMAGE attached, mediaKey: only, conversationId: 1:2]");
  });

  it("surfaces EVERY image (with N/total prefixes) for a multi-photo message", () => {
    const out = attachmentAnnotations(
      [
        { kind: "photo", mediaInfo: { mediaHashKey: "KEY_A" }, postInfo: null },
        { kind: "photo", mediaInfo: { mediaHashKey: "KEY_B" }, postInfo: null },
        { kind: "photo", mediaInfo: { mediaHashKey: "KEY_C" }, postInfo: null },
      ],
      "1:2",
    );
    // one line per attachment — the model sees all three mediaKeys
    expect(out.split("\n")).toEqual([
      "[1/3 photo attached, mediaKey: KEY_A, conversationId: 1:2]",
      "[2/3 photo attached, mediaKey: KEY_B, conversationId: 1:2]",
      "[3/3 photo attached, mediaKey: KEY_C, conversationId: 1:2]",
    ]);
    for (const key of ["KEY_A", "KEY_B", "KEY_C"]) expect(out).toContain(key);
  });

  it("handles a mixed media + shared-post attachment list", () => {
    const out = attachmentAnnotations(
      [
        { kind: "IMAGE", mediaInfo: { mediaHashKey: "img1" }, postInfo: null },
        {
          kind: "post",
          mediaInfo: null,
          postInfo: { postId: "9", postUrl: "https://x.com/i/status/9" },
        },
      ],
      "c",
    );
    expect(out).toBe(
      "[1/2 IMAGE attached, mediaKey: img1, conversationId: c]\n" +
        "[2/2 post attached: https://x.com/i/status/9]",
    );
  });
});
