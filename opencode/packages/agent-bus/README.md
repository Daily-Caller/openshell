# opencode-agent-bus

OpenCode plugin: shared blackboard across manager / plan / explore / code via
`bus_*` tools. Storage is OpenCode plugin storage (`agent-bus/board`): a
multi-board registry (current + named boards). All `bus_*` ops resolve against
the current board (`getCurrentBoard`). Legacy single-board payloads load as
board `default`.

## Install in another OpenCode project

### Path (no publish)

Point `plugins` at this package directory (absolute path is safest):

```json
{
	"plugins": [
		"/absolute/path/to/opencode/packages/agent-bus"
	]
}
```

Or from a sibling checkout:

```json
{
	"plugins": [
		"../opencode/packages/agent-bus"
	]
}
```

Restart OpenCode (or reload plugins) after changing config.

### This desk

This repo still auto-loads via `plugins/agent-bus.ts`, which re-exports this
package. You can also list the package path in `opencode.json` `plugins`.

## Tools

All `bus_*` tools set `options.codemode: true` so code agents can call them from
the execute / Code Mode runtime (load task, report results, store facts).

| Tool | Role |
|------|------|
| `bus_status` | Current board id, plan version, open tasks, counts |
| `bus_list` / `bus_use` | List boards; switch/create current board |
| `bus_plan_get` / `bus_plan_set` | Versioned plan (optional `project` board; replace needs `supersede_reason`) |
| `bus_task_*` | Task lifecycle on current board |
| `bus_fact_*` / `bus_artifact_add` | Durable facts and paths on current board |
| `bus_handoff` | Short spawn payload for a `task_id` |
| `bus_clear` | Wipe **current** board only (`confirm: true`) |

## Layout

```
index.ts           # Plugin.define entry
lib/blackboard.ts  # Pure board logic
lib/blackboard.mjs # ESM mirror (optional Node consumers)
```

Peer: `@opencode/plugin` (provided by OpenCode at runtime).

## License

MIT © The Daily Caller — see `LICENSE`.
