import { describe, expect, it } from "vitest";
import { lintFlow, type Flow } from "../src/index.js";

const cleanFlow: Flow = {
  id: "clean",
  version: "1.0.0",
  entry: "ask",
  nodes: {
    ask: {
      type: "prompt",
      text: "pick (a/b)",
      slot: { name: "pick", type: "choice", options: ["a", "b"] },
      max_attempts: 2,
      on_exhausted: "help",
      next: "route",
    },
    route: {
      type: "branch",
      cases: [{ when: { slot: "pick", op: "eq", value: "a" }, next: "act" }],
      else: "bye",
    },
    act: { type: "action", handler: "h", output: "result", on_error: "help", next: "say" },
    say: { type: "message", text: "you picked {{pick}}, got {{result.value}}", next: "bye" },
    bye: { type: "message", text: "bye", next: "end" },
    help: { type: "handoff", reason: "needs a human" },
    end: { type: "end" },
  },
};

describe("lintFlow", () => {
  it("passes a clean flow with zero issues", () => {
    expect(lintFlow(cleanFlow)).toEqual([]);
  });

  it("flags prompts without a re-ask limit", () => {
    const flow = structuredClone(cleanFlow);
    delete (flow.nodes["ask"] as { max_attempts?: number }).max_attempts;
    const issues = lintFlow(flow);
    expect(issues).toEqual([expect.objectContaining({ rule: "prompt-reask-limit", node: "ask" })]);
  });

  it("flags branches without an else", () => {
    const flow = structuredClone(cleanFlow);
    delete (flow.nodes["route"] as { else?: string }).else;
    const issues = lintFlow(flow);
    expect(issues.some((i) => i.rule === "branch-else" && i.node === "route")).toBe(true);
  });

  it("flags actions without an on_error edge", () => {
    const flow = structuredClone(cleanFlow);
    delete (flow.nodes["act"] as { on_error?: string }).on_error;
    const issues = lintFlow(flow);
    expect(issues).toEqual([expect.objectContaining({ rule: "action-on-error", node: "act" })]);
  });

  it("flags flows with no reachable path to a human", () => {
    const flow: Flow = {
      id: "nohuman",
      version: "1.0.0",
      entry: "say",
      nodes: {
        say: { type: "message", text: "all bots here", next: "end" },
        end: { type: "end" },
      },
    };
    const issues = lintFlow(flow);
    expect(issues).toEqual([expect.objectContaining({ rule: "handoff-reachable" })]);
  });

  it("flags template vars with no source", () => {
    const flow = structuredClone(cleanFlow);
    (flow.nodes["say"] as { text: string }).text = "hello {{nonexistent.thing}}";
    const issues = lintFlow(flow);
    expect(issues).toEqual([
      expect.objectContaining({
        rule: "template-var",
        node: "say",
        message: expect.stringContaining("nonexistent"),
      }),
    ]);
  });

  it("accepts last_error as an engine-provided template source", () => {
    const flow = structuredClone(cleanFlow);
    (flow.nodes["help"] as { reason: string }).reason = "failed: {{last_error}}";
    expect(lintFlow(flow)).toEqual([]);
  });
});
