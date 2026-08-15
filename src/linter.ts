/**
 * Flow lint: warnings about flows that are structurally valid but will
 * behave badly in production. Everything here was learned the hard way in
 * some conversation, somewhere.
 */
import type { Flow } from "./schema.js";
import { edgesOf } from "./schema.js";

export interface LintIssue {
  rule:
    | "prompt-reask-limit"
    | "branch-else"
    | "action-on-error"
    | "handoff-reachable"
    | "template-var";
  node?: string;
  message: string;
}

const TEMPLATE_VAR = /\{\{\s*([\w.]+)\s*\}\}/g;

export function lintFlow(flow: Flow): LintIssue[] {
  const issues: LintIssue[] = [];
  const entries = Object.entries(flow.nodes);

  for (const [id, node] of entries) {
    if (node.type === "prompt" && (node.max_attempts === undefined || !node.on_exhausted)) {
      issues.push({
        rule: "prompt-reask-limit",
        node: id,
        message: `prompt "${id}" has no re-ask limit (max_attempts + on_exhausted); invalid input re-asks forever`,
      });
    }
    if (node.type === "branch" && !node.else) {
      issues.push({
        rule: "branch-else",
        node: id,
        message: `branch "${id}" has no else; an unmatched value is a runtime error`,
      });
    }
    if (node.type === "action" && !node.on_error) {
      issues.push({
        rule: "action-on-error",
        node: id,
        message: `action "${id}" has no on_error edge; a failing handler is a runtime error`,
      });
    }
  }

  // Every flow should have a reachable path to a human.
  const reachable = new Set<string>();
  const queue = flow.nodes[flow.entry] ? [flow.entry] : [];
  while (queue.length) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const target of edgesOf(flow.nodes[id]!)) {
      if (flow.nodes[target]) queue.push(target);
    }
  }
  const hasHandoff = [...reachable].some((id) => flow.nodes[id]!.type === "handoff");
  if (!hasHandoff) {
    issues.push({
      rule: "handoff-reachable",
      message: "no reachable handoff node: users can never escalate to a human",
    });
  }

  // Template vars must have a source: a prompt slot, an action output, a
  // subflow output, or the engine-provided last_error.
  const sources = new Set<string>(["last_error"]);
  for (const [, node] of entries) {
    if (node.type === "prompt") sources.add(node.slot.name);
    if (node.type === "action" && node.output) sources.add(node.output);
    if (node.type === "subflow") for (const key of Object.keys(node.output ?? {})) sources.add(key);
  }
  for (const [id, node] of entries) {
    const texts: string[] =
      node.type === "message"
        ? [node.text]
        : node.type === "prompt"
          ? [node.text, ...(node.retry_text ? [node.retry_text] : [])]
          : node.type === "handoff"
            ? [node.reason]
            : [];
    for (const text of texts) {
      for (const match of text.matchAll(TEMPLATE_VAR)) {
        const head = match[1]!.split(".")[0]!;
        if (!sources.has(head)) {
          issues.push({
            rule: "template-var",
            node: id,
            message: `template var "{{${match[1]}}}" in "${id}" has no source (no slot or output named "${head}")`,
          });
        }
      }
    }
  }

  return issues;
}
