import { describe, expect, it } from "vitest";
import { Engine, type ConversationState, type Flow } from "../src/index.js";

const child: Flow = {
  id: "verify",
  version: "1.0.0",
  entry: "hello",
  nodes: {
    hello: { type: "message", text: "verifying {{who}}", next: "ask" },
    ask: {
      type: "prompt",
      text: "secret word?",
      slot: { name: "word", type: "string" },
      next: "end",
    },
    end: { type: "end" },
  },
};

const parent: Flow = {
  id: "main",
  version: "1.0.0",
  entry: "ask_name",
  nodes: {
    ask_name: {
      type: "prompt",
      text: "name?",
      slot: { name: "customer", type: "string" },
      next: "call",
    },
    call: {
      type: "subflow",
      flow: "verify",
      input: { who: "customer" },
      output: { verdict: "word" },
      next: "after",
    },
    after: { type: "message", text: "back with {{verdict}}", next: "end" },
    end: { type: "end" },
  },
};

function setup(): Engine {
  const engine = new Engine();
  engine.register(parent);
  engine.register(child);
  return engine;
}

describe("subflows", () => {
  it("maps parent values into child slots on entry", () => {
    const engine = setup();
    const { state } = engine.start("main");
    const result = engine.resume(state, { type: "user", text: "Ada" });
    expect(result.effects).toContainEqual({ type: "message", text: "verifying Ada" });
    expect(result.state.flowId).toBe("verify");
    expect(result.state.stack).toHaveLength(1);
    expect(result.state.stack[0]).toMatchObject({ flowId: "main", node: "after" });
  });

  it("maps child results back into parent context on end and continues", () => {
    const engine = setup();
    let { state } = engine.start("main");
    ({ state } = engine.resume(state, { type: "user", text: "Ada" }));
    const result = engine.resume(state, { type: "user", text: "swordfish" });
    expect(result.effects).toContainEqual({ type: "message", text: "back with swordfish" });
    expect(result.state.flowId).toBe("main");
    expect(result.state.stack).toHaveLength(0);
    expect(result.state.context["verdict"]).toBe("swordfish");
    expect(result.state.status).toBe("done");
  });

  it("keeps child scope isolated from parent slots", () => {
    const engine = setup();
    let { state } = engine.start("main");
    ({ state } = engine.resume(state, { type: "user", text: "Ada" }));
    expect(state.slots).toEqual({ who: "Ada" });
    expect(state.slots["customer"]).toBeUndefined();
  });

  it("supports nested subflows two levels deep", () => {
    const inner: Flow = {
      id: "inner",
      version: "1.0.0",
      entry: "m",
      nodes: { m: { type: "message", text: "deepest", next: "end" }, end: { type: "end" } },
    };
    const middle: Flow = {
      id: "middle",
      version: "1.0.0",
      entry: "call",
      nodes: {
        call: { type: "subflow", flow: "inner", next: "m" },
        m: { type: "message", text: "middle done", next: "end" },
        end: { type: "end" },
      },
    };
    const outer: Flow = {
      id: "outer",
      version: "1.0.0",
      entry: "call",
      nodes: {
        call: { type: "subflow", flow: "middle", next: "m" },
        m: { type: "message", text: "outer done", next: "end" },
        end: { type: "end" },
      },
    };
    const engine = new Engine();
    engine.register(inner);
    engine.register(middle);
    engine.register(outer);
    const { state, effects } = engine.start("outer");
    expect(effects.flatMap((e) => (e.type === "message" ? [e.text] : []))).toEqual([
      "deepest",
      "middle done",
      "outer done",
    ]);
    expect(state.status).toBe("done");
    expect(state.stack).toHaveLength(0);
  });

  it("treats a handoff inside a child as terminal for the whole conversation", () => {
    const angry: Flow = {
      id: "angry",
      version: "1.0.0",
      entry: "h",
      nodes: { h: { type: "handoff", reason: "child escalated" } },
    };
    const caller: Flow = {
      id: "caller",
      version: "1.0.0",
      entry: "call",
      nodes: {
        call: { type: "subflow", flow: "angry", next: "never" },
        never: { type: "message", text: "unreachable", next: "end" },
        end: { type: "end" },
      },
    };
    const engine = new Engine();
    engine.register(angry);
    engine.register(caller);
    const { state, effects } = engine.start("caller");
    expect(effects).toContainEqual({ type: "handoff", reason: "child escalated" });
    expect(state.status).toBe("done");
  });

  it("survives a JSON round-trip while suspended inside a subflow", () => {
    const engine = setup();
    let { state } = engine.start("main");
    ({ state } = engine.resume(state, { type: "user", text: "Ada" }));
    const revived = JSON.parse(JSON.stringify(state)) as ConversationState;
    const result = engine.resume(revived, { type: "user", text: "swordfish" });
    expect(result.state.context["verdict"]).toBe("swordfish");
  });
});
