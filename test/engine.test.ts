import { describe, expect, it } from "vitest";
import {
  Engine,
  EngineError,
  InMemoryStateStore,
  evalCondition,
  interpolate,
  runAction,
  type ConversationState,
  type Flow,
  type RunActionEffect,
} from "../src/index.js";

function engineWith(...flows: Flow[]): Engine {
  const engine = new Engine();
  for (const flow of flows) engine.register(flow);
  return engine;
}

const promptFlow = (slot: Flow["nodes"][string], extra: Partial<Flow["nodes"]> = {}): Flow => ({
  id: "t",
  version: "1.0.0",
  entry: "greet",
  nodes: {
    greet: { type: "message", text: "hello", next: "ask" },
    ask: slot,
    done: { type: "message", text: "got {{answer}}", next: "end" },
    end: { type: "end" },
    ...extra,
  },
});

describe("start / basic advancement", () => {
  it("emits messages up to the first prompt and awaits input", () => {
    const engine = engineWith(
      promptFlow({
        type: "prompt",
        text: "what?",
        slot: { name: "answer", type: "string" },
        next: "done",
      }),
    );
    const { state, effects } = engine.start("t");
    expect(effects).toEqual([
      { type: "message", text: "hello" },
      { type: "message", text: "what?" },
    ]);
    expect(state.status).toBe("awaiting_input");
    expect(state.node).toBe("ask");
  });

  it("throws when a message loop never yields", () => {
    const engine = engineWith({
      id: "loop",
      version: "1.0.0",
      entry: "a",
      nodes: {
        a: { type: "message", text: "a", next: "b" },
        b: { type: "message", text: "b", next: "a" },
      },
    });
    expect(() => engine.start("loop")).toThrow(EngineError);
  });
});

describe("slot capture and re-asking", () => {
  it("captures a string slot and advances", () => {
    const engine = engineWith(
      promptFlow({
        type: "prompt",
        text: "what?",
        slot: { name: "answer", type: "string" },
        next: "done",
      }),
    );
    const { state } = engine.start("t");
    const result = engine.resume(state, { type: "user", text: "  blue  " });
    expect(result.state.slots["answer"]).toBe("blue");
    expect(result.effects).toContainEqual({ type: "message", text: "got blue" });
    expect(result.state.status).toBe("done");
  });

  it("parses number slots into real numbers", () => {
    const engine = engineWith(
      promptFlow({
        type: "prompt",
        text: "how many?",
        slot: { name: "answer", type: "number" },
        next: "done",
      }),
    );
    const { state } = engine.start("t");
    const result = engine.resume(state, { type: "user", text: "42" });
    expect(result.state.slots["answer"]).toBe(42);
  });

  it("re-asks on invalid input using retry_text and counts attempts", () => {
    const engine = engineWith(
      promptFlow({
        type: "prompt",
        text: "how many?",
        retry_text: "a number, please",
        slot: { name: "answer", type: "number" },
        next: "done",
      }),
    );
    const { state } = engine.start("t");
    const result = engine.resume(state, { type: "user", text: "lots" });
    expect(result.effects).toEqual([{ type: "message", text: "a number, please" }]);
    expect(result.state.status).toBe("awaiting_input");
    expect(result.state.attempts).toBe(1);
    expect(result.state.slots["answer"]).toBeUndefined();
  });

  it("matches choice slots case-insensitively and stores the canonical option", () => {
    const engine = engineWith(
      promptFlow({
        type: "prompt",
        text: "pick",
        slot: { name: "answer", type: "choice", options: ["Refund", "Status"] },
        next: "done",
      }),
    );
    const { state } = engine.start("t");
    const result = engine.resume(state, { type: "user", text: " reFUND " });
    expect(result.state.slots["answer"]).toBe("Refund");
  });

  it("validates regex slots", () => {
    const engine = engineWith(
      promptFlow({
        type: "prompt",
        text: "order id?",
        slot: { name: "answer", type: "regex", pattern: "^ORD-\\d+$" },
        next: "done",
      }),
    );
    const { state } = engine.start("t");
    const bad = engine.resume(state, { type: "user", text: "1234" });
    expect(bad.state.status).toBe("awaiting_input");
    const good = engine.resume(bad.state, { type: "user", text: "ORD-1234" });
    expect(good.state.slots["answer"]).toBe("ORD-1234");
  });

  it("routes to on_exhausted after max_attempts invalid answers", () => {
    const engine = engineWith(
      promptFlow(
        {
          type: "prompt",
          text: "how many?",
          slot: { name: "answer", type: "number" },
          max_attempts: 2,
          on_exhausted: "give_up",
          next: "done",
        },
        { give_up: { type: "handoff", reason: "stuck" } },
      ),
    );
    let { state } = engine.start("t");
    ({ state } = engine.resume(state, { type: "user", text: "nope" }));
    expect(state.status).toBe("awaiting_input");
    const final = engine.resume(state, { type: "user", text: "still nope" });
    expect(final.effects).toContainEqual({ type: "handoff", reason: "stuck" });
    expect(final.state.status).toBe("done");
  });
});

describe("branch conditions", () => {
  const state = { slots: { name: "alice", n: 7, tags: ["vip"] }, context: { deep: { x: "ab" } } };

  it("evaluates the operator truth table", () => {
    expect(evalCondition({ slot: "name", op: "eq", value: "alice" }, state)).toBe(true);
    expect(evalCondition({ slot: "name", op: "eq", value: "bob" }, state)).toBe(false);
    expect(evalCondition({ slot: "n", op: "gt", value: 5 }, state)).toBe(true);
    expect(evalCondition({ slot: "n", op: "gt", value: 7 }, state)).toBe(false);
    expect(evalCondition({ slot: "name", op: "gt", value: 5 }, state)).toBe(false);
    expect(evalCondition({ slot: "name", op: "contains", value: "lic" }, state)).toBe(true);
    expect(evalCondition({ slot: "tags", op: "contains", value: "vip" }, state)).toBe(true);
    expect(evalCondition({ slot: "tags", op: "contains", value: "none" }, state)).toBe(false);
    expect(evalCondition({ slot: "name", op: "regex", value: "^a.*e$" }, state)).toBe(true);
    expect(evalCondition({ slot: "name", op: "regex", value: "^z" }, state)).toBe(false);
    expect(evalCondition({ slot: "deep.x", op: "eq", value: "ab" }, state)).toBe(true);
    expect(evalCondition({ slot: "missing", op: "eq", value: "x" }, state)).toBe(false);
  });

  it("takes the else edge when no case matches", () => {
    const engine = engineWith({
      id: "t",
      version: "1.0.0",
      entry: "ask",
      nodes: {
        ask: { type: "prompt", text: "?", slot: { name: "x", type: "string" }, next: "b" },
        b: {
          type: "branch",
          cases: [{ when: { slot: "x", op: "eq", value: "match" }, next: "yes" }],
          else: "no",
        },
        yes: { type: "message", text: "matched", next: "end" },
        no: { type: "message", text: "fell through", next: "end" },
        end: { type: "end" },
      },
    });
    const { state } = engine.start("t");
    const result = engine.resume(state, { type: "user", text: "other" });
    expect(result.effects).toContainEqual({ type: "message", text: "fell through" });
  });

  it("throws when no case matches and there is no else", () => {
    const engine = engineWith({
      id: "t",
      version: "1.0.0",
      entry: "ask",
      nodes: {
        ask: { type: "prompt", text: "?", slot: { name: "x", type: "string" }, next: "b" },
        b: {
          type: "branch",
          cases: [{ when: { slot: "x", op: "eq", value: "match" }, next: "end" }],
        },
        end: { type: "end" },
      },
    });
    const { state } = engine.start("t");
    expect(() => engine.resume(state, { type: "user", text: "other" })).toThrow(EngineError);
  });
});

const actionFlow: Flow = {
  id: "act",
  version: "1.0.0",
  entry: "ask",
  nodes: {
    ask: { type: "prompt", text: "id?", slot: { name: "order_id", type: "string" }, next: "look" },
    look: {
      type: "action",
      handler: "lookup",
      input: { id: "order_id" },
      output: "order",
      timeout_ms: 100,
      on_error: "oops",
      next: "report",
    },
    report: { type: "message", text: "status: {{order.status}}", next: "end" },
    oops: { type: "handoff", reason: "backend error: {{last_error}}" },
    end: { type: "end" },
  },
};

describe("two-phase action lifecycle", () => {
  it("emits run_action with resolved input and parks in awaiting_action", () => {
    const engine = engineWith(actionFlow);
    let { state } = engine.start("act");
    const result = engine.resume(state, { type: "user", text: "ORD-9" });
    expect(result.effects).toEqual([
      { type: "run_action", node: "look", handler: "lookup", input: { id: "ORD-9" }, timeout_ms: 100 },
    ]);
    expect(result.state.status).toBe("awaiting_action");
  });

  it("consumes a successful result, writes context, and continues", () => {
    const engine = engineWith(actionFlow);
    let { state } = engine.start("act");
    ({ state } = engine.resume(state, { type: "user", text: "ORD-9" }));
    const result = engine.resume(state, {
      type: "action_result",
      ok: true,
      value: { status: "shipped" },
    });
    expect(result.effects).toEqual([{ type: "message", text: "status: shipped" }, { type: "end" }]);
    expect(result.state.status).toBe("done");
    expect(result.state.context["order"]).toEqual({ status: "shipped" });
  });

  it("routes failures to on_error and exposes last_error", () => {
    const engine = engineWith(actionFlow);
    let { state } = engine.start("act");
    ({ state } = engine.resume(state, { type: "user", text: "ORD-9" }));
    const result = engine.resume(state, { type: "action_result", ok: false, error: "boom" });
    expect(result.effects).toEqual([{ type: "handoff", reason: "backend error: boom" }]);
  });

  it("throws when an action fails with no on_error edge", () => {
    const flow = structuredClone(actionFlow);
    delete (flow.nodes["look"] as { on_error?: string }).on_error;
    const engine = engineWith(flow);
    let { state } = engine.start("act");
    ({ state } = engine.resume(state, { type: "user", text: "ORD-9" }));
    expect(() => engine.resume(state, { type: "action_result", ok: false, error: "boom" })).toThrow(
      EngineError,
    );
  });

  it("rejects user input while awaiting an action result", () => {
    const engine = engineWith(actionFlow);
    let { state } = engine.start("act");
    ({ state } = engine.resume(state, { type: "user", text: "ORD-9" }));
    expect(() => engine.resume(state, { type: "user", text: "hello?" })).toThrow(EngineError);
  });
});

describe("runAction host helper", () => {
  const effect: RunActionEffect = {
    type: "run_action",
    node: "n",
    handler: "h",
    input: { a: 1 },
    timeout_ms: 20,
  };

  it("returns ok results from the handler", async () => {
    const result = await runAction({ h: async (input) => ({ echoed: input["a"] }) }, effect);
    expect(result).toEqual({ type: "action_result", ok: true, value: { echoed: 1 } });
  });

  it("converts handler exceptions into failed results", async () => {
    const result = await runAction(
      {
        h: async () => {
          throw new Error("nope");
        },
      },
      effect,
    );
    expect(result).toEqual({ type: "action_result", ok: false, error: "nope" });
  });

  it("enforces the declared timeout", async () => {
    const result = await runAction(
      { h: () => new Promise((resolve) => setTimeout(resolve, 200)) },
      effect,
    );
    expect(result.type).toBe("action_result");
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("timed out") });
  });

  it("fails cleanly when no handler is registered", async () => {
    const result = await runAction({}, effect);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("no handler") });
  });
});

describe("determinism and serialization", () => {
  it("same state + same input produce identical results, without mutating the input state", () => {
    const engine = engineWith(actionFlow);
    const { state } = engine.start("act");
    const snapshot = JSON.stringify(state);
    const a = engine.resume(state, { type: "user", text: "ORD-9" });
    const b = engine.resume(state, { type: "user", text: "ORD-9" });
    expect(a).toEqual(b);
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it("survives a JSON round-trip mid-conversation", () => {
    const engine = engineWith(actionFlow);
    let { state } = engine.start("act");
    ({ state } = engine.resume(state, { type: "user", text: "ORD-9" }));
    const revived = JSON.parse(JSON.stringify(state)) as ConversationState;
    const fromRevived = engine.resume(revived, {
      type: "action_result",
      ok: true,
      value: { status: "shipped" },
    });
    const fromOriginal = engine.resume(state, {
      type: "action_result",
      ok: true,
      value: { status: "shipped" },
    });
    expect(fromRevived).toEqual(fromOriginal);
  });

  it("round-trips through the InMemoryStateStore", async () => {
    const engine = engineWith(actionFlow);
    const store = new InMemoryStateStore();
    const { state } = engine.start("act");
    await store.save("conv-1", state);
    const loaded = await store.load("conv-1");
    expect(loaded).toEqual(state);
    const result = engine.resume(loaded!, { type: "user", text: "ORD-9" });
    expect(result.state.status).toBe("awaiting_action");
    expect(await store.load("missing")).toBeUndefined();
  });

  it("refuses to resume a finished conversation", () => {
    const engine = engineWith({
      id: "t",
      version: "1.0.0",
      entry: "bye",
      nodes: { bye: { type: "message", text: "bye", next: "end" }, end: { type: "end" } },
    });
    const { state } = engine.start("t");
    expect(state.status).toBe("done");
    expect(() => engine.resume(state, { type: "user", text: "hi" })).toThrow(EngineError);
  });
});

describe("version pinning", () => {
  const v1: Flow = {
    id: "pin",
    version: "1.0.0",
    entry: "ask",
    nodes: {
      ask: { type: "prompt", text: "v1 asks", slot: { name: "x", type: "string" }, next: "say" },
      say: { type: "message", text: "v1 says", next: "end" },
      end: { type: "end" },
    },
  };
  const v2: Flow = structuredClone(v1);
  v2.version = "2.0.0";
  (v2.nodes["say"] as { text: string }).text = "v2 says";

  it("keeps in-flight conversations on their pinned version", () => {
    const engine = engineWith(v1);
    const { state } = engine.start("pin");
    engine.register(v2);
    const result = engine.resume(state, { type: "user", text: "hello" });
    expect(result.effects).toContainEqual({ type: "message", text: "v1 says" });
  });

  it("starts new conversations on the highest registered version", () => {
    const engine = engineWith(v1, v2);
    const { state } = engine.start("pin");
    expect(state.flowVersion).toBe("2.0.0");
    const result = engine.resume(state, { type: "user", text: "hello" });
    expect(result.effects).toContainEqual({ type: "message", text: "v2 says" });
  });

  it("can start on an explicit older version", () => {
    const engine = engineWith(v1, v2);
    const { state } = engine.start("pin", "1.0.0");
    expect(state.flowVersion).toBe("1.0.0");
  });

  it("throws for unregistered flows and versions", () => {
    const engine = engineWith(v1);
    expect(() => engine.start("ghost")).toThrow(EngineError);
    expect(() => engine.start("pin", "9.9.9")).toThrow(EngineError);
  });
});

describe("interpolate", () => {
  it("resolves slots, context, and dot paths; leaves unknown vars intact", () => {
    const state = { slots: { name: "Ada" }, context: { order: { total: 12.5 } } };
    expect(interpolate("hi {{name}}, total {{order.total}}, {{mystery}}", state)).toBe(
      "hi Ada, total 12.5, {{mystery}}",
    );
  });
});
