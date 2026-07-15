import { describe, expect, it } from "bun:test";
import { Cause, Deferred, Effect } from "effect";
import { reconcileWatchers, reportWatcherExit } from "../xchat.js";

/** Fake fiber — identity is what matters, so each fork returns a fresh object. */
interface FakeFiber {
  readonly convId: string;
  readonly forkSeq: number;
}

const harness = (initial: readonly string[] = []) => {
  const fibers = new Map<string, FakeFiber>();
  const forked: string[] = [];
  const interrupted: string[] = [];
  let seq = 0;
  const run = (desired: readonly string[]) =>
    Effect.runSync(
      reconcileWatchers({
        fibers,
        desired,
        fork: (convId) => {
          forked.push(convId);
          seq += 1;
          return Effect.succeed({ convId, forkSeq: seq });
        },
        interrupt: (convId, _fiber) => {
          interrupted.push(convId);
          return Effect.void;
        },
      }),
    );
  // Seed initial watchers through the same path as boot.
  if (initial.length > 0) run(initial);
  return { fibers, forked, interrupted, run };
};

describe("reconcileWatchers", () => {
  it("forks a watcher for every desired id on first run (boot)", () => {
    const h = harness();
    const result = h.run(["a:b", "c:d"]);
    expect(result.added.sort()).toEqual(["a:b", "c:d"]);
    expect(result.removed).toEqual([]);
    expect([...h.fibers.keys()].sort()).toEqual(["a:b", "c:d"]);
  });

  it("is a no-op when desired matches running", () => {
    const h = harness(["a:b", "c:d"]);
    const before = new Map(h.fibers);
    const result = h.run(["a:b", "c:d"]);
    expect(result).toEqual({ added: [], removed: [] });
    // Same fiber instances — nothing re-forked.
    expect(h.fibers.get("a:b")).toBe(before.get("a:b") as FakeFiber);
    expect(h.fibers.get("c:d")).toBe(before.get("c:d") as FakeFiber);
    expect(h.forked).toEqual(["a:b", "c:d"]); // only the boot forks
    expect(h.interrupted).toEqual([]);
  });

  it("forks only the added id", () => {
    const h = harness(["a:b"]);
    const result = h.run(["a:b", "e:f"]);
    expect(result.added).toEqual(["e:f"]);
    expect(result.removed).toEqual([]);
    expect(h.fibers.size).toBe(2);
  });

  it("interrupts and deletes the removed id", () => {
    const h = harness(["a:b", "c:d"]);
    const result = h.run(["a:b"]);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual(["c:d"]);
    expect(h.interrupted).toEqual(["c:d"]);
    expect([...h.fibers.keys()]).toEqual(["a:b"]);
  });

  it("handles add + remove in one reconcile", () => {
    const h = harness(["a:b", "c:d"]);
    const result = h.run(["c:d", "g1234"]);
    expect(result.added).toEqual(["g1234"]);
    expect(result.removed).toEqual(["a:b"]);
    expect([...h.fibers.keys()].sort()).toEqual(["c:d", "g1234"]);
  });

  it("re-adding a removed id forks a fresh fiber", () => {
    const h = harness(["a:b"]);
    const first = h.fibers.get("a:b") as FakeFiber;
    h.run([]);
    expect(h.fibers.size).toBe(0);
    h.run(["a:b"]);
    const second = h.fibers.get("a:b") as FakeFiber;
    expect(second).not.toBe(first);
    expect(second.forkSeq).toBeGreaterThan(first.forkSeq);
  });

  it("dedupes duplicate ids in the desired list", () => {
    const h = harness();
    const result = h.run(["a:b", "a:b"]);
    expect(result.added).toEqual(["a:b"]);
    expect(h.fibers.size).toBe(1);
    expect(h.forked).toEqual(["a:b"]);
  });
});

describe("reportWatcherExit", () => {
  // Regression: found live — interrupting a removed watcher must NOT count
  // as an adapter failure, or removing a conv id from the allowlist kills
  // the whole adapter.
  it("ignores interrupt-only causes (deliberate watcher removal)", () => {
    const result = Effect.runSync(
      Effect.gen(function* () {
        const failure = yield* Deferred.make<never, unknown>();
        yield* reportWatcherExit(failure, Cause.interrupt(1));
        return yield* Deferred.isDone(failure);
      }),
    );
    expect(result).toBe(false);
  });

  it("propagates real failures to the deferred", () => {
    const result = Effect.runSync(
      Effect.gen(function* () {
        const failure = yield* Deferred.make<never, unknown>();
        yield* reportWatcherExit(failure, Cause.fail("stream died"));
        return yield* Deferred.isDone(failure);
      }),
    );
    expect(result).toBe(true);
  });
});
