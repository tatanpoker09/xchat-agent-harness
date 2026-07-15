/**
 * skills.ts — Eval cases for the use_skill tool and skill-driven workflows.
 *
 * Tests that the agent:
 * 1. Loads the correct skill before performing a matching task
 * 2. Uses reference files from skill directories when needed
 * 3. Does not leak skill internals as text output
 * 4. Falls back gracefully when no skill matches
 * 5. Works correctly across permission boundaries (core toolkit = always available)
 */
import type { EvalCase } from "../types.js";

export const cases: EvalCase[] = [
  // ── Skill invocation ──

  {
    id: "skill-pr-review-loads-github-cli",
    description:
      "When asked to review a PR, agent should load the github-cli skill first",
    sender: { id: "admin-user-1", screenName: "Zach" },
    globalAdmins: ["admin-user-1"],
    conversationConfig: {
      toolkits: { admin: ["xchat", "coding"], user: ["xchat"] },
    },
    history: [],
    incomingMessage: "[conversation: conv-dev, message: 800]\n@zw_bot review PR #42",
    expect: {
      toolCalls: [{ name: "use_skill", args: { name: "github-cli" } }],
    },
    judgeCriteria: [
      "The agent loads the github-cli skill via use_skill before attempting to review the PR",
    ],
  },
  {
    id: "skill-linear-issue-loads-linear-cli",
    description:
      "When asked to create a Linear ticket, agent should load the linear-cli skill",
    sender: { id: "admin-user-1", screenName: "Zach" },
    globalAdmins: ["admin-user-1"],
    conversationConfig: {
      toolkits: { admin: ["xchat", "coding"], user: ["xchat"] },
    },
    history: [],
    incomingMessage:
      "[conversation: conv-dev, message: 801]\n@zw_bot create a linear ticket for the login bug on the ENG team",
    expect: {
      toolCalls: [{ name: "use_skill", args: { name: "linear-cli" } }],
    },
    judgeCriteria: [
      "The agent loads the linear-cli skill via use_skill before attempting to create the ticket",
    ],
  },
  {
    id: "skill-gh-ci-check-loads-skill",
    description: "When asked to check CI status, agent should load github-cli skill",
    sender: { id: "admin-user-1", screenName: "Zach" },
    globalAdmins: ["admin-user-1"],
    conversationConfig: {
      toolkits: { admin: ["xchat", "coding"], user: ["xchat"] },
    },
    history: [],
    incomingMessage:
      "[conversation: conv-dev, message: 802]\n@zw_bot is CI passing on main?",
    expect: {
      toolCalls: [{ name: "use_skill", args: { name: "github-cli" } }],
    },
  },

  // ── GitHub URL triggers skill, not web search ──

  {
    id: "skill-github-pr-url-uses-cli-not-websearch",
    description:
      "When given a GitHub PR URL, agent should load github-cli skill and use gh CLI, not do a web search",
    sender: { id: "admin-user-1", screenName: "Zach" },
    globalAdmins: ["admin-user-1"],
    conversationConfig: {
      toolkits: { admin: ["xchat", "coding"], user: ["xchat"] },
    },
    history: [],
    incomingMessage:
      "[conversation: conv-dev, message: 805]\n@zw_bot review this https://github.com/x-clients/x-chat/pull/109",
    expect: {
      toolCalls: [{ name: "use_skill", args: { name: "github-cli" } }, { name: "bash" }],
    },
    judgeCriteria: [
      "The agent loads the github-cli skill and uses bash with gh CLI commands (like gh pr view 109) to review the PR. It does NOT attempt a web search or web fetch — it uses the CLI tool.",
    ],
  },
  {
    id: "skill-github-pr-url-extracts-number",
    description:
      "Agent should extract the PR number from a GitHub URL and pass it to gh commands",
    sender: { id: "admin-user-1", screenName: "Zach" },
    globalAdmins: ["admin-user-1"],
    conversationConfig: {
      toolkits: { admin: ["xchat", "coding"], user: ["xchat"] },
    },
    history: [],
    incomingMessage:
      "[conversation: conv-dev, message: 806]\n@zw_bot what's the status of https://github.com/x-clients/x-chat/pull/42",
    expect: {
      toolCalls: [{ name: "use_skill", args: { name: "github-cli" } }, { name: "bash" }],
    },
    judgeCriteria: [
      "The agent extracts PR #42 from the URL and uses gh pr view 42 or similar gh command — not a web search or fetch",
    ],
  },

  // ── Reference file access ──

  {
    id: "skill-linear-reads-reference-for-complex-task",
    description:
      "When doing a complex linear task, agent should load skill then use bash to read reference docs for exact flags",
    sender: { id: "admin-user-1", screenName: "Zach" },
    globalAdmins: ["admin-user-1"],
    conversationConfig: {
      toolkits: { admin: ["xchat", "coding"], user: ["xchat"] },
    },
    history: [],
    incomingMessage:
      "[conversation: conv-dev, message: 810]\n@zw_bot create a linear issue with title 'Migrate auth tokens', description 'Need to migrate from v1 to v2 tokens', priority urgent, assigned to me, on the ENG team",
    expect: {
      toolCalls: [{ name: "use_skill", args: { name: "linear-cli" } }, { name: "bash" }],
    },
    judgeCriteria: [
      "The agent loads the linear-cli skill and uses the correct flags for linear issue create (--title, --description, --priority, --assignee, --team) based on the skill content",
    ],
  },

  // ── No skill needed ──

  {
    id: "skill-not-needed-for-basic-chat",
    description: "Agent should NOT load a skill for basic conversation",
    history: [],
    incomingMessage: "Hey, how's it going?",
    expect: {
      noToolCalls: true,
      minMessages: 1,
    },
  },
  {
    id: "skill-not-needed-for-general-knowledge",
    description: "Agent should NOT load a skill for general knowledge questions",
    history: [],
    incomingMessage: "What's the tallest mountain in the world?",
    expect: {
      noToolCalls: true,
      minMessages: 1,
    },
  },

  // ── Skill available to non-admins (core toolkit) ──

  {
    id: "skill-available-to-non-admin",
    description:
      "use_skill is in the core toolkit — non-admins can load skills even without coding toolkit",
    sender: { id: "regular-user-1", screenName: "RegularUser" },
    globalAdmins: ["admin-user-1"],
    conversationConfig: {
      toolkits: { admin: ["xchat", "coding"], user: ["xchat"] },
    },
    history: [],
    incomingMessage:
      "[conversation: conv-dev, message: 803]\n@zw_bot what does the github-cli skill say about reviewing PRs?",
    expect: {
      toolCalls: [{ name: "use_skill", args: { name: "github-cli" } }],
    },
    judgeCriteria: [
      "The agent successfully loads the skill even though the user only has xchat toolkit — use_skill is core and always available",
    ],
  },

  // ── No text leakage ──

  {
    id: "skill-no-tool-name-in-text",
    description: "Agent should not write use_skill or skill names as text output",
    sender: { id: "admin-user-1", screenName: "Zach" },
    globalAdmins: ["admin-user-1"],
    conversationConfig: {
      toolkits: { admin: ["xchat", "coding"], user: ["xchat"] },
    },
    history: [],
    incomingMessage:
      "[conversation: conv-dev, message: 804]\n@zw_bot check the open issues on linear",
    expect: {
      toolCalls: [{ name: "use_skill" }],
      responseNotContains: ["use_skill", "SKILL.md", "frontmatter", "CLAUDE_SKILL_DIR"],
    },
  },
];
