import { describe, expect, it } from "vitest";
import { Engine, simulate, walkAllPaths, type Flow } from "../src/index.js";

const flow: Flow = {
  id: "quiz",
  version: "1.0.0",
  entry: "ask",
  nodes: {
    ask: { type: "prompt", text: "capital of France?", slot: { name: "answer", type: "string" }, next: "check" },
    check: {
      type: "branch",
      cases: [{ when: { slot: "answer", op: "eq", value: "Paris" }, next: "right" }],
      else: "wrong",
    },
    right: { type: "message", text: "correct!", next: "end" },
    wrong: { type: "message", text: "nope", next: "end" },
    end: { type: "end" },
  },
};

describe("simulate", () => {
  it("runs a script and passes matching expectations", async () => {
    const engine = new Engine();
    engine.register(flow);
    const result = await simulate(engine, "quiz", [
      { user: "Paris", expect: { messages: ["correct"], slots: { answer: "Paris" }, status: "done" } },
    ]);
    expect(result.failures).toEqual([]);
    expect(result.transcript).toEqual([
      { role: "bot", text: "capital of France?" },
      { role: "user", text: "Paris" },
      { role: "bot", text: "correct!" },
      { role: "system", text: "[conversation ended]" },
    ]);
  });

  it("reports failed message and slot expectations", async () => {
    const engine = new Engine();
    engine.register(flow);
    const result = await simulate(engine, "quiz", [
      { user: "London", expect: { messages: ["correct"], slots: { answer: "Paris" } } },
    ]);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]).toContain('expected a message containing "correct"');
    expect(result.failures[1]).toContain("expected slot answer");
  });

  it("reports input sent after the conversation ended", async () => {
    const engine = new Engine();
    engine.register(flow);
    const result = await simulate(engine, "quiz", [{ user: "Paris" }, { user: "again?" }]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("already ended");
  });

  it("executes action effects through the provided handlers", async () => {
    const withAction: Flow = {
      id: "act",
      version: "1.0.0",
      entry: "go",
      nodes: {
        go: { type: "prompt", text: "id?", slot: { name: "id", type: "string" }, next: "fetch" },
        fetch: { type: "action", handler: "fetch", input: { id: "id" }, output: "data", on_error: "fail", next: "say" },
        say: { type: "message", text: "got {{data.name}}", next: "end" },
        fail: { type: "handoff", reason: "backend down" },
        end: { type: "end" },
      },
    };
    const engine = new Engine();
    engine.register(withAction);
    const result = await simulate(
      engine,
      "act",
      [{ user: "42", expect: { messages: ["got widget"], status: "done" } }],
      { handlers: { fetch: async () => ({ name: "widget" }) } },
    );
    expect(result.failures).toEqual([]);
    expect(result.transcript).toContainEqual({ role: "system", text: "[action fetch -> ok]" });
  });
});

describe("walkAllPaths", () => {
  it("verifies every path of a well-formed flow terminates", () => {
    const result = walkAllPaths(flow);
    expect(result.ok).toBe(true);
    expect(result.pathsExplored).toBe(2); // right and wrong
    expect(result.nonTerminating).toEqual([]);
  });

  it("catches a loop with no exit", () => {
    const looping: Flow = {
      id: "loop",
      version: "1.0.0",
      entry: "a",
      nodes: {
        a: { type: "message", text: "a", next: "b" },
        b: {
          type: "branch",
          cases: [{ when: { slot: "x", op: "eq", value: 1 }, next: "a" }],
          else: "a",
        },
      },
    };
    const result = walkAllPaths(looping, { maxDepth: 10 });
    expect(result.ok).toBe(false);
    expect(result.nonTerminating.length).toBeGreaterThan(0);
    expect(result.nonTerminating[0]!.length).toBe(10);
  });

  it("includes error and exhaustion edges in the walk", () => {
    const branchy: Flow = {
      id: "b",
      version: "1.0.0",
      entry: "ask",
      nodes: {
        ask: {
          type: "prompt",
          text: "?",
          slot: { name: "x", type: "string" },
          max_attempts: 2,
          on_exhausted: "give_up",
          next: "act",
        },
        act: { type: "action", handler: "h", on_error: "give_up", next: "done" },
        done: { type: "message", text: "ok", next: "end" },
        give_up: { type: "handoff", reason: "stuck" },
        end: { type: "end" },
      },
    };
    const result = walkAllPaths(branchy);
    expect(result.ok).toBe(true);
    // ask->act->done->end, ask->act->give_up, ask->give_up
    expect(result.pathsExplored).toBe(3);
  });

  it("flags paths that run off a dangling edge", () => {
    const dangling: Flow = {
      id: "d",
      version: "1.0.0",
      entry: "a",
      nodes: { a: { type: "message", text: "a", next: "ghost" } },
    };
    const result = walkAllPaths(dangling);
    expect(result.ok).toBe(false);
    expect(result.nonTerminating).toEqual([["a", "ghost"]]);
  });
});
