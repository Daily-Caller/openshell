# opencode-honor-code-model

OpenCode plugin: on child `session.created`, `switchModel` to the model from
that agent’s frontmatter / config so subagents do not inherit the parent model.

## Install

```json
{
	"plugins": [
		"/absolute/path/to/packages/honor-code-model"
	]
}
```

Or from a desk shim:

```ts
export { default } from "../packages/honor-code-model/index.ts"
```

## Behavior

1. Subscribe to `session.created`
2. Skip root sessions (no `parentID`)
3. Resolve agent id from the event / session
4. Read agent model via `ctx.agent.get`
5. Call `ctx.session.switchModel` when the session model differs

Debug: `HONOR_CODE_MODEL_DEBUG=1`

## Exports

- default plugin (`id: "honor-code-model"`)
- `normalizeModel` / `modelsEqual` / `NormalizedModel`

## License

MIT
