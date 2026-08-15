import { describe, expect, it } from "vitest";
import {
  Engine,
  MigrationError,
  canMigrate,
  diffFlows,
  migrate,
  type Flow,
} from "../src/index.js";

const v1: Flow = {
  id: "f",
  version: "1.0.0",
  entry: "ask",
  nodes: {
    ask: { type: "prompt", text: "amount?", slot: { name: "amount", type: "number" }, next: "confirm" },
    confirm: {
      type: "prompt",
      text: "sure? (yes/no)",
      slot: { name: "sure", type: "choice", options: ["yes", "no"] },
      next: "say",
    },
    say: { type: "message", text: "ok: {{amount}}", next: "end" },
    end: { type: "end" },
  },
};

// v2: renames "confirm" -> "double_check", rewords "say", adds "audit".
const v2: Flow = {
  id: "f",
  version: "2.0.0",
  entry: "ask",
  nodes: {
    ask: v1.nodes["ask"]!,
    double_check: {
      type: "prompt",
      text: "really sure? (yes/no)",
      slot: { name: "sure", type: "choice", options: ["yes", "no"] },
      next: "say",
    },
    say: { type: "message", text: "confirmed: {{amount}}", next: "end" },
    audit: { type: "message", text: "audited", next: "end" },
    end: { type: "end" },
  },
};

describe("diffFlows", () => {
  it("reports added, removed, and changed nodes", () => {
    expect(diffFlows(v1, v2)).toEqual({
      added: ["double_check", "audit"],
      removed: ["confirm"],
      changed: ["say"],
    });
  });

  it("reports an empty diff for identical flows", () => {
    expect(diffFlows(v1, structuredClone(v1))).toEqual({ added: [], removed: [], changed: [] });
  });
});

describe("canMigrate / migrate", () => {
  function suspendedAtConfirm() {
    const engine = new Engine();
    engine.register(v1);
    let { state } = engine.start("f");
    ({ state } = engine.resume(state, { type: "user", text: "50" }));
    expect(state.node).toBe("confirm");
    return { engine, state };
  }

  it("flags a conversation parked on a removed node with no mapping", () => {
    const { state } = suspendedAtConfirm();
    const issues = canMigrate(state, v1, v2);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.node).toBe("confirm");
  });

  it("throws MigrationError for impossible migrations", () => {
    const { state } = suspendedAtConfirm();
    expect(() => migrate(state, v1, v2)).toThrow(MigrationError);
  });

  it("migrates with a node rename and slot transform, then resumes on v2", () => {
    const { engine, state } = suspendedAtConfirm();
    engine.register(v2);
    const migrated = migrate(state, v1, v2, {
      nodes: { confirm: "double_check" },
      slots: { amount: (v) => (v as number) * 2 },
    });
    expect(migrated.flowVersion).toBe("2.0.0");
    expect(migrated.node).toBe("double_check");
    expect(migrated.slots["amount"]).toBe(100);
    // Original state is untouched.
    expect(state.flowVersion).toBe("1.0.0");
    expect(state.slots["amount"]).toBe(50);

    const result = engine.resume(migrated, { type: "user", text: "yes" });
    expect(result.effects).toContainEqual({ type: "message", text: "confirmed: 100" });
    expect(result.state.status).toBe("done");
  });

  it("flags conversations that are not pinned to the source flow", () => {
    const other = structuredClone(v1);
    other.id = "different";
    const engine = new Engine();
    engine.register(other);
    const { state } = engine.start("different");
    const issues = canMigrate(state, v1, v2);
    expect(issues.some((i) => /not pinned/.test(i.message))).toBe(true);
  });

  it("remaps stacked return nodes when a parent flow migrates", () => {
    const childFlow: Flow = {
      id: "child",
      version: "1.0.0",
      entry: "ask",
      nodes: {
        ask: { type: "prompt", text: "?", slot: { name: "x", type: "string" }, next: "end" },
        end: { type: "end" },
      },
    };
    const parentV1: Flow = {
      id: "parent",
      version: "1.0.0",
      entry: "call",
      nodes: {
        call: { type: "subflow", flow: "child", next: "landing" },
        landing: { type: "message", text: "back", next: "end" },
        end: { type: "end" },
      },
    };
    const parentV2: Flow = {
      id: "parent",
      version: "2.0.0",
      entry: "call",
      nodes: {
        call: { type: "subflow", flow: "child", next: "landing_v2" },
        landing_v2: { type: "message", text: "back in v2", next: "end" },
        end: { type: "end" },
      },
    };
    const engine = new Engine();
    engine.register(childFlow);
    engine.register(parentV1);
    // Suspended inside the child; the parent frame points at "landing".
    const { state } = engine.start("parent");
    expect(state.stack[0]!.node).toBe("landing");

    engine.register(parentV2);
    const migrated = migrate(state, parentV1, parentV2, { nodes: { landing: "landing_v2" } });
    expect(migrated.stack[0]!.node).toBe("landing_v2");
    expect(migrated.stack[0]!.flowVersion).toBe("2.0.0");

    const result = engine.resume(migrated, { type: "user", text: "done" });
    expect(result.effects).toContainEqual({ type: "message", text: "back in v2" });
  });
});
