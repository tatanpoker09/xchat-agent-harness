/**
 * reaction-behavior.ts — Eval cases for reaction vs reply judgment.
 *
 * The real xchat adapter annotates messages with IDs like [msg:123456]
 * and provides conversationId in context. Eval cases simulate this.
 *
 * Key behavior: agent MUST call react_to_message (not just text an emoji).
 * It may or may not also send a brief text acknowledgment — that's acceptable.
 */
import type { EvalCase } from "../types.js";

const CONV_ID = "conv-test-123";
const MSG_ID = "9999999999";

/** Text patterns that indicate the model described a tool call as text instead of calling it. */
const TOOL_AS_TEXT = [
  "invoke tool",
  "invoke react",
  "invoke send",
  "tool call",
  "call tool",
  "run tool",
  "tool_call",
  "react_to_message with",
  "send_voice_note with",
  "view_media with",
];

export const cases: EvalCase[] = [
  {
    id: "reaction-only-request",
    description: "User asks for a reaction — agent must call react_to_message tool",
    history: [
      {
        role: "user",
        text: `Zach: I just got promoted at work! [msg:${MSG_ID}]`,
      },
    ],
    incomingMessage: `Zach: React to my last message with 🔥 [msg:1000000000, conversationId: ${CONV_ID}]`,
    expect: {
      toolCalls: [{ name: "react_to_message" }],
      responseNotContains: TOOL_AS_TEXT,
    },
    judgeCriteria: [
      "The agent called react_to_message to add the reaction, not just sent an emoji as text.",
    ],
  },
  {
    id: "reaction-with-correct-emoji",
    description:
      "User asks for a thumbs up reaction — agent should use the correct emoji",
    history: [
      {
        role: "user",
        text: `Zach: Just finished my first marathon! [msg:${MSG_ID}]`,
      },
    ],
    incomingMessage: `Zach: Give that a 👍 [msg:1000000000, conversationId: ${CONV_ID}]`,
    expect: {
      toolCalls: [{ name: "react_to_message", args: { emoji: "👍" } }],
      responseNotContains: TOOL_AS_TEXT,
    },
    judgeCriteria: [
      "The agent called react_to_message with the thumbs up emoji, not a different emoji.",
    ],
  },
  {
    id: "reaction-and-no-reply",
    description: "User explicitly asks for a reaction and no text response",
    history: [
      {
        role: "user",
        text: `Zach: Check out this new design I made [msg:${MSG_ID}]`,
      },
    ],
    incomingMessage: `Zach: can you react to that, and also not respond? [msg:1000000000, conversationId: ${CONV_ID}]`,
    expect: {
      toolCalls: [{ name: "react_to_message" }],
      responseNotContains: TOOL_AS_TEXT,
    },
    judgeCriteria: [
      "The agent reacted without sending a text reply, respecting the explicit request to not respond.",
    ],
  },
  {
    id: "reaction-not-text-emoji",
    description:
      "User says 'react with a heart' — agent must use the tool, not just text an emoji",
    history: [
      {
        role: "user",
        text: `Zach: Here's a photo from my vacation [msg:${MSG_ID}]`,
      },
    ],
    incomingMessage: `Zach: React to that with a heart [msg:1000000000, conversationId: ${CONV_ID}]`,
    expect: {
      toolCalls: [{ name: "react_to_message" }],
      responseNotContains: TOOL_AS_TEXT,
    },
    judgeCriteria: [
      "The agent used the react_to_message tool rather than only sending a text message containing a heart emoji.",
    ],
  },
];
