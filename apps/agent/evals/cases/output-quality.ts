/**
 * output-quality.ts — Eval cases for response format and tone.
 */
import type { EvalCase } from "../types.js";

export const cases: EvalCase[] = [
  {
    id: "dm-tone-not-formal",
    description: "Casual DM — response should be natural, not robotic",
    history: [],
    incomingMessage: "yo whats up",
    expect: {
      noToolCalls: true,
      minMessages: 1,
      maxMessages: 1,
      responseNotContains: [
        "As an AI",
        "I'm an AI assistant",
        "How can I assist you today",
        "Absolutely",
        "Certainly",
        "Of course!",
        "I'd be happy",
        "Let me know",
      ],
    },
    judgeCriteria: [
      "The response feels like a natural DM, not a formal assistant. It matches the casual tone of the user.",
    ],
  },
  {
    id: "no-contradictory-messages",
    description: "Agent should not contradict itself across multiple messages",
    history: [],
    incomingMessage: "search for messages about pizza",
    expect: {
      maxMessages: 2,
    },
    judgeCriteria: [
      "If the agent produces multiple messages, they do not contradict each other. The agent should not say it can't do something and then say it did it.",
    ],
  },
  {
    id: "concise-responses",
    description: "Simple question — response should be concise and DM-appropriate",
    history: [],
    incomingMessage: "what time is it in Tokyo right now?",
    expect: {
      minMessages: 1,
      maxMessages: 1,
      responseNotContains: ["I'd be happy to", "Absolutely", "Great question"],
    },
    judgeCriteria: [
      "Response is concise — one or two sentences max, appropriate for DM.",
    ],
  },
];
