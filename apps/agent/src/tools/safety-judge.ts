/**
 * safety-judge.ts — Shared LLM safety judge utility.
 *
 * Calls the xAI chat completions API with a tool-specific system prompt
 * to decide whether user-provided content is safe to execute.
 */

import { fetchWithTimeout } from "./fetch-with-timeout.js";

export interface SafetyVerdict {
  safe: boolean;
  reason?: string;
}

export interface SafetyJudgeConfig {
  apiKey: string;
  apiUrl: string;
  model: string;
}

/**
 * Ask the LLM safety judge whether the given content is safe to execute.
 *
 * @param systemPrompt - Tool-specific system prompt describing what to allow/block.
 * @param userContent  - The user-provided content to evaluate (command, code, etc.).
 * @param config       - API connection details (key, url, model).
 */
export const judgeSafety = async (
  systemPrompt: string,
  userContent: string,
  config: SafetyJudgeConfig,
): Promise<SafetyVerdict> => {
  const { apiKey, apiUrl, model } = config;
  if (!apiKey) return { safe: false, reason: "XAI_API_KEY not set" };

  try {
    const response = await fetchWithTimeout(
      `${apiUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent },
          ],
          temperature: 0,
          max_tokens: 100,
        }),
      },
      10_000,
    );

    if (!response.ok) {
      return { safe: false, reason: `Safety judge API error: ${response.status}` };
    }

    const result = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    const content = result.choices[0]?.message?.content?.trim() ?? "";

    // Parse JSON response — strip code fences if present
    const jsonStr = content
      .replace(/^```json?\n?/, "")
      .replace(/\n?```$/, "")
      .trim();
    const parsed = JSON.parse(jsonStr) as { safe: unknown; reason?: string };

    // Strictly validate the safe field is a boolean true
    if (parsed.safe !== true) {
      return {
        safe: false,
        reason: parsed.reason ?? "unsafe content detected",
      };
    }
    return { safe: true };
  } catch {
    // If the judge fails, block by default
    return { safe: false, reason: "Safety judge failed to evaluate content" };
  }
};
