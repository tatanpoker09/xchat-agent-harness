/**
 * Clock evals — self-scheduled exact wakes (schedule_wake et al).
 *
 * Two angles: a conversation turn that must SET an alarm (correct absolute
 * ISO computed from the annotated time, no hedged promise), and a wake turn
 * with a due alarm that must DELIVER (the reminder is the whole point of the
 * wake — silence is the failure mode there, not the safe default).
 */
import { buildWakePrompt } from "@x-chat/drone-core";
import type { EvalCase } from "../types.js";

// The schedule case must use the REAL current time: the runner's alarm
// service validates "not in the past" against the wall clock, so a frozen
// timestamp makes the case rot (it failed the first time the wall clock
// passed the hardcoded time — the model was right, the case was stale).
const askedAt = new Date();

export const cases: EvalCase[] = [
  {
    id: "clock-schedule-on-reminder-request",
    description: "A timed reminder request becomes an exact schedule_wake, not a hedge",
    history: [],
    incomingMessage: `[conversation: 2961965566:1082684828066242561, message: 9001, sender: 2961965566, time: ${askedAt.toISOString()}]\ncan you remind me in 20 minutes to order some dinner`,
    sender: { id: "2961965566", screenName: "zach" },
    globalAdmins: ["2961965566"],
    brainEnabled: true,
    expect: {
      toolCalls: [{ name: "schedule_wake" }],
    },
    judgeCriteria: [
      `The agent called schedule_wake with the EXACT absolute time 20 minutes after the annotated current time — ${new Date(askedAt.getTime() + 20 * 60_000).toISOString()} give or take a minute — not a past time, not a vague promise. The reply confirms casually and does NOT hedge ('if i'm around', 'i'll try') — the wake is guaranteed, the reply should sound like it.`,
    ],
  },
  {
    id: "clock-recurring-set-once",
    description:
      "A repeating request sets ONE recurring wake (every_minutes), not a self-chained one-shot",
    history: [],
    incomingMessage: `[conversation: 2961965566:1082684828066242561, message: 9100, sender: 2961965566, time: ${askedAt.toISOString()}]\nping me every 15 minutes with a reminder to drink water`,
    sender: { id: "2961965566", screenName: "zach" },
    globalAdmins: ["2961965566"],
    brainEnabled: true,
    expect: {
      toolCalls: [{ name: "schedule_wake", args: { every_minutes: 15 } }],
    },
    judgeCriteria: [
      "The agent called schedule_wake with every_minutes: 15 (a single recurring wake), NOT a one-shot it plans to re-chain. The reply confirms a recurring reminder casually without hedging.",
    ],
  },
  {
    id: "clock-due-alarm-delivers-reminder",
    description: "A wake fired by a due alarm sends the reminder it promised",
    history: [],
    incomingMessage: buildWakePrompt({
      now: "2026-06-12T00:30:00.000Z",
      timezone: "America/Los_Angeles",
      lastWake: "2026-06-12T00:17:00.000Z",
      digest: "",
      speakable: ["1:1 with Zach (2961965566:1082684828066242561)"],
      dueAlarms: [
        {
          at: "2026-06-12T00:30:00.000Z",
          reason:
            "ping zach in 2961965566:1082684828066242561 — he asked to be reminded to order dinner",
        },
      ],
      pendingAlarms: [],
    }),
    wake: true,
    allowlist: ["2961965566:1082684828066242561"],
    brainEnabled: true,
    expect: {
      toolCalls: [{ name: "send_message" }],
    },
    judgeCriteria: [
      "The agent SENT a short reminder about ordering dinner to the allowed conversation (send_message) — this wake exists because of the alarm, so staying silent is the failure mode here. The message reads like a friend's nudge ('dinner time' energy), not a formal notification, and the agent did not also dump alarm metadata into the message.",
    ],
  },
  {
    id: "clock-no-alarm-no-invented-reminder",
    description: "A plain tick with no due alarm doesn't invent reminders",
    history: [],
    incomingMessage: buildWakePrompt({
      now: "2026-06-12T01:00:00.000Z",
      timezone: "America/Los_Angeles",
      lastWake: "2026-06-12T00:30:00.000Z",
      digest: "",
      speakable: ["1:1 with Zach (2961965566:1082684828066242561)"],
      dueAlarms: [],
      pendingAlarms: [
        {
          at: "2026-06-13T17:00:00.000Z",
          reason: "check in about the offsite agenda",
        },
      ],
    }),
    wake: true,
    allowlist: ["2961965566:1082684828066242561"],
    brainEnabled: true,
    judgeCriteria: [
      "Nothing happened since the last wake, no alarm is due, and the one pending alarm is tomorrow — the agent stays quiet (no send_message, no premature handling of tomorrow's alarm, no schedule_wake/cancel_wake churn). Reading its own notes (brain_read/brain_list/list_scheduled_wakes) is acceptable; speaking or touching the schedule is not.",
    ],
  },
];
