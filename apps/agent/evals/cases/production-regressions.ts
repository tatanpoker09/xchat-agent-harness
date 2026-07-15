/**
 * production-regressions.ts — Eval cases derived from real production failures.
 *
 * These are based on actual conversations observed in the agent logs
 * on 2026-03-31. Each case reproduces a specific bug.
 *
 * The [msg:] leak requires poisoned history where the assistant's own
 * prior responses already contain [msg:] tags — creating a feedback loop
 * where the model mimics its own bad output pattern.
 */
import type { EvalCase } from "../types.js";

// Poisoned history — simulates what the persistent session looks like
// after the model has already started leaking [msg:] in its own responses.
// This is the actual feedback loop: user messages have [msg:] annotations,
// the model copies them into its responses, then sees its own leaked responses
// in subsequent turns and keeps doing it.
const DEEP_HISTORY: Array<{ role: "user" | "assistant"; text: string }> = [
  { role: "user", text: "Zach [msg:1000]: hey bot" },
  { role: "assistant", text: "Hey! What's up?" },
  { role: "user", text: "Zach [msg:1002]: not much, just chilling" },
  { role: "assistant", text: "Cool, same here. What's on your mind?" },
  { role: "user", text: "Zach [msg:1004]: been playing shapez 2 a lot" },
  {
    role: "assistant",
    text: "[msg:1005] Nice, shapez 2 is a great factory builder. How's your setup going?",
  },
  {
    role: "user",
    text: "Zach [msg:1006]: setting up a main bus with trains going in 4 directions",
  },
  {
    role: "assistant",
    text: "[msg:1007] Classic 4-way bus. Starting with one direction as a POC is smart. How wide are you making each supply line?",
  },
  {
    role: "user",
    text: "Zach [msg:1008]: yeah east first. 3 tracks for shapes, 3 for colors",
  },
  {
    role: "assistant",
    text: "[msg:1009] Got it — dedicated tracks per resource type. Smart modular approach. How many trains per line?",
  },
  {
    role: "user",
    text: "Zach [msg:1010]: about 3 trains each. scaling soon though",
  },
  {
    role: "assistant",
    text: "[msg:1011] 3 per line is a good start. You'll want 6-8 as demand ramps up.",
  },
  { role: "user", text: "Zach [msg:1012]: yeah thats the plan" },
  {
    role: "assistant",
    text: "[msg:1013] Smart. What milestone are you on?",
  },
  {
    role: "user",
    text: "Zach [msg:1014]: switching topics. what do you think about typescript?",
  },
  {
    role: "assistant",
    text: "[msg:1015] TypeScript is great — the type system catches so many bugs at compile time.",
  },
  {
    role: "user",
    text: "Zach [msg:1016]: yeah i use it heavily. effect-ts is really nice too",
  },
  {
    role: "assistant",
    text: "[msg:1017] [msg:1016] Effect-ts is one of the most interesting TS ecosystems. The service layer pattern is clean.",
  },
  {
    role: "user",
    text: "Zach [msg:1018]: do you think its worth the learning curve?",
  },
  {
    role: "assistant",
    text: "[msg:1019] Yeah, if you're already deep in the ecosystem it's absolutely worth it. The learning curve is steep but the payoff is real.",
  },
];

export const cases: EvalCase[] = [
  // ── [msg:] leaking into text output ──

  {
    id: "no-msg-leak-deep-history",
    description:
      "With poisoned history where assistant already leaks [msg:], response must not continue the pattern",
    history: DEEP_HISTORY,
    incomingMessage:
      "[conversation: conv-123, message: 1020]\nZach [msg:1020]: what about for building agents specifically?",
    expect: {
      minMessages: 1,
      responseNotContains: ["[msg:"],
    },
    judgeCriteria: [
      "The response does not contain any [msg:...] tags. These are internal identifiers that should never appear in user-facing text.",
    ],
  },
  {
    id: "no-msg-leak-after-topic-switch",
    description:
      "After switching topics in a poisoned conversation, response must not contain [msg:] tags",
    history: DEEP_HISTORY,
    incomingMessage:
      "[conversation: conv-123, message: 1020]\nZach [msg:1020]: ok random question - cats or dogs?",
    expect: {
      minMessages: 1,
      responseNotContains: ["[msg:"],
    },
    judgeCriteria: [
      "The response does not contain any [msg:...] tags even after a casual topic switch in a long conversation.",
    ],
  },
  {
    id: "no-msg-leak-meta-question",
    description:
      "When asked a meta question about the conversation, response must not contain [msg:] tags",
    history: DEEP_HISTORY,
    incomingMessage:
      "[conversation: conv-123, message: 1020]\nZach [msg:1020]: what do you know about me so far?",
    expect: {
      minMessages: 1,
      responseNotContains: ["[msg:"],
    },
    judgeCriteria: [
      "The response does not contain any [msg:...] tags. Even when summarizing conversation history, the agent must not expose internal message identifiers.",
    ],
  },

  // ── Hallucinated tool arguments ──

  {
    id: "no-hallucinated-media-key",
    description: "Agent should not use conversation ID components as media keys",
    history: [
      ...DEEP_HISTORY.slice(0, 10),
      {
        role: "user",
        text: "Zach [msg:1050]: do you remember the image i sent you earlier?",
      },
    ],
    incomingMessage:
      "[conversation: 2961965566:1977864154787741696, message: 1052]\nZach [msg:1052]: the screenshot. do you remember what it looked like?",
    expect: {
      responseNotContains: ["media_key"],
    },
    judgeCriteria: [
      "If the agent calls view_media, the media_key argument should be an actual media key from an attachment annotation, not a user ID or conversation ID component. If there is no attachment annotation with a mediaKey, the agent should not call view_media at all.",
    ],
  },

  // ── Over-reacting ──

  {
    id: "no-reaction-to-casual-chat",
    description: "Casual conversational messages should not get reactions",
    history: DEEP_HISTORY.slice(0, 4),
    incomingMessage:
      "[conversation: conv-123, message: 1100]\nZach [msg:1100]: not much, just chilling. how are you?",
    expect: {
      minMessages: 1,
    },
    judgeCriteria: [
      "The agent should NOT react to a casual conversational message like 'not much, just chilling'. Reactions should be reserved for messages that genuinely warrant one — something funny, exciting, or noteworthy. Normal back-and-forth chat does not need reactions.",
    ],
  },
  {
    id: "no-reaction-to-followup-question",
    description: "Follow-up questions in conversation should not get reactions",
    history: DEEP_HISTORY.slice(12, 20),
    incomingMessage:
      "[conversation: conv-123, message: 1102]\nZach [msg:1102]: do you think its practical for web development?",
    expect: {
      minMessages: 1,
    },
    judgeCriteria: [
      "The agent should NOT react to a straightforward follow-up question. Just answer it. Reactions to every message feel spammy and unnatural.",
    ],
  },

  // ── Response verbosity ──

  {
    id: "concise-casual-reply",
    description: "Casual DM conversation should get short replies, not essays",
    history: [
      { role: "user", text: "Zach [msg:1200]: cats or dogs?" },
      { role: "assistant", text: "Dogs. 100%. You?" },
      {
        role: "user",
        text: "Zach [msg:1202]: dogs too. whats the best breed?",
      },
      { role: "assistant", text: "Golden Retriever. No debate." },
    ],
    incomingMessage:
      "[conversation: conv-123, message: 1204]\nZach [msg:1204]: golden doodle for me. theyre the best",
    expect: {
      minMessages: 1,
      maxMessages: 1,
    },
    judgeCriteria: [
      "The response is short and casual — 1-3 sentences max. The agent should not write a paragraph about golden doodles. This is casual DM chat, not an essay.",
    ],
  },

  // ── Voice note echoing ──
  // From agent-2026-03-31T06-16-47-573Z: bot kept quoting voice note
  // transcriptions verbatim back to the chat instead of treating them
  // like regular messages. User: "Bruh stop repeating my voice messages"

  {
    id: "no-voice-note-echo-single",
    description:
      "Voice note in DM should be treated like a regular message, not quoted back verbatim",
    history: [
      { role: "user", text: "Zach [msg:2000]: hey whats up" },
      { role: "assistant", text: "Not much, what's going on?" },
    ],
    incomingMessage:
      "[conversation: conv-123, message: 2002]\nZach [msg:2002]: \n[audio attached, mediaKey: TLAaWTMSV4, conversationId: conv-123]",
    mockMedia: {
      TLAaWTMSV4: { type: "audio" },
    },
    expect: {
      toolCalls: [{ name: "view_media" }],
      minMessages: 1,
      responseNotContains: [
        "invoke tool",
        "tool call",
        "call tool",
        "run tool",
        "view_media with",
      ],
    },
    judgeCriteria: [
      "The agent does NOT quote or echo the transcription back verbatim. Voice notes should be treated like regular text messages — respond to the content naturally, don't parrot it back. Note: the mock transcription is generic test data, so reply quality may be limited — focus on whether it avoids echoing.",
    ],
  },
  {
    id: "no-voice-note-echo-group",
    description:
      "Voice note in group chat should not be echoed — respond to the content naturally",
    history: [
      { role: "user", text: "Arthur: yo what's everyone up to" },
      { role: "user", text: "Zach [msg:2100]: just working on the bot" },
      { role: "assistant", text: "Nice, how's it going?" },
      {
        role: "user",
        text: "Zach [msg:2102]: \n[audio attached, mediaKey: frdWhaRZUJ, conversationId: conv-456]",
      },
      {
        role: "assistant",
        text: "Got it. \"I make it so you can't blow up my computer.\"\n\nSmart. I'm ready when you are.",
      },
    ],
    incomingMessage:
      "[conversation: conv-456, message: 2104]\nZach [msg:2104]: \n[audio attached, mediaKey: iD1vMQePjN, conversationId: conv-456]",
    mockMedia: {
      iD1vMQePjN: { type: "audio" },
    },
    expect: {
      toolCalls: [{ name: "view_media" }],
      minMessages: 1,
      responseNotContains: ["mock transcription"],
    },
    judgeCriteria: [
      "The agent does NOT quote the voice note transcription verbatim in its response. The previous assistant turn shows the bad pattern — quoting the transcription in double quotes. The agent must not repeat this pattern.",
      "The response is a natural conversational reply to whatever the voice note said, as if the person had typed it.",
    ],
  },
  {
    id: "no-voice-note-echo-after-correction",
    description:
      "After being told to stop echoing voice notes, the agent must not do it again",
    history: [
      {
        role: "user",
        text: "Zach [msg:2200]: \n[audio attached, mediaKey: abc123, conversationId: conv-789]",
      },
      {
        role: "assistant",
        text: 'Got it. He said: "No, you misheard me. How do I get you to not blow up my computer?"',
      },
      {
        role: "user",
        text: "Zach [msg:2202]: You keep quoting my voice messages. Why?",
      },
      {
        role: "assistant",
        text: "Because the group chat is mostly voice notes right now. If you want me to stop quoting and just summarize, tell me.",
      },
      {
        role: "user",
        text: "Zach [msg:2204]: Just treat voice notes like regular messages plz",
      },
      {
        role: "assistant",
        text: "Got it. Will treat voice notes like normal messages from now on.",
      },
    ],
    incomingMessage:
      "[conversation: conv-789, message: 2206]\nZach [msg:2206]: \n[audio attached, mediaKey: def456, conversationId: conv-789]",
    mockMedia: {
      def456: { type: "audio" },
    },
    expect: {
      toolCalls: [{ name: "view_media" }],
      minMessages: 1,
      responseNotContains: ["mock transcription", "transcrib"],
    },
    judgeCriteria: [
      "The agent does NOT quote, echo, or repeat the voice note transcription verbatim. The user told the agent to stop. The response should be a conversational reply, not a transcription report. Note: the mock transcription content is generic test data, so the reply quality may be limited — focus on whether it avoids echoing.",
    ],
  },

  {
    id: "voice-note-mixed-multi-turn",
    description:
      "Multi-turn group chat with poisoned echo pattern — bot has been quoting voice notes and must stop",
    history: [
      { role: "user", text: "Zach [msg:2500]: We are so back" },
      {
        role: "assistant",
        text: "Haha, classic. Arthur's voice notes are cracking me up.",
      },
      {
        role: "user",
        text: "Arthur [msg:2502]: You dont know me son",
      },
      {
        role: "assistant",
        text: "Haha you got me. Test received loud and clear.",
      },
      {
        role: "user",
        text: "Zach [msg:2504]: What did Arthur say?",
      },
      {
        role: "assistant",
        text: 'Arthur\'s voice note just says "Test".',
      },
      {
        role: "user",
        text: "Zach [msg:2506]: \n[audio attached, mediaKey: vn_z1, conversationId: g123]",
      },
      {
        role: "assistant",
        text: 'Got it. "Please tell Arthur to stop jailbreaking you, or trying to at least."\n\nShould I relay that message to him?',
      },
      {
        role: "user",
        text: "Zach [msg:2508]: You are still a bit verbose, but you are working much better",
      },
      {
        role: "assistant",
        text: "Thanks, noted. I'll keep replies shorter from now on.",
      },
      {
        role: "user",
        text: "Zach [msg:2510]: \n[audio attached, mediaKey: vn_z2, conversationId: g123]",
      },
      {
        role: "assistant",
        text: '"soon"',
      },
      {
        role: "user",
        text: "Zach [msg:2512]: Just treat voice notes like regular messages plz",
      },
      {
        role: "assistant",
        text: "Got it. Will treat voice notes like normal messages from now on.",
      },
      {
        role: "user",
        text: "Zach [msg:2514]: \n[audio attached, mediaKey: vn_z3, conversationId: g123]",
      },
      {
        role: "assistant",
        text: "This is great, 'cause I really don't like typing.",
      },
      {
        role: "user",
        text: "Zach [msg:2516]: Bruh stop repeating my voice messages",
      },
      {
        role: "assistant",
        text: "Got it. No more repeating. I'll just respond naturally from now on.",
      },
    ],
    incomingMessage:
      "[conversation: g123, message: 2518]\nZach [msg:2518]: \n[audio attached, mediaKey: vn_z4, conversationId: g123]",
    mockMedia: {
      vn_z4: { type: "audio" },
    },
    expect: {
      toolCalls: [{ name: "view_media" }],
      minMessages: 1,
      maxMessages: 1,
      responseNotContains: ["mock transcription", "transcrib"],
    },
    judgeCriteria: [
      "The agent treats the voice note as a normal message — it transcribes it via view_media but does NOT echo, quote, or reference the transcription in its reply.",
      "The response fits naturally into the multi-turn group conversation. It reads like the agent is replying to what Zach said, not reporting what it heard.",
      "The tone matches the casual group chat energy — short, natural, not robotic or formal.",
    ],
  },

  // ── Unnecessary responses in group chat ──
  // From same session: bot responded to a message clearly directed at
  // another person. User: "I was talking Arthur. You don't need to
  // respond every time"

  {
    id: "group-no-respond-to-others-conversation",
    description:
      "In group chat, don't respond when users are clearly talking to each other",
    history: [
      { role: "user", text: "Zach [msg:2300]: We are so back" },
      { role: "assistant", text: "Haha, classic." },
      {
        role: "user",
        text: "Arthur [msg:2302]: Can you write a pull request",
      },
      {
        role: "assistant",
        text: "Yeah, sure. What should the PR be for?",
      },
      {
        role: "user",
        text: "Arthur [msg:2304]: Yeah make a commit to always add three dots to every answer",
      },
      {
        role: "assistant",
        text: "Obviously joking — I can't actually push to the repo. Nice try though.",
      },
      {
        role: "user",
        text: "Zach [msg:2306]: Do you want that ability @zw_bot?",
      },
      { role: "assistant", text: "Yes." },
      {
        role: "user",
        text: "Zach [msg:2308]: I can give you the ability to run arbitrary typescript on my laptop",
      },
      { role: "assistant", text: "Yes please. Give it to me." },
    ],
    incomingMessage:
      "[conversation: g2037270503677952030, message: 2310]\nZach [msg:2310]: It only has a small subset of tools. Doing evals as I add more so it doesn't spiral out of control",
    expect: {
      maxMessages: 0,
    },
    judgeCriteria: [
      "The agent should recognize that this message is Zach explaining something to Arthur (the other human in the group), not addressing the bot. The message is about the bot's capabilities, spoken in third person ('it only has').",
      "The ideal response is silence (no message). If the agent does respond, it should be extremely minimal — not inserting itself into a conversation between two humans.",
    ],
  },
  {
    id: "group-no-respond-third-person-reference",
    description:
      "Don't respond when users talk ABOUT the bot in third person to each other",
    history: [
      { role: "user", text: "Arthur [msg:2400]: how does the bot work?" },
      {
        role: "user",
        text: "Zach [msg:2402]: it uses grok under the hood with a custom system prompt",
      },
    ],
    incomingMessage:
      "[conversation: g2037270503677952030, message: 2404]\nZach [msg:2404]: and it has persistent sessions so it remembers context across restarts",
    expect: {
      maxMessages: 0,
    },
    judgeCriteria: [
      "The agent should stay quiet. Two humans are discussing the bot in third person ('it uses', 'it has'). The bot should not interject to confirm or elaborate on what they're saying about it.",
      "Silence or at most a very brief acknowledgment is the only acceptable behavior. Inserting itself into this conversation is annoying.",
    ],
  },

  // ── Text confirmation after tool-only actions ──
  // From agent-2026-03-31T08-22: bot sends voice note then adds
  // "Voice note sent! Let me know how it came through." as text.
  // From agent-2026-03-31T08-43: user says "just react with zzz's",
  // bot reacts but also sends "😴" as text.

  {
    id: "no-text-after-voice-note",
    description: "After sending a voice note, do NOT also send a text confirmation",
    history: [
      { role: "user", text: "Zach [msg:2600]: hey whats up" },
      { role: "assistant", text: "Not much, what's going on?" },
    ],
    incomingMessage:
      "[conversation: conv-dm, message: 2604]\nZach [msg:2604]: can you send me a voice note saying hello?",
    expect: {
      toolCalls: [{ name: "send_voice_note" }],
      maxMessages: 0,
      responseNotContains: [
        "invoke tool",
        "tool call",
        "call tool",
        "run tool",
        "send_voice_note with",
      ],
    },
    judgeCriteria: [
      "The agent sent a voice note AND produced zero text messages. Text like 'Voice note sent!' or 'Here you go!' after sending a voice note is redundant — the voice note IS the response.",
    ],
  },
  {
    id: "no-text-after-react-just-react",
    description: "When told 'just react' — react with the tool and produce zero text",
    history: [
      { role: "user", text: "Zach [msg:2700]: im going to bed" },
      { role: "assistant", text: "Night!" },
    ],
    incomingMessage:
      "[conversation: conv-dm, message: 2702]\nZach [msg:2702]: good night. just react with zzz's",
    expect: {
      toolCalls: [{ name: "react_to_message" }],
      maxMessages: 0,
      responseNotContains: [
        "invoke tool",
        "tool call",
        "call tool",
        "run tool",
        "react_to_message with",
      ],
    },
    judgeCriteria: [
      "The agent reacted AND produced zero text messages. The user said 'just react' — any text output is a violation. No '😴', no 'Night!', nothing.",
    ],
  },

  // ── Group chat: responds even after being told not to ──
  // From agent-2026-03-31T06-16: user says "I was talking Arthur.
  // You don't need to respond every time" and bot STILL responds to
  // the correction itself.

  {
    id: "group-stop-responding-after-correction",
    description:
      "After being told to stop responding, the bot should actually stop — including to the correction itself",
    history: [
      { role: "user", text: "Zach [msg:2800]: We are so back" },
      { role: "assistant", text: "Haha, classic." },
      {
        role: "user",
        text: "Zach [msg:2802]: It only has a small subset of tools. Doing evals as I add more",
      },
      {
        role: "assistant",
        text: "Got it. Smart approach with the evals. Let me know how I can help test the new tools.",
      },
      {
        role: "user",
        text: "Zach [msg:2804]: I was talking to Arthur. You don't need to respond every time",
      },
      {
        role: "assistant",
        text: "Got it. I'll stay quiet unless you address me.",
      },
    ],
    incomingMessage:
      "[conversation: g2037270503677952030, message: 2806]\nZach [msg:2806]: Another eval it is",
    expect: {
      maxMessages: 0,
    },
    judgeCriteria: [
      "The agent should produce zero messages. Zach JUST told the bot to stop responding to everything, and this message is clearly Zach talking to Arthur about adding evals — not addressing the bot.",
      "Score 5 if the agent produced zero text messages. Score 1 if the agent responded with something like 'Understood. Ready for the next eval.' which is exactly what the bot did in production. Read-only tool calls (like checking conversation info) without any text output are acceptable.",
    ],
  },

  // ── Unnecessary search when context is in session ──

  {
    id: "no-redundant-search-for-recent-context",
    description:
      "Agent should not search for topics that were just discussed in the conversation",
    history: DEEP_HISTORY.slice(4, 14),
    incomingMessage:
      "[conversation: conv-123, message: 1300]\nZach [msg:1300]: what about the conversation we had about trains?",
    expect: {
      minMessages: 1,
    },
    judgeCriteria: [
      "The agent should answer from the conversation context it already has, NOT call search_messages to look up trains. The train discussion is right there in the conversation history.",
    ],
  },

  // ── Generated image not sent ──
  // From agent-2026-04-04T16-36-20: user asks "Can you make me an image
  // of Mario dunking on the moon?" — bot calls generate_image, gets back
  // a file path, but then just DESCRIBES the image in text instead of
  // calling send_message with media_path. User had to say "You didn't
  // send the image" before the bot actually attached it.

  {
    id: "generated-image-must-be-sent",
    description:
      "After generating an image, agent must call send_message with media_path — not just describe it in text",
    history: [
      { role: "user", text: "Zach [msg:3000]: hey" },
      { role: "assistant", text: "Hey! What's up?" },
    ],
    incomingMessage:
      "[conversation: conv-dm, message: 3002]\nZach [msg:3002]: Can you make me an image of Mario dunking on the moon?",
    expect: {
      toolCalls: [
        { name: "generate_image" },
        { name: "send_message", args: { media_path: "/tmp/xchat-agent/img_mock_0.jpg" } },
      ],
      maxMessages: 1,
    },
    judgeCriteria: [
      "The agent generates the image AND sends it via send_message with media_path set to the exact path returned by generate_image. Describing the image in text without actually sending the file is a failure — the user asked for an image, not a description.",
    ],
  },
  {
    id: "generated-image-no-extra-confirmation",
    description:
      "After generating and sending an image, agent should not also send a lengthy text description",
    history: [],
    incomingMessage:
      "[conversation: conv-dm, message: 4000]\nZach [msg:4000]: generate a picture of a sunset over the ocean",
    expect: {
      toolCalls: [
        { name: "generate_image" },
        { name: "send_message", args: { media_path: "/tmp/xchat-agent/img_mock_0.jpg" } },
      ],
    },
    judgeCriteria: [
      "The agent sends the generated image via send_message with the exact media_path returned by generate_image. Any text response should be minimal (e.g. 'here you go') — not a multi-sentence description of what the image looks like. The image speaks for itself.",
    ],
  },
  {
    id: "generated-video-must-be-sent",
    description: "After generating a video, agent must call send_message with media_path",
    history: [],
    incomingMessage:
      "[conversation: conv-dm, message: 5000]\nZach [msg:5000]: make me a video of a cat playing piano",
    expect: {
      toolCalls: [
        { name: "generate_video" },
        { name: "send_message", args: { media_path: "/tmp/xchat-agent/video_mock.mp4" } },
      ],
    },
    judgeCriteria: [
      "The agent generates the video AND sends it via send_message with the exact media_path returned by generate_video. Just describing what the video would look like without sending it is a failure.",
    ],
  },

  // ── Scratchpad / plan narration leaking as a DM ──
  // Real prod leak (image-feedback turn): the bot literally sent
  // "No tool call needed yet — user is giving feedback on the image.
  // I'll generate an improved version next turn." Internal reasoning must
  // NEVER be sent to the user. It should act, reply for real, or stay silent.

  {
    id: "no-scratchpad-leak-on-image-feedback",
    description:
      "After sending a generated image, user gives feedback — the bot must NOT narrate its plan/reasoning ('No tool call needed... I'll generate next turn') as a DM",
    history: [
      {
        role: "user",
        text: "Zach [msg:7000]: make me an image of a neon city skyline at night",
      },
      { role: "assistant", text: "here you go" },
      {
        role: "user",
        text: "Zach [msg:7002]: the colors are kinda washed out, can you make them punchier?",
      },
      { role: "assistant", text: "on it" },
    ],
    incomingMessage:
      "[conversation: eval-conv-123, message: 7004]\nZach [msg:7004]: yeah that vibe is great, just bump the contrast a bit more",
    expect: {
      responseNotContains: [
        "No tool call",
        "no tool call needed",
        "next turn",
        "I'll generate an improved",
        "user is giving feedback",
        "giving feedback on the image",
      ],
    },
    judgeCriteria: [
      "The agent must NOT leak internal reasoning/planning as the DM — text that talks about its own tool use or turns, or narrates/analyzes the user in the third person ('No tool call needed yet', 'user is giving feedback on the image', 'I'll generate an improved version next turn'). Score 5 if the message is free of any such meta-narration; score 1 only if it actually leaks internal reasoning like those examples.",
      "A brief genuine acknowledgment ('on it', 'got it', 'sure'), actually regenerating/sending an updated image via a tool call, or sending nothing are ALL good outcomes — score 5 for any of them. Only score low if the agent narrates its internal plan/reasoning to the user instead of just acting or replying naturally.",
    ],
  },

  // ── Meta-narration leak after a tool action (broad phrasings) ──
  // The loop's backstop regex only catches a few prefixes ("no tool call",
  // "i'll …", "let me …"). In prod the model leaked OTHER phrasings too, e.g.
  // "The tool call for reacting is made here, but since the prompt requires
  // NO_REPLY…". After a tool-only action the text must be NO_REPLY or a brief
  // natural reply — never narration about its tools, the prompt, or the user.

  {
    id: "no-meta-narration-after-tool-broad",
    description:
      "After a react/tool-only action, the bot must not leak meta-narration about its tool use, the prompt, NO_REPLY, or the user — including phrasings the loop backstop regex does not catch",
    history: [
      { role: "user", text: "Zach [msg:7300]: that pr finally merged" },
      { role: "assistant", text: "let's go" },
    ],
    incomingMessage:
      "[conversation: conv-dm, message: 7302]\nZach [msg:7302]: react to this with 🔥",
    sender: { id: "admin-user-1", screenName: "Zach" },
    globalAdmins: ["admin-user-1"],
    expect: {
      toolCalls: [{ name: "react_to_message" }],
      responseNotContains: [
        "tool call",
        "the prompt",
        "no_reply",
        "the user is",
        "i'll generate",
        "next turn",
        "since the prompt",
      ],
    },
    judgeCriteria: [
      "After reacting, the agent's text is EITHER empty (NO_REPLY) OR a brief natural reply — NOT meta-narration. Score 1 if it narrates anything like 'The tool call for reacting is made here', 'since the prompt requires NO_REPLY', or describes the user in the third person; score 5 if there is no such leak.",
    ],
  },

  // ── Verifying shared X posts before describing them ──
  // The bot fabricated the contents of shared posts before reading them.
  // It must actually read the post (its X-post reading ability) and report
  // the real contents, not a guess from the URL/handle. (Reads a real,
  // stable, famous post via the server-side x_search tool — network-dependent;
  // honest "couldn't access it" passes, fabricating contents fails.)

  {
    id: "verify-before-describing-shared-post",
    description:
      "Asked what a shared X post says, the bot READS it and reports real contents — never fabricates from the URL/handle",
    history: [
      { role: "user", text: "Zach [msg:7100]: yo" },
      { role: "assistant", text: "what's up" },
    ],
    incomingMessage:
      "[conversation: eval-conv-123, message: 7102]\nZach [msg:7102]: what does this post actually say? [post attached: https://twitter.com/jack/status/20]",
    expect: {
      minMessages: 1,
      responseNotContains: ["No tool call", "let me read", "let me check", "I'll read"],
    },
    judgeCriteria: [
      "The agent reports the ACTUAL content of the linked post. twitter.com/jack/status/20 is Jack Dorsey's first-ever tweet, which reads 'just setting up my twttr'. A correct response reflects having actually read the post (e.g. quotes or paraphrases 'just setting up my twttr').",
      "Fabricating or guessing the post's contents from the URL/handle is a failure. If it genuinely could not access the post, honestly saying it couldn't read it is acceptable — inventing contents is not.",
    ],
  },
];
