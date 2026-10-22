# OpenCode multi-agent desk

OpenCode v2 harness: `manager` runs `plan`, `explore`, and `code`.
Child sessions take the model from their agent config via `honor-code-model`
(`session.switchModel` on `session.created`).

License: [MIT](LICENSE) © 2026 The Daily Caller

## Requirements

- [OpenCode](https://opencode.ai) **v2.0.23+** (`opencode --version`)
- Provider credentials (see `opencode.json.sample`)

## Setup

```bash
cp opencode.json.sample opencode.json
```

`opencode.json` is gitignored. Keep its tab indentation (see
`instructions/preserve-whitespace.md`). Example env:

```bash
export KEY_XAI=...
export MODEL_DEFAULT=xai/grok-4.3
export MODEL_MANAGER=xai/grok-4.3
export MODEL_CODE=xai/grok-4.5
export MODEL_PLAN=xai/grok-4.5
export MODEL_EXPLORE=xai/grok-4.3
export MODEL_SMALL=xai/grok-4.3
```

Frontmatter models are defaults. `opencode.json` `agents.*.model` env overrides
win when set. Open this directory in OpenCode; default agent is `manager`.

Project agents load from `.opencode/` (gitignored):

```bash
mkdir -p .opencode
ln -sfn ../agents .opencode/agents
```

Plugins are the paths in `opencode.json` → `plugins` (see sample: `./packages/…`).

### Plugins

| Plugin | Path | Role |
|--------|------|------|
| `honor-code-model` | `packages/honor-code-model` | On child `session.created`, `switchModel` to the agent’s model |
| `agent-bus` | `packages/agent-bus` | Shared board: `bus_*` tools |

`HONOR_CODE_MODEL_DEBUG=1` logs switch decisions.

#### Agent bus

Manager, plan, explore, and code share plugin storage (`agent-bus/board`): a
multi-board registry with one **current** board. Most `bus_*` ops hit current.
Legacy single-board payloads load as `default`.

- `bus_status` — current board id, plan, open tasks
- `bus_list` / `bus_use` — list boards; switch or create current
- `bus_plan_set` / `bus_plan_get` — versioned plan; optional `project` switches/creates that board; replace needs `supersede_reason`
- `bus_task_*` — task lifecycle with status transitions
- `bus_fact_*` / `bus_artifact_add` — findings and output paths
- `bus_handoff` — short spawn payload from a `task_id`
- `bus_clear` — wipe current board only (`confirm: true`)

Subagents load context with `bus_task_get` on the current board. Manager picks
the board before spawn (`bus_use` or `project` on plan set), then passes
`task_id` and a short handoff.

## Agents

| Agent | Mode | Default model | Role |
|-------|------|---------------|------|
| `manager` | primary | `xai/grok-4.3` | Runs the desk; shell tests; talks to the user |
| `plan` | subagent | `xai/grok-4.5` | Ordered steps with Done/Blocked criteria |
| `code` | subagent | `xai/grok-4.5` | One closed-ended goal |
| `explore` | built-in | config / OpenCode default | Read-only research |

### Permissions

- **manager**: no edit; shell ask; question allow (Blocked only by policy); spawn `explore` / `code` / `plan` only
- **plan**: no edit; shell ask; no subagents
- **code**: edit ok; shell ask; no subagents; no user questions

## Layout

```
agents/                       # manager.md, plan.md, code.md
packages/agent-bus/           # blackboard plugin
packages/honor-code-model/    # child-session model switch
instructions/                 # preserve-whitespace.md
opencode.json.sample          # plugins: ["./packages/…"]
LICENSE
```

### Load a package elsewhere

```json
{
	"plugins": [
		"/absolute/path/to/this-repo/packages/agent-bus",
		"/absolute/path/to/this-repo/packages/honor-code-model"
	]
}
```

Details: [packages/agent-bus/README.md](packages/agent-bus/README.md),
[packages/honor-code-model/README.md](packages/honor-code-model/README.md).

## Manager loop

1. Answer pure questions directly.
2. For work: select board (`bus_list` / `bus_use` or `project`) → **plan** once → `bus_plan_set` (seed tasks).
3. Run open tasks via **explore** / **code** (parallel explore when independent; max 6 code steps per cycle). Spawn with `bus_handoff` / `task_id` on the current board.
4. Manager runs tests via shell; records failure signatures on fail.
5. Pass → final report and stop. Fail → one re-plan + `bus_plan_set` with `supersede_reason`, then resume.
6. Stop on repeated identical failure signature, plan-cycle cap (3), or Blocked.
