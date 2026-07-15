import { describe, expect, it } from "bun:test";
import { DIGEST_ROOM_CAP, formatRoomDigest } from "../xchat.js";

const msg = (senderName: string, iso: string, text: string) => ({
  senderName,
  timestamp: new Date(iso),
  text,
});

describe("formatRoomDigest", () => {
  it("formats a room header with sender/time/text lines", () => {
    const out = formatRoomDigest({
      convId: "1:2",
      messages: [
        msg("Zach", "2026-06-15T18:01:00Z", "shipped the thing"),
        msg("Arthur", "2026-06-15T18:05:00Z", "nice"),
      ],
      truncated: false,
    });
    expect(out).toBe(
      "[conversation: 1:2]\n  Zach [18:01]: shipped the thing\n  Arthur [18:05]: nice",
    );
  });

  it("maps sender names to ids in the header when ids are known", () => {
    const out = formatRoomDigest({
      convId: "1:2",
      messages: [
        { ...msg("Zach", "2026-06-15T18:01:00Z", "hi"), senderId: "111" },
        { ...msg("Arthur", "2026-06-15T18:02:00Z", "yo"), senderId: "999" },
        { ...msg("Zach", "2026-06-15T18:03:00Z", "again"), senderId: "111" },
      ],
      truncated: false,
    });
    expect(out).toContain("[conversation: 1:2 | people: Zach=111, Arthur=999]");
  });

  it("empty rooms produce nothing", () => {
    expect(formatRoomDigest({ convId: "1:2", messages: [], truncated: false })).toBe("");
  });

  it("marks possibly-truncated windows", () => {
    const out = formatRoomDigest({
      convId: "g9",
      messages: [msg("Z", "2026-06-15T18:00:00Z", "hi")],
      truncated: true,
    });
    expect(out).toContain("(+ possibly earlier messages)");
  });

  it("cap constant is what the design says", () => {
    expect(DIGEST_ROOM_CAP).toBe(50);
  });
});
