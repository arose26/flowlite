/**
 * Test harness for flows: scripted conversations with assertions, and a
 * property-style path walker that proves every reachable path terminates.
 */
import {
  Engine,
  runAction,
  type ActionHandler,
  type ConversationState,
  type Effect,
  type RunActionEffect,
} from "./engine.js";
import type { Flow } from "./schema.js";
import { edgesOf } from "./schema.js";

export interface ScriptStep {
  user: string;
  expect?: {
    /** Each entry must be a substring of some message emitted this turn. */
    messages?: string[];
    /** Slot values compared structurally after the turn. */
    slots?: Record<string, unknown>;
    node?: string;
    status?: ConversationState["status"];
  };
}

export interface TranscriptEntry {
  role: "user" | "bot" | "system";
  text: string;
}

export interface SimulationResult {
  transcript: TranscriptEntry[];
  /** Human-readable assertion failures; empty means the script passed. */
  failures: string[];
  state: ConversationState;
}

/**
 * Run a scripted conversation against a flow. Action effects are executed
 * with the supplied handlers (via `runAction`) and fed back automatically,
 * so a script only contains what a real user would type.
 */
export async function simulate(
  engine: Engine,
  flowId: string,
  script: ScriptStep[],
  opts: { handlers?: Record<string, ActionHandler>; version?: string } = {},
): Promise<SimulationResult> {
  const transcript: TranscriptEntry[] = [];
  const failures: string[] = [];
  const handlers = opts.handlers ?? {};

  const started = engine.start(flowId, opts.version);
  let { state } = await drain(engine, started.state, started.effects, handlers, transcript);

  for (let i = 0; i < script.length; i++) {
    const step = script[i]!;
    if (state.status === "done") {
      failures.push(`step ${i}: conversation already ended before input "${step.user}"`);
      break;
    }
    transcript.push({ role: "user", text: step.user });
    const result = engine.resume(state, { type: "user", text: step.user });
    const drained = await drain(engine, result.state, result.effects, handlers, transcript);
    state = drained.state;
    checkExpectations(i, step, drained.turnEffects, state, failures);
  }

  return { transcript, failures, state };
}

/** Execute pending action effects until the conversation needs a user or ends. */
async function drain(
  engine: Engine,
  state: ConversationState,
  effects: Effect[],
  handlers: Record<string, ActionHandler>,
  transcript: TranscriptEntry[],
): Promise<{ state: ConversationState; turnEffects: Effect[] }> {
  const turnEffects: Effect[] = [];
  let current = state;
  let pending = effects;
  for (let guard = 0; ; guard++) {
    if (guard > 25) throw new Error("simulate: more than 25 chained actions in one turn");
    turnEffects.push(...pending);
    for (const effect of pending) {
      if (effect.type === "message") transcript.push({ role: "bot", text: effect.text });
      if (effect.type === "handoff") {
        transcript.push({ role: "system", text: `[handoff: ${effect.reason}]` });
      }
      if (effect.type === "end") transcript.push({ role: "system", text: "[conversation ended]" });
    }
    if (current.status !== "awaiting_action") return { state: current, turnEffects };

    const action = pending
      .flatMap((e): RunActionEffect[] => (e.type === "run_action" ? [e] : []))
      .at(-1);
    if (!action) throw new Error("simulate: awaiting_action with no run_action effect");
    const actionResult = await runAction(handlers, action);
    const ok = actionResult.type === "action_result" && actionResult.ok;
    transcript.push({
      role: "system",
      text: ok
        ? `[action ${action.handler} -> ok]`
        : `[action ${action.handler} -> error: ${actionResult.type === "action_result" ? actionResult.error : "?"}]`,
    });
    const next = engine.resume(current, actionResult);
    current = next.state;
    pending = next.effects;
  }
}

function checkExpectations(
  stepIndex: number,
  step: ScriptStep,
  effects: Effect[],
  state: ConversationState,
  failures: string[],
): void {
  const expect = step.expect;
  if (!expect) return;
  const messages = effects.flatMap((e) => (e.type === "message" ? [e.text] : []));
  for (const wanted of expect.messages ?? []) {
    if (!messages.some((m) => m.includes(wanted))) {
      failures.push(
        `step ${stepIndex}: expected a message containing "${wanted}", got ${JSON.stringify(messages)}`,
      );
    }
  }
  for (const [name, value] of Object.entries(expect.slots ?? {})) {
    if (JSON.stringify(state.slots[name]) !== JSON.stringify(value)) {
      failures.push(
        `step ${stepIndex}: expected slot ${name}=${JSON.stringify(value)}, got ${JSON.stringify(state.slots[name])}`,
      );
    }
  }
  if (expect.node !== undefined && state.node !== expect.node) {
    failures.push(`step ${stepIndex}: expected node "${expect.node}", got "${state.node}"`);
  }
  if (expect.status !== undefined && state.status !== expect.status) {
    failures.push(`step ${stepIndex}: expected status "${expect.status}", got "${state.status}"`);
  }
}

export interface WalkResult {
  ok: boolean;
  pathsExplored: number;
  /** Paths that never reached end/handoff within maxDepth. */
  nonTerminating: string[][];
}

/**
 * Enumerate every reachable path through a flow's edges (including error and
 * exhaustion edges) and assert each one terminates at `end` or `handoff`
 * within `maxDepth` nodes. Catches loops that have no exit.
 */
export function walkAllPaths(
  flow: Flow,
  opts: { maxDepth?: number; maxPaths?: number } = {},
): WalkResult {
  const maxDepth = opts.maxDepth ?? 50;
  const maxPaths = opts.maxPaths ?? 10_000;
  const nonTerminating: string[][] = [];
  let pathsExplored = 0;

  const stack: string[][] = [[flow.entry]];
  while (stack.length && pathsExplored < maxPaths) {
    const path = stack.pop()!;
    const nodeId = path[path.length - 1]!;
    const node = flow.nodes[nodeId];
    if (!node) {
      // Dangling edge: the path cannot terminate properly.
      pathsExplored++;
      nonTerminating.push(path);
      continue;
    }
    if (node.type === "end" || node.type === "handoff") {
      pathsExplored++;
      continue;
    }
    if (path.length >= maxDepth) {
      pathsExplored++;
      nonTerminating.push(path);
      continue;
    }
    for (const target of edgesOf(node)) {
      stack.push([...path, target]);
    }
  }

  return { ok: nonTerminating.length === 0, pathsExplored, nonTerminating };
}
