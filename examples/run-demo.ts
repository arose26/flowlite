/**
 * Demo: two full conversations against examples/order-support.flow.json
 * (a happy-path refund and a high-value escalation), then a live v1 -> v2
 * migration of a conversation suspended mid-flow.
 *
 * Run with: npm run demo
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  Engine,
  diffFlows,
  lintFlow,
  migrate,
  parseFlow,
  runAction,
  simulate,
  validateFlow,
  type ActionHandler,
  type ConversationState,
  type Effect,
  type Flow,
  type RunActionEffect,
  type TranscriptEntry,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const flowPath = [
  join(here, "order-support.flow.json"),
  join(here, "..", "..", "examples", "order-support.flow.json"),
].find(existsSync);
if (!flowPath) throw new Error("order-support.flow.json not found");

// A fake order backend. In a real host these hit your services.
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

function printTranscript(transcript: TranscriptEntry[]): void {
  for (const entry of transcript) {
    if (entry.role === "user") console.log(`you>  ${entry.text}`);
    else if (entry.role === "bot") console.log(`bot>  ${entry.text}`);
    else console.log(`      ${entry.text}`);
  }
}

async function drainPrinting(
  engine: Engine,
  state: ConversationState,
  effects: Effect[],
): Promise<ConversationState> {
  let current = state;
  let pending = effects;
  for (;;) {
    for (const effect of pending) {
      if (effect.type === "message") console.log(`bot>  ${effect.text}`);
      else if (effect.type === "handoff") console.log(`      [handoff: ${effect.reason}]`);
      else if (effect.type === "end") console.log("      [conversation ended]");
    }
    if (current.status !== "awaiting_action") return current;
    const action = pending
      .flatMap((e): RunActionEffect[] => (e.type === "run_action" ? [e] : []))
      .at(-1)!;
    const result = await runAction(handlers, action);
    const ok = result.type === "action_result" && result.ok;
    console.log(`      [action ${action.handler} -> ${ok ? "ok" : "error"}]`);
    const next = engine.resume(current, result);
    current = next.state;
    pending = next.effects;
  }
}

const v1 = parseFlow(JSON.parse(readFileSync(flowPath, "utf8")));
const validation = validateFlow(v1);
const lint = lintFlow(v1);
console.log(
  `Loaded ${v1.id}@${v1.version}: ${Object.keys(v1.nodes).length} nodes, ` +
    `${validation.length} validation issues, ${lint.length} lint warnings`,
);

const engine = new Engine();
engine.register(v1);

console.log("\n=== Conversation 1: happy path (small refund) ===");
const happy = await simulate(
  engine,
  v1.id,
  [{ user: "refund" }, { user: "ORD-1001" }, { user: "yes" }],
  { handlers },
);
printTranscript(happy.transcript);

console.log("\n=== Conversation 2: high-value refund escalates to a human ===");
const escalation = await simulate(engine, v1.id, [{ user: "refund" }, { user: "ORD-2002" }], {
  handlers,
});
printTranscript(escalation.transcript);

console.log("\n=== Live migration: v1 -> v2 mid-conversation ===");
// v2 renames confirm_refund -> refund_confirmation and rewords it.
const v2: Flow = structuredClone(v1);
v2.version = "2.0.0";
const renamed = v2.nodes["confirm_refund"]!;
if (renamed.type === "prompt") {
  renamed.text =
    "[v2] I can refund ${{order.total}} for {{order_id}} right now. Proceed? (yes/no)";
}
v2.nodes["refund_confirmation"] = renamed;
delete v2.nodes["confirm_refund"];
const refundCheck = v2.nodes["refund_check"]!;
if (refundCheck.type === "branch") refundCheck.else = "refund_confirmation";

let { state, effects } = engine.start(v1.id, "1.0.0");
state = await drainPrinting(engine, state, effects);
for (const text of ["refund", "ORD-1001"]) {
  console.log(`you>  ${text}`);
  const result = engine.resume(state, { type: "user", text });
  state = await drainPrinting(engine, result.state, result.effects);
}
console.log(`      (suspended at node "${state.node}" on v${state.flowVersion})`);

engine.register(v2);
const diff = diffFlows(v1, v2);
console.log(`      (diff v1 -> v2: ${JSON.stringify(diff)})`);
state = migrate(state, v1, v2, { nodes: { confirm_refund: "refund_confirmation" } });
console.log(`      (migrated: now at node "${state.node}" on v${state.flowVersion})`);

console.log("you>  yes");
const resumed = engine.resume(state, { type: "user", text: "yes" });
state = await drainPrinting(engine, resumed.state, resumed.effects);
