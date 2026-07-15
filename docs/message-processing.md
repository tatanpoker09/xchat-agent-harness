# Smarter Message Processing

## Problem
Rapid successive messages in the same conversation can cause races:
- Multiple `listenAndRespond` invocations overlap
- `lastSeenId` updates aren't atomic
- Duplicate processing or missed ordering

## Proposed solution
Per-conversation bounded queue + seq-id dedup:

- Maintain `Map<convId, { queue: Message[], processing: boolean, lastSeq: string }>`
- On new message: enqueue if seq > lastSeq, else drop
- Process queue serially with `Effect.sequential` or simple lock
- Flush on idle (debounce 200ms) or explicit drain

Keeps the existing per-convo watcher but adds a small coordinator in the adapter.

Next: implement in xchat-agent and wire into the harness.
