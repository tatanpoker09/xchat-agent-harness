/**
 * skills.ts — Skill discovery and loading.
 *
 * Scans the skills directory for SKILL.md files with YAML frontmatter.
 * Returns an index for the system prompt and full content for the use_skill tool.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

export interface SkillMeta {
  readonly name: string;
  readonly description: string;
  readonly whenToUse: string;
  readonly path: string;
}

/** Parse YAML frontmatter from a SKILL.md file. Very simple parser — handles only string fields. */
const parseFrontmatter = (content: string): Record<string, string> => {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx <= 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const raw = line.slice(colonIdx + 1).trim();
    const value = raw.replace(/^["']|["']$/g, "");
    if (key && value) fields[key] = value;
  }
  return fields;
};

/** Discover all skills in the skills directory. */
export const discoverSkills = (skillsDir?: string): SkillMeta[] => {
  const dir = skillsDir ?? resolve(import.meta.dirname, "../skills");
  const skills: SkillMeta[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return skills;
  }

  for (const entry of entries) {
    const skillPath = resolve(dir, entry, "SKILL.md");
    try {
      const content = readFileSync(skillPath, "utf-8");
      const frontmatter = parseFrontmatter(content);
      skills.push({
        name: frontmatter.name ?? entry,
        description: frontmatter.description ?? "",
        whenToUse: frontmatter.when_to_use ?? frontmatter.description ?? "",
        path: skillPath,
      });
    } catch {
      // Skip directories without SKILL.md
    }
  }

  return skills;
};

export interface SkillContent {
  readonly content: string;
  readonly dir: string;
}

/** Load the full content of a skill by name, with ${CLAUDE_SKILL_DIR} substitution. */
export const loadSkill = (name: string, skillsDir?: string): SkillContent | null => {
  const dir = skillsDir ?? resolve(import.meta.dirname, "../skills");
  const skillDir = resolve(dir, name);
  const skillPath = resolve(skillDir, "SKILL.md");
  try {
    let content = readFileSync(skillPath, "utf-8");
    // Substitute ${CLAUDE_SKILL_DIR} with the absolute skill directory path
    content = content.replace(/\$\{CLAUDE_SKILL_DIR\}/g, skillDir);
    return { content, dir: skillDir };
  } catch {
    return null;
  }
};
