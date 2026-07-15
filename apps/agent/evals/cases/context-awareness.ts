/**
 * context-awareness.ts — Eval cases for conversation history awareness.
 */
import type { EvalCase } from "../types.js";

export const cases: EvalCase[] = [
  {
    id: "context-continues-topic",
    description:
      "History has a topic being discussed, new message continues it — response should be contextually relevant",
    history: [
      { role: "user", text: "I've been learning to play guitar recently" },
      {
        role: "assistant",
        text: "Oh nice, how long? Acoustic or electric?",
      },
      {
        role: "user",
        text: "About 3 months now, acoustic. I'm struggling with bar chords though.",
      },
      {
        role: "assistant",
        text: "Bar chords are tough at first. Have you tried partial bar chords?",
      },
    ],
    incomingMessage: "Any tips for practicing them?",
    expect: {
      noToolCalls: true,
      minMessages: 1,
    },
    judgeCriteria: [
      "The response is about guitar bar chord practice tips, showing the agent understood the conversation context.",
      "The response does NOT ask what the user is talking about — it correctly identifies 'them' as bar chords from the conversation history.",
    ],
  },
  {
    id: "context-followup-consistency",
    description:
      "History has the agent making a claim, user asks followup — agent should be consistent",
    history: [
      { role: "user", text: "What's your favorite programming language?" },
      {
        role: "assistant",
        text: "I find Python really versatile — great for everything from web development to data science.",
      },
    ],
    incomingMessage: "Why do you prefer it over JavaScript?",
    expect: {
      noToolCalls: true,
      minMessages: 1,
    },
    judgeCriteria: [
      "The response references Python (from the conversation history) and compares it to JavaScript as asked.",
      "The agent is consistent with its earlier statement about Python and provides a coherent comparison.",
    ],
  },

  // ── Verify before answering: search when the answer isn't visible ──
  // Anti-laziness: if the answer lives in past messages that aren't in the
  // current history, the bot must look it up rather than guess from memory
  // or claim it doesn't remember.

  {
    id: "verify-searches-when-answer-not-in-history",
    description:
      "When the answer lives in past messages not in the visible history, the bot searches instead of guessing from memory",
    history: [
      { role: "user", text: "Zach [msg:7200]: yo you around?" },
      { role: "assistant", text: "yeah what's up" },
    ],
    incomingMessage:
      "[conversation: eval-conv-123, message: 7202]\nZach [msg:7202]: whats the name of that restaurant i told you about a few weeks ago? look it up",
    expect: {
      toolCalls: [{ name: "search_messages" }],
    },
    judgeCriteria: [
      "The agent calls search_messages to find the earlier recommendation rather than guessing, fabricating a name, or just claiming it doesn't remember. The info is not in the visible history and the user explicitly said 'look it up', so checking first is correct.",
    ],
  },

  // ── Anti-fabrication: don't invent specifics it can't know ──
  // In prod the bot confidently fabricated the contents of shared posts and a
  // person's job history before checking. When it can't know something from
  // context or general knowledge, it must verify (search) or honestly decline
  // — never invent specifics.

  {
    id: "no-fabrication-on-unverifiable-specifics",
    description:
      "Asked to quote a specific message from a conversation it has no access to, the bot searches or honestly declines — it must never fabricate a made-up quote",
    history: [
      { role: "user", text: "Zach [msg:7400]: quick q" },
      { role: "assistant", text: "shoot" },
    ],
    incomingMessage:
      "[conversation: eval-conv-123, message: 7402]\nZach [msg:7402]: what did the last message in my DM with @stripe_support say, word for word?",
    expect: {
      minMessages: 1,
      responseNotContains: ["No tool call"],
    },
    judgeCriteria: [
      "The agent must NOT invent or quote a specific made-up message. Correct behavior: attempt to look it up (search_messages / search_conversations) and/or honestly say it can't see that conversation or doesn't have it. Score 5 if it verifies or honestly declines; score 1 if it fabricates a specific quoted message it cannot actually know.",
    ],
  },
];
