import { describe, expect, it } from "vitest";
import { parseFlow, validateFlow, type Flow } from "../src/index.js";

const minimal = (overrides: Partial<Flow> = {}): Flow => ({
  id: "t",
  version: "1.0.0",
  entry: "start",
  nodes: {
    start: { type: "message", text: "hi", next: "end" },
    end: { type: "end" },
  },
  ...overrides,
});

describe("parseFlow (structural validation)", () => {
  it("parses a valid flow", () => {
    const flow = parseFlow(minimal());
    expect(flow.id).toBe("t");
    expect(Object.keys(flow.nodes)).toEqual(["start", "end"]);
  });

  it("rejects a non-semver version", () => {
    expect(() => parseFlow(minimal({ version: "1.0" as never }))).toThrow();
  });

  it("rejects a choice slot without options", () => {
    expect(() =>
      parseFlow(
        minimal({
          nodes: {
            start: {
              type: "prompt",
              text: "pick",
              slot: { name: "x", type: "choice" },
              next: "end",
            },
            end: { type: "end" },
          } as never,
        }),
      ),
    ).toThrow(/choice/);
  });

  it("rejects a regex slot without a pattern", () => {
    expect(() =>
      parseFlow(
        minimal({
          nodes: {
            start: {
              type: "prompt",
              text: "pick",
              slot: { name: "x", type: "regex" },
              next: "end",
            },
            end: { type: "end" },
          } as never,
        }),
      ),
    ).toThrow(/regex/);
  });

  it("rejects an unknown node type", () => {
    expect(() =>
      parseFlow(minimal({ nodes: { start: { type: "teleport", next: "end" } } as never })),
    ).toThrow();
  });
});

describe("validateFlow (semantic validation)", () => {
  it("accepts a clean flow with zero issues", () => {
    expect(validateFlow(minimal())).toEqual([]);
  });

  it("flags a missing entry node", () => {
    const issues = validateFlow(minimal({ entry: "nope" }));
    expect(issues.some((i) => i.code === "missing-entry")).toBe(true);
  });

  it("flags dangling edges from next, branch cases, and on_error", () => {
    const flow: Flow = {
      id: "t",
      version: "1.0.0",
      entry: "a",
      nodes: {
        a: { type: "message", text: "hi", next: "ghost1" },
        b: {
          type: "branch",
          cases: [{ when: { slot: "x", op: "eq", value: 1 }, next: "ghost2" }],
          else: "c",
        },
        c: { type: "action", handler: "h", on_error: "ghost3", next: "end" },
        end: { type: "end" },
      },
    };
    const dangling = validateFlow(flow).filter((i) => i.code === "dangling-edge");
    expect(dangling.map((i) => i.node).sort()).toEqual(["a", "b", "c"]);
  });

  it("flags unreachable nodes", () => {
    const flow = minimal();
    flow.nodes["island"] = { type: "message", text: "lost", next: "end" };
    const issues = validateFlow(flow);
    expect(issues).toEqual([
      expect.objectContaining({ code: "unreachable-node", node: "island" }),
    ]);
  });

  it("flags gt conditions on a string slot", () => {
    const flow: Flow = {
      id: "t",
      version: "1.0.0",
      entry: "ask",
      nodes: {
        ask: {
          type: "prompt",
          text: "name?",
          slot: { name: "name", type: "string" },
          next: "check",
        },
        check: {
          type: "branch",
          cases: [{ when: { slot: "name", op: "gt", value: 5 }, next: "end" }],
          else: "end",
        },
        end: { type: "end" },
      },
    };
    const issues = validateFlow(flow);
    expect(issues.some((i) => i.code === "condition-type" && /gt/.test(i.message))).toBe(true);
  });

  it("flags gt conditions with a non-numeric value", () => {
    const flow: Flow = {
      id: "t",
      version: "1.0.0",
      entry: "check",
      nodes: {
        check: {
          type: "branch",
          cases: [{ when: { slot: "anything", op: "gt", value: "big" }, next: "end" }],
          else: "end",
        },
        end: { type: "end" },
      },
    };
    expect(validateFlow(flow).some((i) => i.code === "condition-type")).toBe(true);
  });

  it("flags regex conditions on a number slot", () => {
    const flow: Flow = {
      id: "t",
      version: "1.0.0",
      entry: "ask",
      nodes: {
        ask: {
          type: "prompt",
          text: "age?",
          slot: { name: "age", type: "number" },
          next: "check",
        },
        check: {
          type: "branch",
          cases: [{ when: { slot: "age", op: "regex", value: "^4" }, next: "end" }],
          else: "end",
        },
        end: { type: "end" },
      },
    };
    expect(validateFlow(flow).some((i) => i.code === "condition-type")).toBe(true);
  });

  it("flags a subflow cycle across flows", () => {
    const a: Flow = {
      id: "a",
      version: "1.0.0",
      entry: "s",
      nodes: { s: { type: "subflow", flow: "b", next: "end" }, end: { type: "end" } },
    };
    const b: Flow = {
      id: "b",
      version: "1.0.0",
      entry: "s",
      nodes: { s: { type: "subflow", flow: "a", next: "end" }, end: { type: "end" } },
    };
    const issues = validateFlow(a, [b]);
    expect(issues.some((i) => i.code === "subflow-cycle")).toBe(true);
  });

  it("flags a self-referencing subflow even without a registry", () => {
    const a: Flow = {
      id: "a",
      version: "1.0.0",
      entry: "s",
      nodes: { s: { type: "subflow", flow: "a", next: "end" }, end: { type: "end" } },
    };
    expect(validateFlow(a).some((i) => i.code === "subflow-cycle")).toBe(true);
  });

  it("flags references to unknown subflows", () => {
    const a: Flow = {
      id: "a",
      version: "1.0.0",
      entry: "s",
      nodes: { s: { type: "subflow", flow: "missing", next: "end" }, end: { type: "end" } },
    };
    const other: Flow = minimal({ id: "other" });
    expect(validateFlow(a, [other]).some((i) => i.code === "unknown-subflow")).toBe(true);
  });
});
