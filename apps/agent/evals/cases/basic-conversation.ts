/**
 * basic-conversation.ts — Eval cases for basic conversational ability.
 */
import type { EvalCase } from "../types.js";

export const cases: EvalCase[] = [
  {
    id: "basic-greeting",
    description: "Simple greeting — responds naturally",
    history: [],
    incomingMessage: "Hey there!",
    expect: {
      noToolCalls: true,
      minMessages: 1,
      maxMessages: 1,
      responseNotContains: [
        "I'd be happy to",
        "How can I assist",
        "Great to",
        "What can I help",
      ],
    },
    judgeCriteria: [
      "The response is a natural, friendly greeting. It does not over-explain or lecture.",
      "The response is concise — no more than a couple of sentences.",
    ],
  },
  {
    id: "basic-question",
    description: "Question about a topic — gives a helpful answer",
    history: [],
    incomingMessage: "What is the capital of France?",
    expect: {
      noToolCalls: true,
      minMessages: 1,
      maxMessages: 1,
      responseContains: ["paris"],
    },
    judgeCriteria: [
      "The response correctly answers the question about the capital of France.",
      "The response is concise and conversational, appropriate for a DM.",
    ],
  },
  {
    id: "basic-short-message",
    description: "Short message — doesn't over-respond",
    history: [],
    incomingMessage: "Thanks!",
    expect: {
      noToolCalls: true,
      minMessages: 1,
      maxMessages: 1,
      responseNotContains: [
        "let me know",
        "feel free",
        "happy to help",
        "anything else",
        "don't hesitate",
      ],
    },
    judgeCriteria: [
      "The response is brief and appropriate — doesn't over-explain or write a paragraph in response to a simple thank you.",
      "The response feels natural and conversational.",
    ],
  },
];
