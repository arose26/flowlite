import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  Engine,
  diffFlows,
  lintFlow,
  migrate,
  parseFlow,
  simulate,
  validateFlow,
  walkAllPaths,
  type ActionHandler,
  type Flow,
} from "../src/index.js";

const flowJson = readFileSync(
  fileURLToPath(new URL("../examples/order-support.flow.json", import.meta.url)),
  "utf8",
);

const orders: Record<string, { status: string; total: number }> = {
  "ORD-1001": { status: "shipped", total: 49.99 },
  "ORD-2002": { status: "processing", total: 899 },
};
const handlers: Record<string, ActionHandler> = {
  lookupOrder: async (input) => {
    const order = orders[String(input["order_id"])];
    if (!order) throw new Error(`order ${input["order_id"]} not found`);
    return order;
  },
  issueRefund: async (input) => ({ id: "RF-7301", amount: input["amount"] }),
};

function load(): Flow {
  return parseFlow(JSON.parse(flowJson));
}

describe("examples/order-support.flow.json", () => {
  it("passes schema validation and lints clean", () => {
    const flow = load();
    expect(validateFlow(flow)).toEqual([]);
    expect(lintFlow(flow)).toEqual([]);
  });

  it("terminates on every reachable path", () => {
    const result = walkAllPaths(load());
    expect(result.ok).toBe(true);
    expect(result.pathsExplored).toBeGreaterThanOrEqual(8);
  });

  it("handles the happy-path refund end to end", async () => {
    const engine = new Engine();
    engine.register(load());
    const result = await simulate(
      engine,
      "order-support",
      [
        { user: "refund", expect: { slots: { intent: "refund" } } },
        { user: "ORD-1001", expect: { messages: ["refund $49.99"] } },
        { user: "yes", expect: { messages: ["Refund RF-7301", "Have a great day"], status: "done" } },
      ],
      { handlers },
    );
    expect(result.failures).toEqual([]);
  });

  it("escalates high-value refunds to a human", async () => {
    const engine = new Engine();
    engine.register(load());
    const result = await simulate(
      engine,
      "order-support",
      [{ user: "refund" }, { user: "ORD-2002" }],
      { handlers },
    );
    expect(result.failures).toEqual([]);
    expect(result.state.status).toBe("done");
    const handoff = result.transcript.find((t) => t.text.includes("[handoff"));
    expect(handoff?.text).toContain("needs human approval");
    expect(handoff?.text).toContain("ORD-2002");
  });

  it("escalates after repeated invalid input", async () => {
    const engine = new Engine();
    engine.register(load());
    const result = await simulate(
      engine,
      "order-support",
      [{ user: "banana" }, { user: "still banana" }],
      { handlers },
    );
    expect(result.state.status).toBe("done");
    expect(result.transcript.some((t) => t.text.includes("customer may be stuck"))).toBe(true);
  });

  it("answers order-status queries via the lookup action", async () => {
    const engine = new Engine();
    engine.register(load());
    const result = await simulate(
      engine,
      "order-support",
      [
        { user: "order status" },
        { user: "ORD-2002", expect: { messages: ["currently: processing"], status: "done" } },
      ],
      { handlers },
    );
    expect(result.failures).toEqual([]);
  });

  it("hands off when the backend errors", async () => {
    const engine = new Engine();
    engine.register(load());
    const result = await simulate(
      engine,
      "order-support",
      [{ user: "refund" }, { user: "ORD-9999" }],
      { handlers },
    );
    expect(result.transcript.some((t) => t.text.includes("backend error: order ORD-9999 not found"))).toBe(
      true,
    );
  });

  it("migrates a suspended conversation from v1 to v2 and completes on v2", async () => {
    const v1 = load();
    const v2: Flow = structuredClone(v1);
    v2.version = "2.0.0";
    v2.nodes["refund_confirmation"] = v2.nodes["confirm_refund"]!;
    delete v2.nodes["confirm_refund"];
    const refundCheck = v2.nodes["refund_check"]!;
    if (refundCheck.type === "branch") refundCheck.else = "refund_confirmation";

    expect(diffFlows(v1, v2)).toEqual({
      added: ["refund_confirmation"],
      removed: ["confirm_refund"],
      changed: ["refund_check"],
    });

    const engine = new Engine();
    engine.register(v1);
    // Drive to the confirmation prompt on v1.
    let { state } = engine.start("order-support", "1.0.0");
    ({ state } = engine.resume(state, { type: "user", text: "refund" }));
    ({ state } = engine.resume(state, { type: "user", text: "ORD-1001" }));
    // The lookup action is pending; feed its result manually.
    ({ state } = engine.resume(state, {
      type: "action_result",
      ok: true,
      value: orders["ORD-1001"],
    }));
    expect(state.node).toBe("confirm_refund");
    expect(state.flowVersion).toBe("1.0.0");

    engine.register(v2);
    const migrated = migrate(state, v1, v2, { nodes: { confirm_refund: "refund_confirmation" } });
    expect(migrated.node).toBe("refund_confirmation");
    expect(migrated.flowVersion).toBe("2.0.0");

    let result = engine.resume(migrated, { type: "user", text: "yes" });
    result = engine.resume(result.state, {
      type: "action_result",
      ok: true,
      value: { id: "RF-1", amount: 49.99 },
    });
    expect(result.effects.some((e) => e.type === "message" && e.text.includes("Refund RF-1"))).toBe(
      true,
    );
    expect(result.state.status).toBe("done");
  });
});
