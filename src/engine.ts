/**
 * The execution engine.
 *
 * The engine is a pure interpreter: given (state, input) it deterministically
 * produces (state', effects). It never performs I/O itself. Anything with a
 * side effect — sending a message, running an action handler, escalating to
 * a human — is returned as an Effect for the host to execute.
 *
 * Actions are two-phase: the engine emits a `run_action` effect and parks the
 * conversation in `awaiting_action`; the host runs the handler (see
 * `runAction`) and feeds the result back via `resume`. Between the two phases
 * the state is plain JSON, so a conversation can be persisted, shipped to
 * another process, and resumed there.
 */
import type { Condition, Flow, Slot } from "./schema.js";

export type Effect =
  | { type: "message"; text: string }
  | {
      type: "run_action";
      node: string;
      handler: string;
      input: Record<string, unknown>;
      timeout_ms?: number;
    }
  | { type: "handoff"; reason: string }
  | { type: "end" };

export type RunActionEffect = Extract<Effect, { type: "run_action" }>;

export type ResumeInput =
  | { type: "user"; text: string }
  | { type: "action_result"; ok: boolean; value?: unknown; error?: string };

/** A suspended parent flow, waiting for a subflow to finish. */
export interface Frame {
  flowId: string;
  flowVersion: string;
  /** Node to continue at when the subflow ends (the subflow node's `next`). */
  node: string;
  slots: Record<string, unknown>;
  context: Record<string, unknown>;
  /** Parent context key -> child slot/context dot path. */
  output?: Record<string, string>;
}

export type ConversationStatus = "running" | "awaiting_input" | "awaiting_action" | "done";

/** Fully serializable: JSON.stringify/parse round-trips are lossless. */
export interface ConversationState {
  flowId: string;
  /** Version pin: the conversation stays on this flow version. */
  flowVersion: string;
  node: string;
  status: ConversationStatus;
  slots: Record<string, unknown>;
  context: Record<string, unknown>;
  stack: Frame[];
  /** Consecutive invalid answers at the current prompt. */
  attempts: number;
}

export interface StepResult {
  state: ConversationState;
  effects: Effect[];
}

export type ActionHandler = (input: Record<string, unknown>) => Promise<unknown>;

export class EngineError extends Error {}

/** Upper bound on node transitions per turn; a turn that hits it is a bug. */
const MAX_HOPS = 1000;

export class Engine {
  private flows = new Map<string, Flow>();

  /** Register a flow version. Multiple versions of one id may coexist. */
  register(flow: Flow): void {
    this.flows.set(`${flow.id}@${flow.version}`, flow);
  }

  /** Exact version if given, otherwise the highest registered version. */
  getFlow(id: string, version?: string): Flow {
    if (version !== undefined) {
      const flow = this.flows.get(`${id}@${version}`);
      if (!flow) throw new EngineError(`flow ${id}@${version} is not registered`);
      return flow;
    }
    let latest: Flow | undefined;
    for (const flow of this.flows.values()) {
      if (flow.id === id && (!latest || compareSemver(flow.version, latest.version) > 0)) {
        latest = flow;
      }
    }
    if (!latest) throw new EngineError(`flow "${id}" is not registered`);
    return latest;
  }

  /** Begin a conversation, pinning it to the resolved flow version. */
  start(flowId: string, version?: string): StepResult {
    const flow = this.getFlow(flowId, version);
    const state: ConversationState = {
      flowId: flow.id,
      flowVersion: flow.version,
      node: flow.entry,
      status: "running",
      slots: {},
      context: {},
      stack: [],
      attempts: 0,
    };
    const effects: Effect[] = [];
    this.advance(state, effects);
    return { state, effects };
  }

  /**
   * Feed one inbound event (user text or an action result) into a suspended
   * conversation. The passed state is not mutated.
   */
  resume(state: ConversationState, input: ResumeInput): StepResult {
    if (state.status === "done") throw new EngineError("conversation is already done");
    const s = structuredClone(state);
    const effects: Effect[] = [];
    const flow = this.getFlow(s.flowId, s.flowVersion);
    const node = flow.nodes[s.node];
    if (!node) {
      throw new EngineError(`current node "${s.node}" not found in ${s.flowId}@${s.flowVersion}`);
    }

    if (s.status === "awaiting_action") {
      if (input.type !== "action_result") {
        throw new EngineError("conversation is awaiting an action_result, not user input");
      }
      if (node.type !== "action") {
        throw new EngineError(`node "${s.node}" is not an action`);
      }
      if (input.ok) {
        if (node.output !== undefined) s.context[node.output] = structuredClone(input.value);
        s.node = node.next;
      } else if (node.on_error) {
        s.context["last_error"] = input.error ?? "action failed";
        s.node = node.on_error;
      } else {
        throw new EngineError(
          `action "${node.handler}" failed with no on_error edge: ${input.error ?? "unknown error"}`,
        );
      }
      s.status = "running";
      this.advance(s, effects);
      return { state: s, effects };
    }

    // awaiting_input
    if (input.type !== "user") {
      throw new EngineError("conversation is awaiting user input, not an action_result");
    }
    if (node.type !== "prompt") {
      throw new EngineError(`node "${s.node}" is not a prompt`);
    }
    const value = captureSlot(node.slot, input.text);
    if (value !== undefined) {
      s.slots[node.slot.name] = value;
      s.attempts = 0;
      s.node = node.next;
      s.status = "running";
      this.advance(s, effects);
    } else {
      s.attempts += 1;
      if (node.max_attempts !== undefined && s.attempts >= node.max_attempts && node.on_exhausted) {
        s.attempts = 0;
        s.node = node.on_exhausted;
        s.status = "running";
        this.advance(s, effects);
      } else {
        effects.push({ type: "message", text: interpolate(node.retry_text ?? node.text, s) });
        s.status = "awaiting_input";
      }
    }
    return { state: s, effects };
  }

  /** Run nodes until the conversation needs outside input or terminates. */
  private advance(state: ConversationState, effects: Effect[]): void {
    for (let hops = 0; hops < MAX_HOPS; hops++) {
      const flow = this.getFlow(state.flowId, state.flowVersion);
      const node = flow.nodes[state.node];
      if (!node) {
        throw new EngineError(`node "${state.node}" not found in ${state.flowId}@${state.flowVersion}`);
      }
      switch (node.type) {
        case "message": {
          effects.push({ type: "message", text: interpolate(node.text, state) });
          state.node = node.next;
          continue;
        }
        case "prompt": {
          effects.push({ type: "message", text: interpolate(node.text, state) });
          state.status = "awaiting_input";
          return;
        }
        case "branch": {
          let target: string | undefined;
          for (const c of node.cases) {
            if (evalCondition(c.when, state)) {
              target = c.next;
              break;
            }
          }
          target ??= node.else;
          if (!target) {
            throw new EngineError(`branch "${state.node}" matched no case and has no else`);
          }
          state.node = target;
          continue;
        }
        case "action": {
          const input: Record<string, unknown> = {};
          for (const [key, ref] of Object.entries(node.input ?? {})) {
            input[key] = resolveRef(ref, state);
          }
          effects.push({
            type: "run_action",
            node: state.node,
            handler: node.handler,
            input,
            ...(node.timeout_ms !== undefined ? { timeout_ms: node.timeout_ms } : {}),
          });
          state.status = "awaiting_action";
          return;
        }
        case "subflow": {
          // Subflows resolve to the latest registered version at entry time,
          // then pin like any conversation.
          const child = this.getFlow(node.flow);
          const childSlots: Record<string, unknown> = {};
          for (const [key, ref] of Object.entries(node.input ?? {})) {
            childSlots[key] = resolveRef(ref, state);
          }
          state.stack.push({
            flowId: state.flowId,
            flowVersion: state.flowVersion,
            node: node.next,
            slots: state.slots,
            context: state.context,
            ...(node.output ? { output: node.output } : {}),
          });
          state.flowId = child.id;
          state.flowVersion = child.version;
          state.node = child.entry;
          state.slots = childSlots;
          state.context = {};
          continue;
        }
        case "handoff": {
          // Terminal even inside a subflow: escalation ends automation.
          effects.push({ type: "handoff", reason: interpolate(node.reason, state) });
          state.status = "done";
          return;
        }
        case "end": {
          const frame = state.stack.pop();
          if (!frame) {
            effects.push({ type: "end" });
            state.status = "done";
            return;
          }
          const child = { slots: state.slots, context: state.context };
          state.flowId = frame.flowId;
          state.flowVersion = frame.flowVersion;
          state.node = frame.node;
          state.slots = frame.slots;
          state.context = frame.context;
          for (const [key, ref] of Object.entries(frame.output ?? {})) {
            state.context[key] = resolveIn(ref, child.slots, child.context);
          }
          continue;
        }
      }
    }
    throw new EngineError(
      `flow did not yield after ${MAX_HOPS} hops (loop with no prompt/action/end?)`,
    );
  }
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i]! !== pb[i]!) return pa[i]! - pb[i]!;
  }
  return 0;
}

function resolveIn(
  path: string,
  slots: Record<string, unknown>,
  context: Record<string, unknown>,
): unknown {
  const [head, ...rest] = path.split(".");
  let current: unknown = head! in slots ? slots[head!] : context[head!];
  for (const part of rest) {
    if (current !== null && typeof current === "object" && part in (current as object)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Resolve a dot path against slots first, then context. */
export function resolveRef(
  path: string,
  state: Pick<ConversationState, "slots" | "context">,
): unknown {
  return resolveIn(path, state.slots, state.context);
}

/** Replace {{var.path}} templates; unknown vars are left as-is (lint catches them). */
export function interpolate(
  text: string,
  state: Pick<ConversationState, "slots" | "context">,
): string {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, path: string) => {
    const value = resolveRef(path, state);
    return value === undefined ? match : String(value);
  });
}

/** Coerce raw user text into a typed slot value; undefined means invalid. */
export function captureSlot(slot: Slot, raw: string): unknown {
  const text = raw.trim();
  switch (slot.type) {
    case "string":
      return text.length > 0 ? text : undefined;
    case "number": {
      if (!text.length) return undefined;
      const n = Number(text);
      return Number.isFinite(n) ? n : undefined;
    }
    case "choice":
      return slot.options!.find((o) => o.toLowerCase() === text.toLowerCase());
    case "regex":
      return new RegExp(slot.pattern!).test(text) ? text : undefined;
  }
}

export function evalCondition(
  cond: Condition,
  state: Pick<ConversationState, "slots" | "context">,
): boolean {
  const value = resolveRef(cond.slot, state);
  switch (cond.op) {
    case "eq":
      return value === cond.value;
    case "gt":
      return typeof value === "number" && typeof cond.value === "number" && value > cond.value;
    case "contains":
      if (Array.isArray(value)) return value.includes(cond.value);
      return typeof value === "string" && value.includes(String(cond.value));
    case "regex":
      return typeof value === "string" && new RegExp(String(cond.value)).test(value);
  }
}

/**
 * Host-side helper for phase two of the action protocol: run the named
 * handler with the effect's input, enforcing the declared timeout, and
 * package the outcome as the ResumeInput the engine expects. Never throws.
 */
export async function runAction(
  handlers: Record<string, ActionHandler>,
  effect: RunActionEffect,
): Promise<ResumeInput> {
  const handler = handlers[effect.handler];
  if (!handler) {
    return { type: "action_result", ok: false, error: `no handler registered for "${effect.handler}"` };
  }
  try {
    const value = await withTimeout(handler(effect.input), effect.timeout_ms);
    return { type: "action_result", ok: true, value };
  } catch (err) {
    return {
      type: "action_result",
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function withTimeout<T>(promise: Promise<T>, ms?: number): Promise<T> {
  if (ms === undefined) return promise;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`action timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Persistence boundary. The engine never touches storage; hosts pick the
 * store. The in-memory implementation serializes on save to prove that
 * every state it holds survives a JSON round-trip.
 */
export interface StateStore {
  load(conversationId: string): Promise<ConversationState | undefined>;
  save(conversationId: string, state: ConversationState): Promise<void>;
}

export class InMemoryStateStore implements StateStore {
  private store = new Map<string, string>();

  async load(conversationId: string): Promise<ConversationState | undefined> {
    const raw = this.store.get(conversationId);
    return raw === undefined ? undefined : (JSON.parse(raw) as ConversationState);
  }

  async save(conversationId: string, state: ConversationState): Promise<void> {
    this.store.set(conversationId, JSON.stringify(state));
  }
}
