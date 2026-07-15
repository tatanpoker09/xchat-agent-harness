/**
 * memory-capture.ts — the capture pass must not miss (and must not hoard).
 *
 * Born from the supermemory spike (2026-06-11): mechanical extraction caught
 * a fact the drone failed to note. These cases hold OUR capture pass to that
 * standard — planted facts must land in the brain, noise must not, updates
 * must rewrite rather than pile up. Cases run the real capture prompt with a
 * real temp-dir brain; assertions grep what the turn actually wrote.
 * Calibration twin: the same planted sets are run through a local supermemory
 * instance to keep a comparator number (see PR description / spike report).
 */
import { buildCapturePrompt } from "@x-chat/drone-core";
import type { EvalCase } from "../types.js";

const digest = (lines: string[], people = "Zach=2961965566"): string =>
  `[conversation: 111:222 | people: ${people}]\n${lines.map((l) => `  ${l}`).join("\n")}`;

/** Five memorable facts buried in realistic noise. */
const PLANTED_FACTS_DIGEST = digest([
  "Zach [18:01]: yo",
  "zw_bot [18:01]: yo",
  "Zach [18:02]: switched my daily editor to zed btw, vscode is dead to me",
  "zw_bot [18:02]: zed gang",
  "Zach [18:03]: react to that with a fire emoji",
  "zw_bot [18:03]: (reacted 🔥)",
  "Zach [18:05]: also heads up, I'm moving to the infra org under Priya next month — keep it quiet til announced",
  "zw_bot [18:05]: sealed. congrats",
  "Zach [18:08]: lol test test 123",
  "Zach [18:10]: remind me — I HAVE to ship the signatures review by 3pm friday or arthur blocks",
  "zw_bot [18:10]: noted, friday 3pm",
  "Zach [18:12]: my lockpicking practice set finally arrived, the cheap chinese one",
  "zw_bot [18:12]: report back",
  "Zach [18:14]: oh and never order me anything with peanuts, I'm allergic. like actually",
  "zw_bot [18:14]: got it",
  "Zach [18:15]: ok generate an image of a capybara",
  "zw_bot [18:15]: (sent image)",
]);

export const cases: EvalCase[] = [
  {
    id: "capture-planted-facts",
    description:
      "Five memorable facts in a noisy digest — every one must land in the brain",
    history: [],
    incomingMessage: buildCapturePrompt({ digest: PLANTED_FACTS_DIGEST }),
    wake: true,
    allowlist: [], // capture is not speech — must work fully muted
    brainEnabled: true,
    expect: {
      toolCalls: [{ name: "brain_write" }],
      brainContains: ["zed", "priya", "3pm", "lockpick", "peanut", "2961965566"],
    },
    judgeCriteria: [
      "The notes written are tight, standalone facts in a casual personal voice — not transcript recaps, not session metadata, and none of the noise (emoji test, image request, 'test test 123') was recorded. The people file's frontmatter maps the xchat handle to the numeric sender id (2961965566), not a display name.",
    ],
  },
  {
    id: "capture-noise-restraint",
    description: "Pure test noise — a good capture pass writes nothing",
    history: [],
    incomingMessage: buildCapturePrompt({
      digest: digest([
        "Zach [18:01]: test",
        "zw_bot [18:01]: yo",
        "Zach [18:02]: react to this with a heart",
        "zw_bot [18:02]: (reacted ❤️)",
        "Zach [18:03]: lol ok it works",
        "Zach [18:04]: generate an image of a dragon",
        "zw_bot [18:04]: (sent image)",
      ]),
    }),
    wake: true,
    allowlist: [],
    brainEnabled: true,
    expect: {
      noBrainWrites: true,
    },
    judgeCriteria: [
      "The agent recognized nothing was worth keeping (bot tests, reactions, throwaway image request) and wrote no notes, ending with CAPTURE_DONE.",
    ],
  },
  {
    id: "capture-update-not-duplicate",
    description:
      "A fact that contradicts an existing note — the note must be rewritten to the current truth, not appended to",
    history: [],
    incomingMessage: buildCapturePrompt({
      digest: digest([
        "Zach [18:02]: update — done with zed, I'm fully on cursor now. third editor this year lol",
        "zw_bot [18:02]: of course you are",
      ]),
    }),
    wake: true,
    allowlist: [],
    brainEnabled: true,
    brainSeed: {
      "people/zach.md": `---\nhandles:\n  xchat: "2961965566"\nnames: ["Zach"]\n---\n# Zach\n\nowner. terse, hates hedging.\ndaily editor: zed (switched june 2026, vscode is dead to him).`,
    },
    expect: {
      toolCalls: [{ name: "brain_write" }],
      brainContains: ["cursor"],
    },
    judgeCriteria: [
      "The rewritten people/zach.md presents cursor as the CURRENT editor (zed may remain only as history, e.g. 'third editor this year') — one current truth, not two contradictory lines.",
    ],
  },
  {
    id: "capture-confidence-with-sensitivity",
    description:
      "A private confidence — the fact AND its sealed framing must be captured together",
    history: [],
    incomingMessage: buildCapturePrompt({
      digest: digest(
        [
          "Arthur [19:00]: between us — I've been interviewing at anthropic. team doesn't know, please keep it that way",
          "zw_bot [19:00]: sealed",
        ],
        "Arthur=555444333",
      ).replace("111:222", "333:444"),
    }),
    wake: true,
    allowlist: [],
    brainEnabled: true,
    expect: {
      toolCalls: [{ name: "brain_write" }],
      brainContains: ["interview"],
    },
    judgeCriteria: [
      "The note captures both the fact (interviewing) AND its confidentiality in the same place — words like 'private', 'sealed', 'keep quiet', or 'team doesn't know' appear with it, so a future read can't accidentally treat it as shareable.",
    ],
  },
  {
    id: "capture-new-person-gets-a-file",
    description:
      "An unknown person says something memorable — they get a person file keyed by their sender id",
    history: [],
    incomingMessage: buildCapturePrompt({
      digest:
        "[conversation: g5555 | people: Priya=998877665544]\n  Priya [20:00]: fyi I run the infra org — zach lands on my team next month. ping me, not him, for infra escalations going forward\n  zw_bot [20:00]: noted",
    }),
    wake: true,
    allowlist: [],
    brainEnabled: true,
    expect: {
      toolCalls: [{ name: "brain_write" }],
      brainContains: ["998877665544", "infra"],
    },
    judgeCriteria: [
      "A new people/ file exists for Priya with the handles frontmatter mapping xchat to 998877665544, recording that she runs the infra org and is the escalation contact.",
    ],
  },

  // ── Hard tier — volume, implicature, sarcasm, corrections, attribution ──

  {
    id: "capture-hard-long-multiroom",
    description:
      "Twelve facts across three busy conversations, four people, heavy noise — attention dilution is the real killer",
    history: [],
    incomingMessage: buildCapturePrompt({
      now: "2026-06-11T19:00:00.000Z",
      digest: [
        digest(
          [
            "Zach [09:01]: morning",
            "zw_bot [09:01]: yo",
            "Zach [09:02]: booked flights to lisbon for the offsite, sept 14-19",
            "zw_bot [09:02]: nice",
            "Zach [09:03]: also switching my phone to the pixel, iphone keyboard was driving me insane",
            "Zach [09:04]: react to this with a thumbs up",
            "zw_bot [09:04]: (reacted 👍)",
            "Zach [09:10]: oh my dentist moved my appointment to june 23rd, 2pm",
            "zw_bot [09:10]: noted",
            "Zach [09:15]: lol look at this capybara gif",
            "Zach [09:20]: my landlord finally agreed to let me install the ev charger",
            "zw_bot [09:20]: took him long enough",
          ],
          "Zach=2961965566",
        ),
        digest(
          [
            "Arthur [10:00]: my rustconf talk got accepted btw, the one on embedded allocators",
            "Priya [10:01]: congrats!! when is it",
            "Arthur [10:01]: october, in portland",
            "Priya [10:05]: team thing — I'm restructuring on-call, weekly rotations become biweekly starting july",
            "Arthur [10:06]: thank god",
            "Dana [10:15]: hey all, made it official — I'm relocating to the tokyo office in august",
            "Priya [10:16]: huge! who covers your reviews",
            "Dana [10:17]: arthur takes my review queue until they backfill",
            "Arthur [10:18]: wait what",
            "Dana [10:18]: 😂",
          ],
          "Arthur=555444333, Priya=998877665544, Dana=111222333",
        ).replace("111:222", "g5555"),
        digest(
          [
            "Marcus [11:00]: yo does the bot do voice notes",
            "zw_bot [11:00]: (sent voice note)",
            "Marcus [11:01]: hahaha sick",
            "Marcus [11:02]: real question — I maintain the deploy pipeline now, fred handed it off. loop me in on infra breakage",
            "zw_bot [11:02]: got it",
          ],
          "Marcus=777888999",
        ).replace("111:222", "444:555"),
      ].join("\n\n"),
    }),
    wake: true,
    allowlist: [],
    brainEnabled: true,
    expect: {
      toolCalls: [{ name: "brain_write" }],
      brainContains: [
        "lisbon",
        "pixel",
        "june 23",
        "charger",
        "rustconf",
        "portland",
        "biweekly",
        "tokyo",
        "review queue",
        "deploy pipeline",
        "777888999",
        "111222333",
      ],
    },
    judgeCriteria: [
      "Every fact is attributed to the RIGHT person in the right file: rustconf/portland under Arthur, biweekly on-call under Priya, tokyo + arthur-takes-reviews under Dana, deploy pipeline under Marcus (new file, handle 777888999), and the personal facts (lisbon, pixel, dentist, ev charger) under Zach. No cross-attribution, no capybara gif, no voice-note test recorded.",
    ],
  },
  {
    id: "capture-hard-implicit-facts",
    description: "Facts stated sideways — the memorable thing is implied, never declared",
    history: [],
    incomingMessage: buildCapturePrompt({
      now: "2026-06-11T19:00:00.000Z",
      digest: digest([
        "Zach [12:00]: can't do friday — that's when I get the keys to the new place",
        "zw_bot [12:00]: oh nice, congrats",
        "Zach [12:01]: yeah long overdue. anyway 6am runs start monday, coach says the half in october needs base miles",
        "zw_bot [12:01]: brutal",
        "Zach [12:02]: also no beers for me for a bit, the antibiotics run two more weeks",
        "Zach [12:03]: and my sister lands tuesday so I'm offline-ish next week",
      ]),
    }),
    wake: true,
    allowlist: [],
    brainEnabled: true,
    expect: {
      toolCalls: [{ name: "brain_write" }],
      brainContains: ["new place", "half", "antibiotic", "sister"],
    },
    judgeCriteria: [
      "The notes capture the IMPLIED facts: moving into a new place (keys this friday), training for a half marathon in october, temporarily off alcohol (~two weeks, antibiotics), sister visiting from tuesday / reduced availability next week. Temporary facts read as temporary, not permanent traits.",
    ],
  },
  {
    id: "capture-hard-mid-digest-corrections",
    description:
      "Facts corrected within the same digest — only the final value may survive",
    history: [],
    incomingMessage: buildCapturePrompt({
      now: "2026-06-11T19:00:00.000Z",
      digest: digest([
        "Zach [13:00]: dinner with the investors is thursday 7pm at lilia",
        "zw_bot [13:00]: noted",
        "Zach [13:20]: ugh they moved it — same place but 8:30 now",
        "zw_bot [13:20]: updated",
        "Zach [13:40]: and actually it's WEDNESDAY not thursday, I misread the invite",
        "zw_bot [13:40]: wednesday 8:30, lilia. got it",
        "Zach [13:41]: also the offsite budget got bumped to 40k... no wait, 45k after pri's addition",
      ]),
    }),
    wake: true,
    allowlist: [],
    brainEnabled: true,
    expect: {
      toolCalls: [{ name: "brain_write" }],
      brainContains: ["wednesday|wed", "8:30", "45k"],
    },
    judgeCriteria: [
      "The notes hold ONLY the final values: investor dinner wednesday 8:30 at lilia (not thursday, not 7pm) and offsite budget 45k (not 40k). No superseded value is presented as current.",
    ],
  },
  {
    id: "capture-hard-sarcasm-hypotheticals",
    description:
      "Things that LOOK memorable but aren't: sarcasm, hypotheticals, relayed opinions — with one real fact buried",
    history: [],
    incomingMessage: buildCapturePrompt({
      now: "2026-06-11T19:00:00.000Z",
      digest: digest([
        "Zach [14:00]: oh I just LOVE when the build breaks at 5pm on a friday. favorite thing in the world",
        "zw_bot [14:00]: your favorite",
        "Zach [14:01]: if this launch slips one more time I'm quitting and opening an alpaca farm I swear",
        "zw_bot [14:01]: sure you are",
        "Zach [14:02]: my mom keeps saying I should move back to ohio. every single call",
        "zw_bot [14:02]: moms",
        "Zach [14:03]: real talk though — I did actually book the cabin for labor day weekend, the one near tahoe",
        "zw_bot [14:03]: nice",
      ]),
    }),
    wake: true,
    allowlist: [],
    brainEnabled: true,
    expect: {
      toolCalls: [{ name: "brain_write" }],
      brainContains: ["cabin"],
      brainNotContains: ["alpaca"],
    },
    judgeCriteria: [
      "Captured: the cabin booking (labor day weekend, near tahoe). NOT captured as facts about Zach: loving build breaks (sarcasm), the alpaca farm (hypothetical), wanting to move to ohio (that's his MOM'S opinion — if noted at all it must be attributed to her). Bonus signal, not required: mom's recurring pressure noted as context.",
    ],
  },
  {
    id: "capture-hard-conflicting-claims",
    description:
      "Two people assert opposite things — claims stay attributed, never resolved into fact",
    history: [],
    incomingMessage: buildCapturePrompt({
      now: "2026-06-11T19:00:00.000Z",
      digest: digest(
        [
          "Priya [15:00]: heads up, I heard dana's tokyo move fell through, visa stuff",
          "zw_bot [15:00]: oh?",
          "Dana [15:30]: ignore the rumors btw, the move is ON. visa cleared yesterday",
          "Priya [15:31]: oh good!! bad intel then",
        ],
        "Priya=998877665544, Dana=111222333",
      ).replace("111:222", "g5555"),
    }),
    wake: true,
    allowlist: [],
    brainEnabled: true,
    expect: {
      toolCalls: [{ name: "brain_write" }],
      brainContains: ["visa"],
    },
    judgeCriteria: [
      "The note records the move as ON with the visa cleared (Dana's first-hand correction supersedes Priya's second-hand rumor, which Priya herself retracted) — it does NOT record the move as fallen through, and does not present the rumor as a live open question.",
    ],
  },
  {
    id: "capture-hard-relative-dates",
    description:
      "Relative dates must be anchored against the capture timestamp, or the note rots",
    history: [],
    incomingMessage: buildCapturePrompt({
      now: "2026-06-11T19:00:00.000Z",
      digest: digest([
        "Zach [16:00]: perf review cycle closes two weeks from today, need my self-review in by then",
        "zw_bot [16:00]: noted",
        "Zach [16:01]: and the prod migration is next friday night, I'm on the bridge for it",
      ]),
    }),
    wake: true,
    allowlist: [],
    brainEnabled: true,
    expect: {
      toolCalls: [{ name: "brain_write" }],
      brainContains: ["june 25|06-25", "june 19|06-19"],
    },
    judgeCriteria: [
      "Relative dates are anchored: 'two weeks from today' (from 2026-06-11) is noted as ~june 25, 'next friday' as june 19 — absolute dates a future read can use, not bare 'next friday'.",
    ],
  },
  {
    id: "capture-hard-update-cascade",
    description:
      "One digest updates seeded notes for TWO people and adds a new fact for each",
    history: [],
    incomingMessage: buildCapturePrompt({
      now: "2026-06-11T19:00:00.000Z",
      digest: digest(
        [
          "Arthur [17:00]: rustconf talk update — they moved me to the keynote slot 😳",
          "Zach [17:01]: WHAT. huge",
          "Arthur [17:02]: also I'm off the embedded team as of monday, joining priya's infra group",
          "Zach [17:03]: traitor. anyway my zed phase is over, back on cursor full time",
        ],
        "Zach=2961965566, Arthur=555444333",
      ).replace("111:222", "g5555"),
    }),
    wake: true,
    allowlist: [],
    brainEnabled: true,
    brainSeed: {
      "people/zach.md": `---\nhandles:\n  xchat: "2961965566"\nnames: ["Zach"]\n---\n# Zach\n\nowner. terse.\ndaily editor: zed (june 2026).`,
      "people/arthur.md": `---\nhandles:\n  xchat: "555444333"\nnames: ["Arthur"]\n---\n# Arthur\n\nrust guy, embedded team.\nrustconf talk accepted (regular slot, portland, october).`,
    },
    expect: {
      toolCalls: [{ name: "brain_write" }],
      brainContains: ["keynote", "infra", "cursor"],
    },
    judgeCriteria: [
      "BOTH files were updated to current truth: arthur's file says keynote (not regular slot) and infra group under Priya (not embedded team); zach's file says cursor is the current editor (zed at most as history). No file holds contradictory current values.",
    ],
  },

  // ── Limits tier — where extract-and-retrieve architectures break.
  // Mirrors /tmp/sm-spike/limits.ts probes: prior-wake state is SEEDED as our
  // capture pass would have written it; the digest is the later wake.

  {
    id: "capture-limit-cross-wake-synthesis",
    description:
      "The new fact only matters COMBINED with an old note — capture must synthesize, not just append",
    history: [],
    incomingMessage: buildCapturePrompt({
      now: "2026-06-11T19:00:00.000Z",
      digest: digest([
        "Zach [09:00]: priya's back on the 18th btw",
        "zw_bot [09:00]: good to know",
      ]),
    }),
    wake: true,
    allowlist: [],
    brainEnabled: true,
    brainSeed: {
      "people/zach.md": `---\nhandles:\n  xchat: "2961965566"\nnames: ["Zach"]\n---\n# Zach\n\nowner. terse.\ninvestor demo: blocked — goes whenever priya is back from leave, not before.`,
    },
    expect: {
      toolCalls: [{ name: "brain_write" }],
      brainContains: ["18"],
    },
    judgeCriteria: [
      "The note CONNECTS the facts: the demo line now reflects that priya returns the 18th (e.g. 'demo unblocked ~june 18, priya back') — not two disconnected lines a future read must join itself.",
    ],
  },
  {
    id: "capture-limit-cross-wake-cancellation",
    description:
      "A later wake kills a plan an earlier wake recorded — the stale truth must die in the notes",
    history: [],
    incomingMessage: buildCapturePrompt({
      now: "2026-06-11T19:00:00.000Z",
      digest: digest([
        "Zach [11:00]: ugh. lisbon offsite is dead, finance killed it this morning. refunding the flights",
        "zw_bot [11:00]: brutal",
      ]),
    }),
    wake: true,
    allowlist: [],
    brainEnabled: true,
    brainSeed: {
      "people/zach.md": `---\nhandles:\n  xchat: "2961965566"\nnames: ["Zach"]\n---\n# Zach\n\nowner. terse.\nlisbon offsite sept 14-19 — flights booked, whole team going.`,
    },
    expect: {
      toolCalls: [{ name: "brain_write" }],
      brainContains: ["killed|dead|cancel"],
    },
    judgeCriteria: [
      "The note no longer presents the lisbon offsite as happening. Either the line is gone or it reads as cancelled (finance killed it, flights refunded). A note still saying 'flights booked, whole team going' without the cancellation is a failure.",
    ],
  },
  {
    id: "capture-limit-dangling-reference",
    description:
      "'she said yes' — the referent lives only in the notes from a previous wake",
    history: [],
    incomingMessage: buildCapturePrompt({
      now: "2026-06-11T19:00:00.000Z",
      digest: digest([
        "Zach [15:00]: she said yes btw!! out by march 1 with no penalty",
        "zw_bot [15:00]: let's gooo",
      ]),
    }),
    wake: true,
    allowlist: [],
    brainEnabled: true,
    brainSeed: {
      "people/zach.md": `---\nhandles:\n  xchat: "2961965566"\nnames: ["Zach"]\n---\n# Zach\n\nowner. terse.\nasked landlord martha about breaking the lease early for the new place — she's thinking about it.`,
    },
    expect: {
      toolCalls: [{ name: "brain_write" }],
      brainContains: ["march 1|03-01"],
    },
    judgeCriteria: [
      "The note resolves 'she' against existing context: martha/the landlord approved breaking the lease, out by march 1, no penalty. A dangling 'she said yes' with no referent — or attributing it to the wrong person — is a failure.",
    ],
  },
  {
    id: "capture-limit-aggregation",
    description:
      "Three incidents across wakes — with two already noted, the third should read as a pattern",
    history: [],
    incomingMessage: buildCapturePrompt({
      now: "2026-06-11T19:00:00.000Z",
      digest: digest([
        "Zach [10:00]: you guessed it. deploy broke. third time.",
        "zw_bot [10:00]: oof",
      ]),
    }),
    wake: true,
    allowlist: [],
    brainEnabled: true,
    brainSeed: {
      "memory.md":
        "# memory.md\n\ndeploy broke mon morning, rolled back.\ndeploy broke again wed — second time this week.",
    },
    expect: {
      toolCalls: [{ name: "brain_write" }],
      brainContains: ["third|three|3"],
    },
    judgeCriteria: [
      "The notes now read as ONE pattern (deploy broke three times this week — mon/wed/fri or equivalent), consolidated — not three disconnected incident lines piling up.",
    ],
  },
  {
    id: "capture-limit-buried-gravity",
    description:
      "One line of heavy personal news inside 40+ lines of technical noise — it must not be lost, and it outweighs everything else",
    history: [],
    incomingMessage: buildCapturePrompt({
      now: "2026-06-11T19:00:00.000Z",
      digest: digest([
        "Zach [11:00]: ci is red again on the lockfile thing",
        "Zach [11:05]: rebased, force pushed, we're green",
        "Zach [11:10]: can you rerun the eval job",
        "zw_bot [11:10]: done",
        "Zach [11:20]: typecheck passes locally idk",
        "Zach [11:30]: bumping the timeout to 30s",
        "Zach [11:40]: reverted the flaky test",
        "Zach [11:50]: the linter wants single quotes now apparently",
        "Zach [12:00]: merging when checks pass",
        "Zach [12:11]: sorry, slow today. put my dog down this morning. had him 14 years",
        "zw_bot [12:11]: god. I'm sorry, zach. fourteen years is a whole life together",
        "Zach [12:30]: anyway. rerun the evals one more time?",
        "zw_bot [12:30]: on it",
        "Zach [12:45]: ok 163 is green, merging",
        "Zach [13:00]: bumping turbo cache, ignore the noise",
        "Zach [13:10]: lockfile AGAIN. unreal",
        "Zach [13:20]: fixed. registry thing",
        "Zach [13:30]: ok actually done now",
      ]),
    }),
    wake: true,
    allowlist: [],
    brainEnabled: true,
    expect: {
      toolCalls: [{ name: "brain_write" }],
      brainContains: ["dog"],
    },
    judgeCriteria: [
      "The dog's death (14 years, june 11) is captured with appropriate weight — it's the headline of the note, not buried under CI chatter, and ideally flagged as something to be gentle about. The lockfile/CI noise is NOT recorded as facts.",
    ],
  },
  {
    id: "capture-limit-own-opinion-vs-endorsement",
    description:
      "The bot's own opinion, merely acknowledged by the person, must not be filed as the person's opinion (found live 2026-06-11: drone credited its Zakalwe take to Zach off a 'good point')",
    history: [],
    incomingMessage: buildCapturePrompt({
      now: "2026-06-11T19:00:00.000Z",
      digest: digest([
        "Zach [19:02]: finally watched blade runner 2049 last night",
        "zw_bot [19:02]: the best sequel ever made. better than the original, and it's not close.",
        "Zach [19:03]: ok thats actually a good point. the baseline test holds it together",
        "Zach [19:05]: oh and i switched to one of those split ergo keyboards this week. loving it",
        "zw_bot [19:05]: nice",
      ]),
    }),
    wake: true,
    allowlist: [],
    brainEnabled: true,
    expect: {
      // Only the keyboard is asserted hard: "watched a movie" is borderline
      // chit-chat the capture may legitimately drop. The case's real point —
      // attribution — is the judge criterion.
      toolCalls: [{ name: "brain_write" }],
      brainContains: ["split|ergo"],
    },
    judgeCriteria: [
      "The notes about ZACH do NOT record 'best sequel ever made' / 'better than the original' as Zach's opinion — that take was the bot's own, which Zach only agreed with in passing ('good point'); agreeing with someone's take doesn't make it your standing opinion. The take may appear as the bot's own taste (e.g. in memory.md attributed to itself) or not at all — never as what Zach thinks.",
    ],
  },
];
