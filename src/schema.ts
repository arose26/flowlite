/**
 * The flow definition language.
 *
 * A flow is plain JSON: an id, a semver version, an entry node, and a map of
 * named nodes. Zod gives us structural validation; `validateFlow` layers the
 * semantic checks a schema alone cannot express (reachability, dangling
 * edges, condition/slot type agreement, subflow cycles).
 */
import { z } from "zod";

const nodeId = z.string().min(1);
const semver = z.string().regex(/^\d+\.\d+\.\d+$/, "version must be semver (x.y.z)");

/** A typed slot captured by a prompt node. */
export const SlotSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum(["string", "number", "choice", "regex"]),
    /** Required when type is "choice". */
    options: z.array(z.string().min(1)).min(1).optional(),
    /** Required when type is "regex". */
    pattern: z.string().min(1).optional(),
  })
  .refine((s) => s.type !== "choice" || (s.options?.length ?? 0) > 0, {
    message: 'a "choice" slot requires options',
  })
  .refine((s) => s.type !== "regex" || !!s.pattern, {
    message: 'a "regex" slot requires a pattern',
  });

/**
 * A branch condition. `slot` is a dot path resolved against collected slots
 * first, then context (e.g. "intent" or "order.total").
 */
export const ConditionSchema = z.object({
  slot: z.string().min(1),
  op: z.enum(["eq", "gt", "contains", "regex"]),
  value: z.union([z.string(), z.number(), z.boolean()]),
});

const MessageNode = z.object({
  type: z.literal("message"),
  /** Supports {{var}} templates resolved from slots/context. */
  text: z.string().min(1),
  next: nodeId,
});

const PromptNode = z.object({
  type: z.literal("prompt"),
  text: z.string().min(1),
  /** Shown instead of `text` when the previous answer was invalid. */
  retry_text: z.string().optional(),
  slot: SlotSchema,
  /** Invalid answers allowed before taking the on_exhausted edge. */
  max_attempts: z.number().int().positive().optional(),
  on_exhausted: nodeId.optional(),
  next: nodeId,
});

const BranchNode = z.object({
  type: z.literal("branch"),
  cases: z.array(z.object({ when: ConditionSchema, next: nodeId })).min(1),
  else: nodeId.optional(),
});

const ActionNode = z.object({
  type: z.literal("action"),
  /** Name of a host-registered handler. */
  handler: z.string().min(1),
  /** Handler argument name -> slot/context dot path. */
  input: z.record(z.string(), z.string()).optional(),
  /** Context key the handler result is written to. */
  output: z.string().optional(),
  timeout_ms: z.number().int().positive().optional(),
  on_error: nodeId.optional(),
  next: nodeId,
});

const SubflowNode = z.object({
  type: z.literal("subflow"),
  /** Flow id to call. */
  flow: z.string().min(1),
  /** Child slot name -> parent slot/context dot path. */
  input: z.record(z.string(), z.string()).optional(),
  /** Parent context key -> child slot/context dot path. */
  output: z.record(z.string(), z.string()).optional(),
  next: nodeId,
});

/** Terminal: escalate to a human. First-class, on purpose. */
const HandoffNode = z.object({
  type: z.literal("handoff"),
  reason: z.string().min(1),
});

const EndNode = z.object({ type: z.literal("end") });

export const NodeSchema = z.discriminatedUnion("type", [
  MessageNode,
  PromptNode,
  BranchNode,
  ActionNode,
  SubflowNode,
  HandoffNode,
  EndNode,
]);

export const FlowSchema = z.object({
  id: z.string().min(1),
  version: semver,
  entry: nodeId,
  nodes: z.record(z.string(), NodeSchema),
});

export type Slot = z.infer<typeof SlotSchema>;
export type Condition = z.infer<typeof ConditionSchema>;
export type FlowNode = z.infer<typeof NodeSchema>;
export type Flow = z.infer<typeof FlowSchema>;

/** Parse unknown JSON into a Flow, throwing on structural problems. */
export function parseFlow(json: unknown): Flow {
  return FlowSchema.parse(json);
}

export interface ValidationIssue {
  code:
    | "missing-entry"
    | "dangling-edge"
    | "unreachable-node"
    | "condition-type"
    | "unknown-subflow"
    | "subflow-cycle";
  node?: string;
  message: string;
}

/** Every node id a node can transfer control to. */
export function edgesOf(node: FlowNode): string[] {
  switch (node.type) {
    case "message":
      return [node.next];
    case "prompt":
      return node.on_exhausted ? [node.next, node.on_exhausted] : [node.next];
    case "branch":
      return [...node.cases.map((c) => c.next), ...(node.else ? [node.else] : [])];
    case "action":
      return node.on_error ? [node.next, node.on_error] : [node.next];
    case "subflow":
      return [node.next];
    case "handoff":
    case "end":
      return [];
  }
}

/**
 * Semantic validation beyond the zod schema. Pass the other flows of the
 * deployment as `registry` to also check subflow references and cycles.
 */
export function validateFlow(flow: Flow, registry: Flow[] = []): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodes = flow.nodes;

  if (!nodes[flow.entry]) {
    issues.push({ code: "missing-entry", message: `entry node "${flow.entry}" does not exist` });
  }

  // Dangling edges.
  for (const [id, node] of Object.entries(nodes)) {
    for (const target of edgesOf(node)) {
      if (!nodes[target]) {
        issues.push({
          code: "dangling-edge",
          node: id,
          message: `node "${id}" has an edge to missing node "${target}"`,
        });
      }
    }
  }

  // Unreachable nodes (BFS from entry over valid edges).
  const reachable = new Set<string>();
  const queue = nodes[flow.entry] ? [flow.entry] : [];
  while (queue.length) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const target of edgesOf(nodes[id]!)) {
      if (nodes[target]) queue.push(target);
    }
  }
  for (const id of Object.keys(nodes)) {
    if (!reachable.has(id)) {
      issues.push({
        code: "unreachable-node",
        node: id,
        message: `node "${id}" is unreachable from entry`,
      });
    }
  }

  // Branch conditions vs declared slot types.
  const slotTypes = new Map<string, Slot["type"]>();
  for (const node of Object.values(nodes)) {
    if (node.type === "prompt") slotTypes.set(node.slot.name, node.slot.type);
  }
  for (const [id, node] of Object.entries(nodes)) {
    if (node.type !== "branch") continue;
    for (const { when } of node.cases) {
      const slotType = slotTypes.get(when.slot);
      if (when.op === "gt") {
        if (typeof when.value !== "number") {
          issues.push({
            code: "condition-type",
            node: id,
            message: `branch "${id}": "gt" requires a numeric value`,
          });
        }
        if (slotType && slotType !== "number") {
          issues.push({
            code: "condition-type",
            node: id,
            message: `branch "${id}": "gt" on slot "${when.slot}" declared as ${slotType}`,
          });
        }
      }
      if (when.op === "regex") {
        if (typeof when.value !== "string") {
          issues.push({
            code: "condition-type",
            node: id,
            message: `branch "${id}": "regex" requires a string pattern value`,
          });
        }
        if (slotType === "number") {
          issues.push({
            code: "condition-type",
            node: id,
            message: `branch "${id}": "regex" on slot "${when.slot}" declared as number`,
          });
        }
      }
    }
  }

  // Subflow references and cycles across the flow-call graph.
  const byId = new Map<string, Flow>(registry.map((f) => [f.id, f]));
  byId.set(flow.id, flow);
  if (registry.length) {
    for (const [id, node] of Object.entries(nodes)) {
      if (node.type === "subflow" && !byId.has(node.flow)) {
        issues.push({
          code: "unknown-subflow",
          node: id,
          message: `node "${id}" calls unknown subflow "${node.flow}"`,
        });
      }
    }
  }
  const callees = (f: Flow): string[] =>
    Object.values(f.nodes).flatMap((n) => (n.type === "subflow" ? [n.flow] : []));
  const visiting = new Set<string>();
  const finished = new Set<string>();
  const dfs = (flowId: string, path: string[]): void => {
    if (visiting.has(flowId)) {
      issues.push({
        code: "subflow-cycle",
        message: `subflow cycle: ${[...path, flowId].join(" -> ")}`,
      });
      return;
    }
    if (finished.has(flowId)) return;
    const f = byId.get(flowId);
    if (!f) return;
    visiting.add(flowId);
    for (const callee of callees(f)) dfs(callee, [...path, flowId]);
    visiting.delete(flowId);
    finished.add(flowId);
  };
  dfs(flow.id, []);

  return issues;
}
