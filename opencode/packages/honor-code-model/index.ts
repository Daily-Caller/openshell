/**
 * honor-code-model — OpenCode plugin.
 *
 * When a child (subagent) session is created, switch it to the model declared
 * on that agent's frontmatter / config so code/plan do not inherit manager's model.
 *
 * Debug: HONOR_CODE_MODEL_DEBUG=1
 */
import { Plugin } from "@opencode/plugin"
import { modelsEqual, normalizeModel, type NormalizedModel } from "./lib/model-normalize.ts"

const LOG = process.env.HONOR_CODE_MODEL_DEBUG === "1"

function log(...args: unknown[]) {
	if (LOG) console.log("[honor-code-model]", ...args)
}

/** Pull sessionID / parent / agent off either v2 `data` or legacy `properties`. */
function sessionCreatedFields(event: {
	type?: string
	data?: Record<string, unknown>
	properties?: Record<string, unknown>
}): { sessionID?: string; parentID?: string; agentID?: string } {
	const bag =
		(event.data as Record<string, unknown> | undefined) ??
		(event.properties as Record<string, unknown> | undefined) ??
		{}
	const info = (bag.info as Record<string, unknown> | undefined) ?? bag
	const sessionID =
		(bag.sessionID as string | undefined) ??
		(info.id as string | undefined) ??
		(info.sessionID as string | undefined)
	const parentID =
		(bag.parentID as string | undefined) ?? (info.parentID as string | undefined)
	const agentID =
		(bag.agent as string | undefined) ??
		(bag.agentID as string | undefined) ??
		(info.agent as string | undefined)
	return { sessionID, parentID, agentID }
}

function agentModel(agent: unknown): NormalizedModel | undefined {
	if (!agent || typeof agent !== "object") return undefined
	const root = agent as Record<string, unknown>
	const info = (root.data as Record<string, unknown> | undefined) ?? root
	const model = info.model
	if (!model) return undefined
	return normalizeModel(
		model as string | { providerID: string; modelID?: string; id?: string; variant?: string },
	)
}

export default Plugin.define({
	id: "honor-code-model",
	async setup(ctx) {
		const controller = new AbortController()

		void (async () => {
			try {
				for await (const event of ctx.event.subscribe({
					signal: controller.signal,
				})) {
					if (event.type !== "session.created") continue

					const { sessionID, parentID, agentID } = sessionCreatedFields(
						event as {
							type?: string
							data?: Record<string, unknown>
							properties?: Record<string, unknown>
						},
					)

					log("session.created", { sessionID, parentID, agentID })

					if (!sessionID || !parentID) continue

					try {
						let resolvedAgent = agentID
						let currentModel: NormalizedModel | undefined

						const info = await ctx.session.get({ sessionID })
						resolvedAgent =
							resolvedAgent ??
							(info as { agent?: string }).agent ??
							(info as { agentID?: string }).agentID
						if ((info as { model?: unknown }).model) {
							currentModel = normalizeModel(
								(info as { model: string | { providerID: string; id?: string; modelID?: string } })
									.model,
							)
						}

						if (!resolvedAgent) {
							log("skip: no agent on child session", { sessionID })
							continue
						}

						const agentResp = await ctx.agent.get({ agentID: resolvedAgent })
						const desired = agentModel(agentResp)
						if (!desired || !desired.id || !desired.providerID) {
							log("skip: agent has no model", { agent: resolvedAgent })
							continue
						}

						if (currentModel && modelsEqual(currentModel, desired)) {
							log("already on agent model", { sessionID, model: desired })
							continue
						}

						log("switchModel", { sessionID, model: desired })
						await ctx.session.switchModel({
							sessionID,
							model: desired,
						})
					} catch (err) {
						console.error("[honor-code-model] failed to honor agent model", err)
					}
				}
			} catch (err) {
				if (!controller.signal.aborted) {
					console.error("[honor-code-model] event loop error", err)
				}
			}
		})()

		return () => {
			controller.abort()
		}
	},
})

export { normalizeModel, modelsEqual } from "./lib/model-normalize.ts"
export type { NormalizedModel } from "./lib/model-normalize.ts"
