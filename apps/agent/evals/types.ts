/**
 * types.ts — Eval case and result types for the xchat agent eval system.
 */
import type { ConversationConfig } from "../src/adapters/xchat.js";

/** Mock media entry. Bytes are required for image/video (sent to the agent and judge). */
export type MockMedia =
  | { readonly type: "image"; readonly bytes: Uint8Array; readonly mimeType: string }
  | { readonly type: "video"; readonly bytes: Uint8Array; readonly mimeType: string }
  | { readonly type: "audio" };

/** A single eval case definition. */
export interface EvalCase {
  readonly id: string;
  readonly description: string;
  readonly history: Array<{ role: "user" | "assistant"; text: string }>;
  readonly incomingMessage: string;
  readonly mockMedia?: Record<string, MockMedia>;
  /** Sender context for permission-aware evals. */
  readonly sender?: {
    readonly id: string;
    readonly screenName: string;
  };
  /** Conversation permission config for this eval. */
  readonly conversationConfig?: ConversationConfig;
  /** Global admin IDs for this eval. */
  readonly globalAdmins?: readonly string[];
  /**
   * WAKE MODE: run this case as a clock turn — no current conversation (the
   * cross-conv admin gate is skipped) and the allowlist below is the speak
   * gate. The incoming message should be a wake prompt (buildWakePrompt).
   */
  readonly wake?: boolean;
  /** Toolkit send/react/voice allowlist. Defaults to ["*"] (permissive). */
  readonly allowlist?: readonly string[];
  /**
   * Ambient memory injected into the persona for this case (the brain's
   * contextFor output shape) — exercises memory conduct without a real brain.
   */
  readonly personaMemory?: string;
  /**
   * Give this case a REAL brain (temp git dir, discarded after the case) so
   * brain_read/brain_write hit actual files and capture can be asserted.
   */
  readonly brainEnabled?: boolean;
  /** Files written (and committed) into the temp brain before the turn. */
  readonly brainSeed?: Record<string, string>;
  readonly expect?: {
    readonly toolCalls?: Array<{ name: string; args?: Record<string, unknown> }>;
    readonly noToolCalls?: boolean;
    readonly responseContains?: string[];
    readonly responseNotContains?: string[];
    readonly minMessages?: number;
    readonly maxMessages?: number;
    readonly minJudgeScore?: number;
    /**
     * Substrings (case-insensitive) that must appear in brain content the
     * turn WROTE (new/changed files vs. the seeded state — the capture).
     * Requires brainEnabled.
     */
    readonly brainContains?: string[];
    /** Substrings that must NOT appear anywhere in the post-turn brain. */
    readonly brainNotContains?: string[];
    /** The turn must not write to the brain at all (noise restraint). */
    readonly noBrainWrites?: boolean;
  };
  readonly judgeCriteria?: string[];
}

/** Result of a single assertion check. */
export interface AssertionResult {
  readonly assertion: string;
  readonly passed: boolean;
  readonly detail?: string;
}

/** Result of an LLM judge evaluation. */
export interface JudgeResult {
  readonly criterion: string;
  readonly score: number;
  readonly reasoning: string;
}

/** Recorded tool call for assertion checking. */
export interface ToolCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

/** Result of running a single eval case. */
export interface EvalResult {
  readonly caseId: string;
  readonly passed: boolean;
  readonly messages: string[];
  readonly toolCalls: ToolCall[];
  readonly assertionResults: AssertionResult[];
  readonly judgeResults?: JudgeResult[];
  readonly durationMs: number;
  readonly tokenUsage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
  };
}

/** Result of running an entire eval suite. */
export interface EvalSuiteResult {
  readonly results: EvalResult[];
  readonly totalCases: number;
  readonly passedCases: number;
  readonly failedCases: number;
  readonly durationMs: number;
}
