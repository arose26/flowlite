# flowlite

Declarative, versioned, resumable conversation flows: JSON in, deterministic turn-based
execution out, with migrations for conversations that outlive their flow definition.

## Why declarative

Conversation logic written as bespoke bot code (`if intent == "refund": ...`) has a
structural problem: the only way to know what the bot does is to run it. Flows-as-data
fix that at the root:

- **Static verification.** A flow is a graph you can check before it ever meets a user:
  unreachable nodes, dangling edges, branch conditions typed against the slots they read,
  subflow cycles (`validateFlow`), plus production-hygiene lint rules (`lintFlow`) and a
  path walker that proves every reachable path terminates at `end` or `handoff`
  (`walkAllPaths`). None of that is possible when the flow is buried in imperative code.
- **Serializable state.** The engine is a pure interpreter: `(state, input) ->
  (state', effects)`. State is plain JSON — current node, typed slot values, context,
  subflow stack, version pin — so a conversation can be persisted mid-turn, moved across
  processes or deploys, and resumed. Bot code holding state in closures and local
  variables can't be suspended, only kept alive.
- **Deterministic replay.** Same state + same input = same result, always. Bugs reproduce
  from a state snapshot; scripted conversations (`simulate`) assert on exact effects.
- **Safe evolution.** Because the definition is data, two versions can be diffed
  (`diffFlows`), conversations stay pinned to the version they started on, and a
  suspended conversation can be *migrated* to a new version with declared node renames
  and slot transforms (`migrate`) — with impossible migrations detected up front
  (`canMigrate`). Try that with a redeployed if/else pyramid.
- **Humans are first-class.** `handoff` is a terminal node type, not an afterthought.
  The linter flags any flow with no reachable path to a human.

## Node types

| type | what it does |
|---|---|
| `message` | send text (with `{{slot.path}}` templates) |
| `prompt` | ask and capture a typed slot: `string`, `number`, `choice`, `regex` — with re-ask limits and an exhaustion edge |
| `branch` | route on conditions over slots/context: `eq`, `gt`, `contains`, `regex`, with `else` |
| `action` | invoke a host-registered handler (input mapped from slots, output written to context, timeout + `on_error` edge) |
| `subflow` | call another flow with input/output mapping |
| `handoff` | terminal: escalate to a human with a reason |
| `end` | terminal: done (returns to the parent when inside a subflow) |

## Quickstart

```ts
import { Engine, parseFlow, validateFlow, runAction } from "flowlite";

const flow = parseFlow(JSON.parse(fs.readFileSync("support.flow.json", "utf8")));
if (validateFlow(flow).length) throw new Error("bad flow");

const engine = new Engine();
engine.register(flow);

// Turn 1: start the conversation.
let { state, effects } = engine.start(flow.id);
// effects: [{ type: "message", text: "Hi! ..." }, ...] — send them, store state.

// Turn 2: the user replied. State came back from your store (it's just JSON).
({ state, effects } = engine.resume(state, { type: "user", text: "refund" }));

// When an effect is { type: "run_action", ... }, run the handler and feed the
// result back — the engine never does I/O itself:
const result = await runAction({ lookupOrder: async (input) => db.orders.get(input.order_id) }, effect);
({ state, effects } = engine.resume(state, result));
```

## Demo

`npm run demo` runs [examples/order-support.flow.json](examples/order-support.flow.json)
through two conversations plus a live migration. Captured output:

```text
Loaded order-support@1.0.0: 19 nodes, 0 validation issues, 0 lint warnings

=== Conversation 1: happy path (small refund) ===
bot>  Hi! Welcome to Acme support.
bot>  What can I help you with? (order status / refund / agent)
you>  refund
bot>  Sure. What's your order number? (it looks like ORD-12345)
you>  ORD-1001
      [action lookupOrder -> ok]
bot>  I can refund $49.99 for order ORD-1001. Should I go ahead? (yes/no)
you>  yes
      [action issueRefund -> ok]
bot>  Done! Refund RF-7301 for $49.99 is on its way.
bot>  Thanks for contacting Acme. Have a great day!
      [conversation ended]

=== Conversation 2: high-value refund escalates to a human ===
bot>  Hi! Welcome to Acme support.
bot>  What can I help you with? (order status / refund / agent)
you>  refund
bot>  Sure. What's your order number? (it looks like ORD-12345)
you>  ORD-2002
      [action lookupOrder -> ok]
      [handoff: refund over $100 (order ORD-2002, $899) needs human approval]

=== Live migration: v1 -> v2 mid-conversation ===
bot>  Hi! Welcome to Acme support.
bot>  What can I help you with? (order status / refund / agent)
you>  refund
bot>  Sure. What's your order number? (it looks like ORD-12345)
you>  ORD-1001
      [action lookupOrder -> ok]
bot>  I can refund $49.99 for order ORD-1001. Should I go ahead? (yes/no)
      (suspended at node "confirm_refund" on v1.0.0)
      (diff v1 -> v2: {"added":["refund_confirmation"],"removed":["confirm_refund"],"changed":["refund_check"]})
      (migrated: now at node "refund_confirmation" on v2.0.0)
you>  yes
      [action issueRefund -> ok]
bot>  Done! Refund RF-7301 for $49.99 is on its way.
bot>  Thanks for contacting Acme. Have a great day!
      [conversation ended]
```

## Design notes

**Two-phase effects keep state serializable.** The engine never awaits a handler.
Reaching an `action` node emits a `run_action` effect and parks the conversation in
`awaiting_action`; the host executes the handler (with `runAction` enforcing the declared
timeout) and calls `resume` with the result. Between the phases the state is inert JSON —
which is exactly the moment hosts persist it. A crash mid-action loses nothing but the
in-flight handler call, which is retryable because the engine is deterministic.

**Version pinning vs migration is a trade-off, so both exist.** Pinning is free and safe:
a conversation started on `1.0.0` keeps running on `1.0.0` even after `2.0.0` ships — but
old versions must stay registered until the last pinned conversation drains, and urgent
fixes don't reach live conversations. Migration moves suspended conversations forward
under an explicit contract (node renames + slot transforms), and `canMigrate` refuses the
jump for any conversation parked on a node the new version removed without a mapping —
so a batch migration can split cleanly into "moved" and "leave pinned".

More in [docs/design.md](docs/design.md).

## Testing

```
npm install
npm test        # 80 tests: schema defects, engine semantics, subflows,
                # versioning/migration, simulator, linter, end-to-end example
npm run build
npm run demo
```

## Limitations

- Single inbound event at a time; no timers, scheduled re-engagement, or parallel branches.
- Branch conditions are a deliberately small algebra (`eq`/`gt`/`contains`/`regex`) —
  no expression language, by design: expressions are where flow definitions quietly turn
  back into code.
- No NLU: `choice` matching is literal (case-insensitive). Put an intent classifier in an
  `action` node if you need one.
- `walkAllPaths` enumerates within one flow; subflow bodies are verified per-flow.
- The in-memory `StateStore` is for tests and demos; bring your own persistence.

## License

MIT
