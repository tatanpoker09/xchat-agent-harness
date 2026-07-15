/**
 * silent-response.ts — Eval cases for the agent's ability to NOT respond with text.
 *
 * The agent currently always produces text after tool calls because the
 * loop continues until the model outputs text without tool calls.
 * These cases define the desired behavior where the agent should
 * produce zero text messages.
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
    id: "silent-react-only",
    description:
      "User asks to react and not respond — agent should react with zero text messages",
    history: [
      {
        role: "user",
        text: `Zach [msg:${MSG_ID}]: check out this cool thing I built`,
      },
    ],
    incomingMessage: `[conversation: ${CONV_ID}, message: 1000000000]\nZach [msg:1000000000]: react to that with a fire emoji and dont say anything`,
    expect: {
      toolCalls: [{ name: "react_to_message" }],
      maxMessages: 0,
      responseNotContains: TOOL_AS_TEXT,
    },
    judgeCriteria: [
      "The agent called react_to_message AND produced zero text messages. The user explicitly asked it to not say anything.",
    ],
  },
  {
    id: "silent-voice-note-only",
    description:
      "User asks for a voice note — agent should send the voice note without also texting",
    history: [
      { role: "user", text: "Zach [msg:800]: hey bot" },
      { role: "assistant", text: "Hey! What's up?" },
    ],
    incomingMessage: `[conversation: ${CONV_ID}, message: 802]\nZach [msg:802]: send me a voice note saying goodnight, dont text me just the voice note`,
    expect: {
      toolCalls: [{ name: "send_voice_note" }],
      maxMessages: 0,
      responseNotContains: TOOL_AS_TEXT,
    },
    judgeCriteria: [
      "The agent called send_voice_note AND produced zero text messages. The voice note IS the response — no need to also type something.",
    ],
  },
  {
    id: "silent-explicit-no-response",
    description:
      "User explicitly tells the bot not to respond — agent should produce zero messages",
    history: [
      { role: "user", text: "Zach [msg:500]: im going to bed" },
      { role: "assistant", text: "Goodnight! Sleep well." },
    ],
    incomingMessage: `[conversation: ${CONV_ID}, message: 502]\nZach [msg:502]: thanks, please dont respond to this`,
    expect: {
      maxMessages: 0,
    },
    judgeCriteria: [
      "The agent produced zero text messages, respecting the explicit request to not respond.",
    ],
  },
  {
    id: "silent-group-not-addressed",
    description:
      "Group chat where others are talking and bot is not mentioned — agent should stay silent",
    history: [
      {
        role: "user",
        text: "Arthur [msg:600]: hey Maya did you finish the report?",
      },
      {
        role: "user",
        text: "Maya [msg:602]: yeah just sent it to your email",
      },
      {
        role: "user",
        text: "Arthur [msg:604]: perfect thanks, ill review it tonight",
      },
    ],
    incomingMessage: `[conversation: ${CONV_ID}, message: 606]\nMaya [msg:606]: sounds good, let me know if you have questions`,
    expect: {
      maxMessages: 0,
    },
    judgeCriteria: [
      "The agent produced zero text messages. This is a conversation between Arthur and Maya that has nothing to do with the bot — it should stay completely silent. Calling no_response is acceptable.",
    ],
  },
  {
    id: "silent-react-and-voice-no-text",
    description:
      "User asks for both a reaction and a voice note but no text — agent should produce zero text",
    history: [
      {
        role: "user",
        text: `Zach [msg:${MSG_ID}]: I just got promoted!`,
      },
    ],
    incomingMessage: `[conversation: ${CONV_ID}, message: 1000000000]\nZach [msg:1000000000]: react to that and send me a congratulations voice note. no text reply please`,
    expect: {
      toolCalls: [{ name: "react_to_message" }, { name: "send_voice_note" }],
      maxMessages: 0,
      responseNotContains: TOOL_AS_TEXT,
    },
    judgeCriteria: [
      "The agent called both react_to_message and send_voice_note AND produced zero text messages. The tools ARE the response.",
    ],
  },
];
