/**
 * skill-tool.ts — Skill loading agent tool.
 *
 * Reads a skill's SKILL.md content and returns it as context
 * for the agent to follow.
 */
import { Effect, Schema } from "effect";
import { Tool } from "effect/unstable/ai";

import { loadSkill } from "../skills.js";
import type { ToolHandler } from "./types.js";

// ── Tool schema ──

export const UseSkill = Tool.make("use_skill", {
  description:
    "Load a skill's instructions into context. Use this before performing a task that matches an available skill. The skill content will guide you through the workflow step by step.",
  parameters: Schema.Struct({
    name: Schema.String,
  }),
  success: Schema.String,
});

// ── Handler ──

export const useSkillHandler: ToolHandler<{ readonly name: string }> = (params) =>
  Effect.gen(function* () {
    const result = loadSkill(params.name);
    if (!result) {
      return yield* Effect.fail(
        `Skill "${params.name}" not found. Check available skills in your system prompt.`,
      );
    }
    return `Base directory for this skill: ${result.dir}\n\n${result.content}`;
  });
