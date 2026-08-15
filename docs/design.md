# flowlite design

## Goals

1. Conversation logic as data, checkable before runtime.
2. Conversations that survive process restarts, deploys, and flow rewrites.
3. A pure, deterministic core with all I/O pushed to the host.
4. Human handoff as a first-class outcome, not an error path.

## Architecture

```
 flow JSON ──parseFlow──▶ Flow ──validateFlow/lintFlow/walkAllPaths──▶ verified
                            │
                            ▼
 user text ──▶ ┌─────────────────────┐ ──▶ effects: message | run_action |
 action result │  Engine (pure)      │              handoff | end
      ──▶      │  (state, input) ->  │
               │  (state', effects)  │ ◀── flows registered by (id, version)
               └─────────────────────┘
                            │
                   ConversationState (plain JSON)
                            │
                        StateStore (host-owned persistence)
```

Modules:

- `schema.ts` — the definition language (zod) plus semantic validation:
  unreachable nodes, dangling edges, branch-condition/slot type agreement,
  subflow reference and cycle checks.
- `engine.ts` — the interpreter, `runAction` (host-side handler execution with
  timeout), `StateStore` boundary.
- `versioning.ts` — `diffFlows`, `canMigrate`, `migrate`.
- `simulate.ts` — scripted-conversation runner and `walkAllPaths`.
- `linter.ts` — production-hygiene warnings beyond validity.

## Execution model

A conversation advances one inbound event at a time. Within a turn the engine
runs nodes until it must stop:

- `prompt` stops in `awaiting_input` (waiting for user text),
- `action` stops in `awaiting_action` (waiting for a handler result),
- `handoff`/top-level `end` stop in `done`.

`message`, `branch`, `subflow` entry/exit never stop; a hop counter (1000)
converts accidental non-yielding loops into a hard error, and `walkAllPaths`
catches them before deployment.

### The two-phase action protocol

The obvious engine design — `await handler()` inside the interpreter — couples
conversation state to a live process: state can't be persisted mid-action, a
crash loses the conversation, and the engine stops being testable without the
real backend. flowlite instead splits every action into:

1. **Request**: the engine resolves the node's input map against slots/context,
   emits `run_action`, and parks. The state at this moment is complete JSON.
2. **Response**: the host runs the handler however it wants (`runAction` is the
   provided helper: timeout enforcement, exceptions to `{ok: false}`), then
   calls `resume(state, actionResult)`. Success writes the value to the
   declared context key and follows `next`; failure records `last_error` and
   follows `on_error`.

Consequences: the engine has zero async code in its core, action execution can
be retried idempotently at the host's discretion, and tests inject action
results directly without fakes or clocks.

### Slots, context, and scoping

- **Slots** are values captured from the user by prompts, typed at capture time
  (`string`, `number`, `choice` with canonicalization, `regex`).
- **Context** is everything the machine learned otherwise: action outputs,
  subflow outputs, `last_error`.
- Reads (`branch` conditions, templates, input maps) resolve dot paths against
  slots first, then context.
- A subflow gets a fresh scope: its slots are seeded only from the declared
  input map, and only the declared output map flows back to the parent's
  context. No accidental cross-flow coupling.

### Determinism

The engine holds no clock, no randomness, and never mutates the state passed to
`resume`. Everything time-like (action timeouts) lives host-side in `runAction`.
This is what makes `simulate` trustworthy and production incidents replayable
from a state snapshot plus the event log.

## Versioning

Every `ConversationState` carries `flowVersion`; the registry keeps every
registered `(id, version)` pair, and `resume` always interprets against the
pinned pair. Subflows resolve to the latest version at entry time, then pin.

### Pinning vs migration

| | pinning | migration |
|---|---|---|
| cost to adopt | zero | write a `MigrationMap` |
| risk | zero (behavior frozen) | bounded by the map + `canMigrate` |
| old version retirement | after conversations drain | immediate |
| fixes reach live conversations | no | yes |

A `MigrationMap` declares node-id renames (`{confirm: "refund_confirmation"}`)
and slot transforms (`{amount: v => v * 2}`). `canMigrate` checks the current
node *and every stacked subflow return node* against the target flow after
renames; any miss is reported rather than discovered at 3am when the
conversation resumes onto a node that no longer exists. `migrate` refuses to
run with outstanding issues, so a fleet migration cleanly partitions into
migrate-now and drain-on-old-version.

`diffFlows` (added/removed/changed nodes) exists to make review of a flow
change mechanical — the removed list is exactly the set of nodes a migration
map must cover.

## Linting philosophy

`validateFlow` rejects flows that *cannot run correctly*. `lintFlow` warns
about flows that run and then hurt you:

- `prompt-reask-limit` — no `max_attempts`/`on_exhausted`: a confused user is
  re-asked forever.
- `branch-else` — an unmatched branch is a runtime error.
- `action-on-error` — a failing backend becomes a crashed conversation instead
  of a routed one.
- `handoff-reachable` — no path to a human anywhere in the flow.
- `template-var` — `{{vars}}` with no producing slot or output render literally.

Each rule encodes an incident pattern; the linter is where that experience is
kept instead of in reviewers' heads.

## Out of scope (deliberately)

- Timers/delays and proactive re-engagement — needs a scheduler, which is a
  host concern; the clean extension point is a new effect type.
- Parallel/interleaved topics within one conversation.
- An expression language for conditions — the moment conditions become Turing
  complete, every static guarantee above evaporates.
- NLU/intent classification — model calls are just `action` nodes.
