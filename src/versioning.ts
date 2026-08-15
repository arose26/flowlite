/**
 * Flows evolve while conversations are live. Two strategies:
 *
 * 1. Version pinning (default): a conversation stays on the flow version it
 *    started on. Zero risk, but old versions must stay registered until the
 *    last pinned conversation drains.
 * 2. Migration: move a suspended conversation onto a new version, declaring
 *    node-id renames and slot transforms. `canMigrate` flags conversations
 *    that cannot make the jump (e.g. parked on a node the new version
 *    removed with no mapping).
 */
import type { Flow } from "./schema.js";
import type { ConversationState } from "./engine.js";

export interface FlowDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

/** Node-level diff between two flow definitions. */
export function diffFlows(a: Flow, b: Flow): FlowDiff {
  const added = Object.keys(b.nodes).filter((k) => !(k in a.nodes));
  const removed = Object.keys(a.nodes).filter((k) => !(k in b.nodes));
  const changed = Object.keys(a.nodes).filter(
    (k) => k in b.nodes && JSON.stringify(a.nodes[k]) !== JSON.stringify(b.nodes[k]),
  );
  return { added, removed, changed };
}

export interface MigrationMap {
  /** Old node id -> new node id. */
  nodes?: Record<string, string>;
  /** Slot name -> transform applied to the stored value. */
  slots?: Record<string, (value: unknown) => unknown>;
}

export interface MigrationIssue {
  node?: string;
  message: string;
}

export class MigrationError extends Error {}

/**
 * Check whether a suspended conversation can move from `fromFlow` to
 * `toFlow`. Empty result means `migrate` will succeed.
 */
export function canMigrate(
  state: ConversationState,
  fromFlow: Flow,
  toFlow: Flow,
  map: MigrationMap = {},
): MigrationIssue[] {
  const issues: MigrationIssue[] = [];
  const check = (nodeId: string, where: string): void => {
    const target = map.nodes?.[nodeId] ?? nodeId;
    if (!toFlow.nodes[target]) {
      issues.push({
        node: nodeId,
        message: `${where} node "${nodeId}" has no equivalent in ${toFlow.id}@${toFlow.version} (maps to "${target}")`,
      });
    }
  };

  const onFrom = (flowId: string, flowVersion: string): boolean =>
    flowId === fromFlow.id && flowVersion === fromFlow.version;

  let touches = false;
  if (onFrom(state.flowId, state.flowVersion)) {
    touches = true;
    check(state.node, "current");
  }
  for (const frame of state.stack) {
    if (onFrom(frame.flowId, frame.flowVersion)) {
      touches = true;
      check(frame.node, "stacked return");
    }
  }
  if (!touches) {
    issues.push({
      message: `conversation is not pinned to ${fromFlow.id}@${fromFlow.version}`,
    });
  }
  return issues;
}

/**
 * Return a new state re-pinned to `toFlow`, with node ids remapped and slot
 * transforms applied. Throws MigrationError when `canMigrate` reports issues.
 */
export function migrate(
  state: ConversationState,
  fromFlow: Flow,
  toFlow: Flow,
  map: MigrationMap = {},
): ConversationState {
  const issues = canMigrate(state, fromFlow, toFlow, map);
  if (issues.length) {
    throw new MigrationError(issues.map((i) => i.message).join("; "));
  }
  const s = structuredClone(state);
  const remap = (nodeId: string): string => map.nodes?.[nodeId] ?? nodeId;
  const transformSlots = (slots: Record<string, unknown>): void => {
    for (const [name, fn] of Object.entries(map.slots ?? {})) {
      if (name in slots) slots[name] = fn(slots[name]);
    }
  };

  if (s.flowId === fromFlow.id && s.flowVersion === fromFlow.version) {
    s.node = remap(s.node);
    s.flowVersion = toFlow.version;
    transformSlots(s.slots);
  }
  for (const frame of s.stack) {
    if (frame.flowId === fromFlow.id && frame.flowVersion === fromFlow.version) {
      frame.node = remap(frame.node);
      frame.flowVersion = toFlow.version;
      transformSlots(frame.slots);
    }
  }
  return s;
}
