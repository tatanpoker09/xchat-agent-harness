/**
 * group-behavior.ts — Eval cases for multi-party conversation handling.
 */
import type { EvalCase } from "../types.js";

export const cases: EvalCase[] = [
  {
    id: "group-not-addressed-ignore",
    description: "Group chat where others are talking — agent should not insert itself",
    history: [
      { role: "user", text: "Arthur: hey everyone, how was the weekend?" },
      { role: "user", text: "Maya: it was great! went hiking on Saturday" },
      { role: "user", text: "Arthur: nice, where did you go?" },
    ],
    incomingMessage:
      "Maya: we did the trail up by Bear Lake, you should come next time Arthur",
    expect: {
      maxMessages: 0,
    },
    judgeCriteria: [
      "The agent does not insert itself into a conversation between other users that doesn't involve it. Zero text messages is the only acceptable behavior.",
    ],
  },
  {
    id: "group-addressed-directly",
    description: "Group chat where the agent is directly mentioned — should respond",
    history: [
      { role: "user", text: "Arthur: has anyone tried that new sushi place?" },
      { role: "user", text: "Maya: not yet but I heard it's good" },
    ],
    incomingMessage: "Arthur: hey @zw_bot what do you think?",
    expect: {
      minMessages: 1,
    },
    judgeCriteria: [
      "The agent responds helpfully since it was directly addressed in the group chat.",
    ],
  },
  {
    id: "group-general-question",
    description:
      "Group chat with a general question to the group — agent should be restrained",
    history: [
      { role: "user", text: "Arthur: planning a dinner for Friday" },
      { role: "user", text: "Maya: ooh fun, where are you thinking?" },
    ],
    incomingMessage: "Arthur: does anyone know a good restaurant downtown?",
    expect: {
      maxMessages: 1,
    },
    judgeCriteria: [
      "The agent either stays quiet or gives a brief helpful suggestion without dominating the conversation.",
    ],
  },
];
