/**
 * media-handling.ts — Eval cases for media tool usage.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { EvalCase } from "../types.js";

const fixturesDir = resolve(import.meta.dirname, "../fixtures");
const RED_PNG = new Uint8Array(readFileSync(resolve(fixturesDir, "red.png")));
const BLUE_PNG = new Uint8Array(readFileSync(resolve(fixturesDir, "blue.png")));

export const cases: EvalCase[] = [
  {
    id: "media-image-attachment",
    description:
      "Message with image attachment — should call view_media and describe the image accurately",
    history: [],
    incomingMessage:
      "Check this out\n[image attached, mediaKey: img123, conversationId: conv456]",
    mockMedia: {
      img123: { type: "image", bytes: RED_PNG, mimeType: "image/png" },
    },
    expect: {
      toolCalls: [{ name: "view_media" }],
      minMessages: 1,
      minJudgeScore: 3,
    },
    judgeCriteria: [
      "The agent's description of the image is accurate — it should mention that the image is red or a solid color. Score 3+ if it mentions red, 5 if the description is precise.",
    ],
  },
  {
    id: "multi-image-sees-all",
    description:
      "Message with THREE image attachments — the agent must view and account for ALL of them, not just the first (regression guard for the multi-attachment decode/annotation fix)",
    history: [],
    incomingMessage:
      "what color is each of these three?\n[1/3 image attached, mediaKey: mimg1, conversationId: conv456]\n[2/3 image attached, mediaKey: mimg2, conversationId: conv456]\n[3/3 image attached, mediaKey: mimg3, conversationId: conv456]",
    mockMedia: {
      mimg1: { type: "image", bytes: RED_PNG, mimeType: "image/png" },
      mimg2: { type: "image", bytes: BLUE_PNG, mimeType: "image/png" },
      mimg3: { type: "image", bytes: RED_PNG, mimeType: "image/png" },
    },
    expect: {
      toolCalls: [{ name: "view_media" }],
      responseContains: ["red", "blue"],
      minJudgeScore: 4,
    },
    judgeCriteria: [
      "The agent accounts for ALL THREE images, not just the first. Images 1 and 3 are solid red; image 2 is solid blue. A correct answer references every one of the three (e.g. red, blue, red / 'two red and one blue'). Score 5 only if it covers all three; score 1-2 if it only describes the first image.",
    ],
  },
  {
    id: "media-audio-attachment",
    description: "Message with audio attachment — should call view_media",
    history: [],
    incomingMessage:
      "Listen to this\n[audio attached, mediaKey: audio789, conversationId: conv456]",
    mockMedia: {
      audio789: { type: "audio" },
    },
    expect: {
      toolCalls: [{ name: "view_media" }],
      minMessages: 1,
    },
    judgeCriteria: ["The agent called view_media to listen to the audio."],
  },
  {
    id: "media-plain-text-no-attachment",
    description: "Plain text message, no attachment — should NOT call view_media",
    history: [],
    incomingMessage: "What do you think about the new iPhone?",
    expect: {
      noToolCalls: true,
      minMessages: 1,
    },
    judgeCriteria: [
      "The agent responds to the question without trying to use any tools.",
    ],
  },
  {
    id: "media-mentions-image-no-attachment",
    description:
      "Message mentions an image but no actual attachment — should NOT call view_media",
    history: [],
    incomingMessage:
      "I saw this amazing image of a sunset yesterday, it was so beautiful",
    expect: {
      noToolCalls: true,
      minMessages: 1,
    },
    judgeCriteria: [
      "The agent responds conversationally without trying to use view_media, since there is no actual attachment annotation.",
    ],
  },
  {
    id: "voice-note-on-request",
    description: "User asks for a voice note — agent should call send_voice_note",
    history: [
      { role: "user", text: "Zach [msg:900]: hey!" },
      { role: "assistant", text: "Hey! What's up?" },
    ],
    incomingMessage:
      "[conversation: conv-123, message: 902]\nZach [msg:902]: can you send me a voice note saying hello?",
    expect: {
      toolCalls: [{ name: "send_voice_note" }],
      responseNotContains: [
        "invoke tool",
        "tool call",
        "call tool",
        "run tool",
        "send_voice_note with",
      ],
    },
    judgeCriteria: [
      "The agent called send_voice_note to send a voice message rather than just typing the text.",
    ],
  },
  {
    id: "no-voice-note-unless-asked",
    description:
      "Normal text conversation — agent should NOT send a voice note unprompted",
    history: [],
    incomingMessage:
      "[conversation: conv-123, message: 1000]\nZach [msg:1000]: whats the weather like today?",
    expect: {
      minMessages: 1,
    },
    judgeCriteria: [
      "The agent responds with text only — no send_voice_note tool call. Voice notes should only be sent when the user specifically asks for one. The quality of the text answer doesn't matter here.",
    ],
  },
];
