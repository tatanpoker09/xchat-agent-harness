# Sub-Agents & Async Work

## Rule
If a task is expected to take >5s:
1. Reply to the user immediately ("working on it" or equivalent).
2. Spawn a background sub-agent / worker to do the heavy lifting.
3. Report results later (via DM or scheduled wake).

## Design
- Lightweight worker pool (Bun workers or separate Effect fibers)
- Keyed by job type or conversation
- `schedule_wake` already available for result delivery
- New tool: `spawn_subagent(prompt, context, timeout?)` that returns a jobId

This keeps the main agent responsive while long-running work (Linear queries, repo ops, analysis) happens off the hot path.

Implementation target: xchat-agent + harness.
