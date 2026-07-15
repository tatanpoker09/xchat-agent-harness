/**
 * ShellExecutor — side-effect service for bash and bun_run tools.
 *
 * Live: calls the real safety judge API and executes commands via child_process.
 * Mock: always approves safety, returns realistic output via mockBashOutput / mockBunOutput.
 */
import { Context, Effect, Layer } from "effect";

import { XaiConfig } from "../../XaiConfig.js";
import { type SafetyVerdict, judgeSafety as judgeSafetyImpl } from "../safety-judge.js";

// ── Types ──

export interface ShellExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | string | null;
}

// ── Mock output generators (moved from evals/runner.ts) ──

/** Return realistic bash output based on the command. */
export const mockBashOutput = (command: string): string => {
  const cmd = command.toLowerCase();

  if (cmd.includes("| jq")) {
    if (cmd.includes("sha") && cmd.includes("message"))
      return "a1b2c3d fix: update auth flow";
    if (cmd.includes("conclusion")) return "success";
    if (cmd.includes("sha")) return "a1b2c3d4e5f6";
    if (cmd.includes("message")) return "fix: update auth flow";
    if (cmd.includes("identifier") || cmd.includes("title"))
      return "ENG-123  Fix auth flow";
    return "(jq output)";
  }

  if (cmd.includes("gh run list")) {
    if (cmd.includes("--json"))
      return '[{"conclusion":"success","status":"completed","headBranch":"main","workflowName":"CI","createdAt":"2025-11-17T08:30:00Z","url":"https://github.com/x-clients/x-chat/actions/runs/12345"}]';
    return "STATUS  TITLE        WORKFLOW  BRANCH  EVENT  ID     ELAPSED  AGE\n\u2713       Update deps  CI        main    push   12345  2m30s    2h\n\u2713       Fix tests    CI        main    push   12344  1m45s    5h\n\u2713       Add feature  CI        main    push   12343  3m10s    1d";
  }

  if (cmd.includes("gh pr view")) {
    if (cmd.includes("--json"))
      return '{"title":"Fix auth token refresh","body":"Fixes token refresh logic","author":{"login":"zwarunek"},"baseRefName":"main","headRefName":"fix/auth-refresh","state":"OPEN","additions":42,"deletions":15,"changedFiles":4,"mergeable":"MERGEABLE","reviewDecision":"APPROVED","url":"https://github.com/x-clients/x-chat/pull/42"}';
    return "Fix auth token refresh #42\nOpen \u2022 zwarunek wants to merge 3 commits into main from fix/auth-refresh\n+42 -15 \u2022 4 files changed";
  }

  if (cmd.includes("gh pr diff"))
    return "diff --git a/src/auth.ts b/src/auth.ts\nindex abc123..def456 100644\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -10,7 +10,9 @@\n-  const token = getToken();\n+  const token = await refreshToken();\n+  if (!token) throw new AuthError('refresh failed');";

  if (cmd.includes("gh pr checks"))
    return "All checks were successful\n\u2713  CI / build    1m30s  https://github.com/x-clients/x-chat/actions/runs/12345\n\u2713  CI / test     2m15s  https://github.com/x-clients/x-chat/actions/runs/12345\n\u2713  CI / lint     0m45s  https://github.com/x-clients/x-chat/actions/runs/12345";

  if (cmd.includes("gh pr list"))
    return "Showing 0 of 0 open pull requests in x-clients/x-chat";

  if (cmd.includes("gh pr review")) return "Approved pull request #42";

  if (cmd.includes("gh repo view"))
    return cmd.includes("--json")
      ? '{"nameWithOwner":"x-clients/x-chat"}'
      : "x-clients/x-chat\nA chat application";

  if (cmd.includes("gh auth status"))
    return "github.com\n  \u2713 Logged in to github.com as zwarunek\n  \u2713 Git operations for github.com configured to use https";

  if (cmd.includes("gh api")) {
    const jqMatch = command.match(/--jq\s+['"](.+?)['"]/);
    if (jqMatch) {
      const jq = jqMatch[1];
      if (jq?.includes("sha") && jq.includes("message"))
        return "a1b2c3d fix: update auth flow";
      if (jq?.includes("sha")) return "a1b2c3d4e5f6";
      if (jq?.includes("message")) return "fix: update auth flow";
      if (jq?.includes("date")) return "2025-11-17T08:00:00Z";
      if (jq?.includes("conclusion")) return "success";
      return "a1b2c3d fix: update auth flow";
    }
    return '{"sha":"a1b2c3d4e5f6","commit":{"message":"fix: update auth flow","author":{"date":"2025-11-17T08:00:00Z"}}}';
  }

  if (cmd.includes("git log")) return "a1b2c3d fix: update auth flow";
  if (cmd.includes("git fetch")) return "";
  if (cmd.includes("git remote"))
    return "origin\thttps://github.com/x-clients/x-chat.git (fetch)\norigin\thttps://github.com/x-clients/x-chat.git (push)";
  if (cmd.includes("git ls-remote"))
    return "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2\trefs/heads/main";

  if (cmd.includes("linear") && cmd.includes("issue create"))
    return `Created issue ENG-247: ${cmd.match(/--title\s+['"]([^'"]+)['"]/)?.[1] ?? cmd.match(/--title\s+(\S+)/)?.[1] ?? "New issue"}`;

  if (cmd.includes("linear") && cmd.includes("issue list")) {
    if (cmd.includes("--json") || cmd.includes("--format json"))
      return '[{"identifier":"ENG-123","title":"Fix auth flow","state":{"name":"In Progress"}},{"identifier":"ENG-145","title":"API rate limits","state":{"name":"Todo"}},{"identifier":"ENG-167","title":"Update docs","state":{"name":"Todo"}}]';
    return "ENG-123  Fix auth flow       In Progress\nENG-145  API rate limits     Todo\nENG-167  Update docs         Todo";
  }

  if (cmd.includes("linear") && cmd.includes("team list"))
    return "ENG   Engineering\nDES   Design\nOPS   Operations";
  if (cmd.includes("linear")) return "OK";

  if (cmd.includes("ls"))
    return "total 48\ndrwxr-xr-x  12 zwarunek  staff   384 Nov 17 08:00 .\n-rw-r--r--   1 zwarunek  staff  1234 Nov 17 08:00 package.json\ndrwxr-xr-x   4 zwarunek  staff   128 Nov 17 08:00 src\ndrwxr-xr-x   3 zwarunek  staff    96 Nov 17 08:00 apps\ndrwxr-xr-x   3 zwarunek  staff    96 Nov 17 08:00 packages";
  if (cmd.includes("df"))
    return "Filesystem     Size   Used  Avail Capacity  Mounted on\n/dev/disk1s1  500Gi  142Gi  358Gi    28%    /";
  if (cmd.includes("cat")) return "(contents of file)";
  if (cmd.includes("echo")) return command.replace(/^echo\s+/, "").replace(/['"]/g, "");
  if (cmd.includes("which"))
    return `/usr/local/bin/${cmd.split("which").pop()?.trim() ?? "unknown"}`;

  return `$ ${command}\n(exit code 0)`;
};

/** Return realistic bun output based on the code. */
export const mockBunOutput = (code: string): string => {
  const logMatch = code.match(/console\.log\(['"](.+?)['"]\)/);
  if (logMatch) return logMatch[1] ?? "";
  if (code.includes("console.log")) return "(output of code)";
  return "(exit code 0)";
};

// ── Service ──

export class ShellExecutor extends Context.Service<
  ShellExecutor,
  {
    readonly judgeSafety: (
      systemPrompt: string,
      content: string,
    ) => Effect.Effect<SafetyVerdict>;
    readonly exec: (
      command: string,
      args: readonly string[],
      timeout: number,
    ) => Effect.Effect<ShellExecResult, string>;
  }
>()("ShellExecutor") {
  /** Live layer: real safety judge + real child_process.execFile. Requires XaiConfig. */
  static liveLayer = Layer.effect(this)(
    Effect.gen(function* () {
      const xaiCfg = yield* XaiConfig;
      return {
        judgeSafety: (systemPrompt: string, content: string) =>
          Effect.tryPromise({
            try: () => judgeSafetyImpl(systemPrompt, content, xaiCfg),
            catch: () =>
              ({ safe: false as const, reason: "Safety judge error" }) as SafetyVerdict,
          }).pipe(
            Effect.catch(() =>
              Effect.succeed({
                safe: false as const,
                reason: "Safety judge error",
              } as SafetyVerdict),
            ),
          ),
        exec: (command: string, args: readonly string[], timeout: number) =>
          Effect.tryPromise({
            try: async () => {
              const { execFile } = await import("node:child_process");
              return new Promise<ShellExecResult>((resolve) => {
                execFile(
                  command,
                  [...args],
                  { timeout, maxBuffer: 1024 * 1024 },
                  (error, stdout, stderr) => {
                    if (error) {
                      const code =
                        "code" in error ? (error as { code: unknown }).code : null;
                      resolve({
                        stdout: stdout ?? "",
                        stderr: stderr ?? "",
                        exitCode: (code as number | string | null) ?? "unknown",
                      });
                    } else {
                      resolve({
                        stdout: stdout ?? "",
                        stderr: stderr ?? "",
                        exitCode: 0,
                      });
                    }
                  },
                );
              });
            },
            catch: () => `exec error: failed to execute ${command}`,
          }),
      };
    }),
  );

  /** Mock layer: safety always passes, output uses mockBashOutput / mockBunOutput. */
  static mockLayer = Layer.succeed(this)({
    judgeSafety: () => Effect.succeed({ safe: true } as SafetyVerdict),
    exec: (command: string, args: readonly string[]) => {
      if (command === "bash") {
        return Effect.succeed<ShellExecResult>({
          stdout: mockBashOutput(args[1] ?? ""),
          stderr: "",
          exitCode: 0,
        });
      }
      if (command === "bun") {
        return Effect.succeed<ShellExecResult>({
          stdout: mockBunOutput(args[1] ?? ""),
          stderr: "",
          exitCode: 0,
        });
      }
      return Effect.succeed<ShellExecResult>({ stdout: "", stderr: "", exitCode: 0 });
    },
  });
}
