/**
 * agent-bus — shared blackboard for Manager / plan / explore / code.
 *
 * Storage is process-global (OpenCode plugin storage), keyed once per workspace
 * as a BoardRegistry (current + named boards). Every bus_* op loads the registry
 * and resolves against getCurrentBoard(registry). Legacy bare Board payloads
 * parse as boards.default. bus_use / bus_plan_set(project) switch current board.
 */
import { Plugin } from "@opencode/plugin"
import {
  TASK_AGENTS,
  TASK_STATUSES,
  addArtifact,
  clearBoard,
  getCurrentBoard,
  getFact,
  getTask,
  listTasks,
  parseRegistry,
  putFact,
  registryToJson,
  renderBoardList,
  renderHandoff,
  renderStatus,
  renderTask,
  setPlanOnRegistry,
  switchBoard,
  updateTask,
  upsertTask,
  type Board,
  type BoardRegistry,
  type TaskAgent,
  type TaskStatus,
} from "./lib/blackboard.ts"

const STORAGE_KEY = "agent-bus/board"

function actorFrom(context: { agent?: string }): string {
  return context.agent ?? "unknown"
}

async function loadRegistry(ctx: {
  storage: { get: (k: string) => Promise<unknown> }
}): Promise<BoardRegistry> {
  return parseRegistry(await ctx.storage.get(STORAGE_KEY))
}

async function saveRegistry(
  ctx: { storage: { set: (k: string, v: unknown) => Promise<void> } },
  registry: BoardRegistry,
): Promise<void> {
  await ctx.storage.set(STORAGE_KEY, registryToJson(registry) as never)
}

/** Current board from storage (creates default if missing). */
async function load(ctx: {
  storage: { get: (k: string) => Promise<unknown> }
}): Promise<{ registry: BoardRegistry; board: Board }> {
  const registry = await loadRegistry(ctx)
  return { registry, board: getCurrentBoard(registry) }
}

async function save(
  ctx: { storage: { set: (k: string, v: unknown) => Promise<void> } },
  registry: BoardRegistry,
): Promise<void> {
  await saveRegistry(ctx, registry)
}

function ok(text: string) {
  return { content: text }
}

function err(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e)
  return { content: `Error: ${msg}` }
}

const EMPTY_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const

export default Plugin.define({
  id: "agent-bus",
  async setup(ctx) {
    const tools = await ctx.tool.transform((editor) => {
      editor.add({
        name: "bus_status",
        description:
          "Show the current board: id, active plan version, open tasks, and counts. Prefer this over reconstructing state from chat.",
        input: EMPTY_SCHEMA,
        options: { codemode: true },
        execute: async () => {
          try {
            const { registry, board } = await load(ctx)
            return ok(renderStatus(board, registry.current))
          } catch (e) {
            return err(e)
          }
        },
      })

      editor.add({
        name: "bus_list",
        description:
          "List all boards in the registry (* marks current). Use with bus_use to switch project/session boards.",
        input: EMPTY_SCHEMA,
        options: { codemode: true },
        execute: async () => {
          try {
            const registry = await loadRegistry(ctx)
            // Ensure default board exists for empty storage (backward compatible).
            getCurrentBoard(registry)
            return ok(renderBoardList(registry))
          } catch (e) {
            return err(e)
          }
        },
      })

      editor.add({
        name: "bus_use",
        description: [
          "Switch the current board (project/session isolation).",
          "Creates the board if missing unless create=false.",
          "All subsequent bus_* ops resolve against this board until switched again.",
        ].join(" "),
        input: {
          type: "object",
          properties: {
            board: {
              type: "string",
              description: 'Board id to make current (e.g. "default", project path, session id).',
            },
            create: {
              type: "boolean",
              description: "Create board if missing (default true). Set false to require an existing board.",
            },
          },
          required: ["board"],
          additionalProperties: false,
        },
        options: { codemode: true },
        execute: async (input, context) => {
          try {
            const registry = await loadRegistry(ctx)
            const body = input as { board: string; create?: boolean }
            const board = switchBoard(registry, body.board, {
              create: body.create,
              actor: actorFrom(context),
            })
            await save(ctx, registry)
            return ok(renderStatus(board, registry.current))
          } catch (e) {
            return err(e)
          }
        },
      })

      editor.add({
        name: "bus_plan_get",
        description: "Read the active plan on the current board (version, goal, done/blocked criteria).",
        input: EMPTY_SCHEMA,
        options: { codemode: true },
        execute: async () => {
          try {
            const { registry, board } = await load(ctx)
            if (!board.plan) return ok(`board: ${registry.current}\nNo active plan.`)
            const p = board.plan
            const lines = [
              `board: ${registry.current}`,
              `version: ${p.version}`,
              `goal: ${p.goal}`,
              `updated_by: ${p.updated_by}`,
              `updated_at: ${p.updated_at}`,
            ]
            if (p.project) lines.push(`project: ${p.project}`)
            if (p.supersede_reason) lines.push(`supersede_reason: ${p.supersede_reason}`)
            if (p.done_criteria.length) {
              lines.push("done_criteria:")
              for (const c of p.done_criteria) lines.push(`  - ${c}`)
            }
            if (p.blocked_criteria.length) {
              lines.push("blocked_criteria:")
              for (const c of p.blocked_criteria) lines.push(`  - ${c}`)
            }
            const tasks = listTasks(board, { plan_version: p.version })
            if (tasks.length) {
              lines.push("tasks:")
              for (const t of tasks) {
                lines.push(`  - ${t.id} [${t.status}] (${t.agent}) ${t.title}`)
              }
            }
            return ok(lines.join("\n"))
          } catch (e) {
            return err(e)
          }
        },
      })

      editor.add({
        name: "bus_plan_set",
        description: [
          "Create or supersede the shared plan and seed tasks.",
          "If a plan already exists you MUST pass supersede_reason — silent rewrites are rejected.",
          "Optional project switches/creates that board (default board when omitted).",
          "Use after plan agent returns, or when Manager must re-plan with failure evidence.",
          "This is the source of truth; do not replace it with todowrite as primary state.",
        ].join(" "),
        input: {
          type: "object",
          properties: {
            goal: { type: "string", description: "Overall user goal for this plan." },
            project: {
              type: "string",
              description:
                'Board id for this plan (e.g. project path or name). Switches/creates that board. Omit or empty for "default".',
            },
            done_criteria: {
              type: "array",
              items: { type: "string" },
              description: "Overall success checks (exact commands when applicable).",
            },
            blocked_criteria: {
              type: "array",
              items: { type: "string" },
              description: "Conditions that force stop and ask the user.",
            },
            supersede_reason: {
              type: "string",
              description: "Required when replacing an existing plan (why the prior plan is obsolete).",
            },
            tasks: {
              type: "array",
              description: "Optional seed tasks for this plan version.",
              items: {
                type: "object",
                properties: {
                  id: { type: "string", description: "Optional id e.g. T1; auto-assigned if omitted." },
                  title: { type: "string" },
                  agent: { type: "string", enum: [...TASK_AGENTS] },
                  goal: { type: "string" },
                  constraints: { type: "string" },
                  acceptance: { type: "string" },
                  inputs: { type: "string" },
                },
                required: ["title", "agent", "goal"],
                additionalProperties: false,
              },
            },
          },
          required: ["goal"],
          additionalProperties: false,
        },
        options: { codemode: true },
        execute: async (input, context) => {
          try {
            const registry = await loadRegistry(ctx)
            const body = input as {
              goal: string
              project?: string
              done_criteria?: string[]
              blocked_criteria?: string[]
              supersede_reason?: string
              tasks?: Array<{
                id?: string
                title: string
                agent: TaskAgent
                goal: string
                constraints?: string
                acceptance?: string
                inputs?: string
              }>
            }
            const board = setPlanOnRegistry(registry, {
              ...body,
              actor: actorFrom(context),
            })
            await save(ctx, registry)
            return ok(renderStatus(board, registry.current))
          } catch (e) {
            return err(e)
          }
        },
      })

      editor.add({
        name: "bus_task_list",
        description:
          "List tasks on the current board. Filter by status and/or plan_version.",
        input: {
          type: "object",
          properties: {
            status: {
              oneOf: [
                { type: "string", enum: [...TASK_STATUSES] },
                { type: "array", items: { type: "string", enum: [...TASK_STATUSES] } },
              ],
              description: "Filter by one status or an array of statuses.",
            },
            plan_version: { type: "number" },
            open_only: {
              type: "boolean",
              description: "If true, only pending|running|blocked (ignores status filter).",
            },
          },
          additionalProperties: false,
        },
        options: { codemode: true },
        execute: async (input) => {
          try {
            const { board } = await load(ctx)
            const body = input as {
              status?: TaskStatus | TaskStatus[]
              plan_version?: number
              open_only?: boolean
            }
            const filter = body.open_only
              ? {
                  status: ["pending", "running", "blocked"] as TaskStatus[],
                  plan_version: body.plan_version,
                }
              : { status: body.status, plan_version: body.plan_version }
            const tasks = listTasks(board, filter)
            if (!tasks.length) return ok("(no matching tasks)")
            return ok(tasks.map((t) => `${t.id} [${t.status}] (${t.agent}) ${t.title}`).join("\n"))
          } catch (e) {
            return err(e)
          }
        },
      })

      editor.add({
        name: "bus_task_get",
        description:
          "Load one task by id (full goal, constraints, acceptance, results). Subagents should call this first when given a task_id.",
        input: {
          type: "object",
          properties: {
            id: { type: "string", description: "Task id e.g. T3" },
          },
          required: ["id"],
          additionalProperties: false,
        },
        options: { codemode: true },
        execute: async (input) => {
          try {
            const { board } = await load(ctx)
            const id = String((input as { id: string }).id)
            const task = getTask(board, id)
            if (!task) return ok(`Error: unknown task ${id}`)
            return ok(renderTask(task))
          } catch (e) {
            return err(e)
          }
        },
      })

      editor.add({
        name: "bus_task_upsert",
        description:
          "Create or overwrite a task definition (title/agent/goal/context). Does not delete other tasks. Prefer bus_plan_set for a full plan seed.",
        input: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            agent: { type: "string", enum: [...TASK_AGENTS] },
            goal: { type: "string" },
            status: { type: "string", enum: [...TASK_STATUSES] },
            constraints: { type: "string" },
            acceptance: { type: "string" },
            inputs: { type: "string" },
          },
          required: ["title", "agent", "goal"],
          additionalProperties: false,
        },
        options: { codemode: true },
        execute: async (input, context) => {
          try {
            const { registry, board } = await load(ctx)
            const task = upsertTask(board, {
              ...(input as {
                id?: string
                title: string
                agent: TaskAgent
                goal: string
                status?: TaskStatus
                constraints?: string
                acceptance?: string
                inputs?: string
              }),
              actor: actorFrom(context),
            })
            await save(ctx, registry)
            return ok(renderTask(task))
          } catch (e) {
            return err(e)
          }
        },
      })

      editor.add({
        name: "bus_task_update",
        description: [
          "Update task status and results.",
          "Transitions are validated (e.g. pending→running→done|blocked).",
          "status=blocked requires blocked_reason.",
          "Always set result_summary when finishing.",
        ].join(" "),
        input: {
          type: "object",
          properties: {
            id: { type: "string" },
            status: { type: "string", enum: [...TASK_STATUSES] },
            result_summary: { type: "string" },
            failure_signature: { type: "string" },
            blocked_reason: { type: "string" },
            title: { type: "string" },
            goal: { type: "string" },
            constraints: { type: "string" },
            acceptance: { type: "string" },
            inputs: { type: "string" },
          },
          required: ["id"],
          additionalProperties: false,
        },
        options: { codemode: true },
        execute: async (input, context) => {
          try {
            const { registry, board } = await load(ctx)
            const task = updateTask(board, {
              ...(input as {
                id: string
                status?: TaskStatus
                result_summary?: string
                failure_signature?: string
                blocked_reason?: string
                title?: string
                goal?: string
                constraints?: string
                acceptance?: string
                inputs?: string
              }),
              actor: actorFrom(context),
            })
            await save(ctx, registry)
            return ok(renderTask(task))
          } catch (e) {
            return err(e)
          }
        },
      })

      editor.add({
        name: "bus_fact_put",
        description:
          "Write a durable keyed fact onto the shared board (paths found, API shapes, decisions). Survives subagent session boundaries.",
        input: {
          type: "object",
          properties: {
            key: { type: "string" },
            value: { type: "string" },
            task_id: { type: "string" },
          },
          required: ["key", "value"],
          additionalProperties: false,
        },
        options: { codemode: true },
        execute: async (input, context) => {
          try {
            const { registry, board } = await load(ctx)
            const body = input as { key: string; value: string; task_id?: string }
            const fact = putFact(board, {
              key: body.key,
              value: body.value,
              task_id: body.task_id,
              source_agent: actorFrom(context),
            })
            await save(ctx, registry)
            return ok(`fact ${fact.key} stored`)
          } catch (e) {
            return err(e)
          }
        },
      })

      editor.add({
        name: "bus_fact_get",
        description: "Read one fact by key.",
        input: {
          type: "object",
          properties: { key: { type: "string" } },
          required: ["key"],
          additionalProperties: false,
        },
        options: { codemode: true },
        execute: async (input) => {
          try {
            const { board } = await load(ctx)
            const key = String((input as { key: string }).key)
            const fact = getFact(board, key)
            if (!fact) return ok(`(no fact ${key})`)
            return ok(`${fact.key}: ${fact.value}`)
          } catch (e) {
            return err(e)
          }
        },
      })

      editor.add({
        name: "bus_fact_list",
        description: "List facts (optional prefix filter).",
        input: {
          type: "object",
          properties: {
            prefix: { type: "string", description: "Only keys starting with this prefix." },
          },
          additionalProperties: false,
        },
        options: { codemode: true },
        execute: async (input) => {
          try {
            const { board } = await load(ctx)
            const prefix = (input as { prefix?: string }).prefix?.trim()
            const facts = prefix
              ? board.facts.filter((f) => f.key.startsWith(prefix))
              : board.facts
            if (!facts.length) return ok("(no facts)")
            return ok(facts.map((f) => `${f.key}: ${f.value}`).join("\n"))
          } catch (e) {
            return err(e)
          }
        },
      })

      editor.add({
        name: "bus_artifact_add",
        description: "Record an artifact path produced by work (logs under /tmp, key files, diffs).",
        input: {
          type: "object",
          properties: {
            path: { type: "string" },
            kind: { type: "string", description: "e.g. file, log, diff" },
            task_id: { type: "string" },
            notes: { type: "string" },
          },
          required: ["path"],
          additionalProperties: false,
        },
        options: { codemode: true },
        execute: async (input, context) => {
          try {
            const { registry, board } = await load(ctx)
            const art = addArtifact(board, {
              ...(input as {
                path: string
                kind?: string
                task_id?: string
                notes?: string
              }),
              actor: actorFrom(context),
            })
            await save(ctx, registry)
            return ok(`${art.id} recorded: ${art.path}`)
          } catch (e) {
            return err(e)
          }
        },
      })

      editor.add({
        name: "bus_handoff",
        description:
          "Build a short spawn prompt for a task_id: includes task fields, related facts/artifacts, and finish instructions. Manager should pass this (or task_id alone) to subagents instead of multi-page dumps.",
        input: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
        options: { codemode: true },
        execute: async (input) => {
          try {
            const { board } = await load(ctx)
            return ok(renderHandoff(board, String((input as { id: string }).id)))
          } catch (e) {
            return err(e)
          }
        },
      })

      editor.add({
        name: "bus_clear",
        description: [
          "Wipe the current board only (plan, tasks, facts, artifacts).",
          "Other boards in the registry are left intact.",
          "Use only when starting a brand-new user goal unrelated to the prior board.",
        ].join(" "),
        input: {
          type: "object",
          properties: {
            confirm: {
              type: "boolean",
              description: "Must be true to clear.",
            },
          },
          required: ["confirm"],
          additionalProperties: false,
        },
        options: { codemode: true },
        execute: async (input, context) => {
          try {
            if (!(input as { confirm: boolean }).confirm) {
              return ok("Error: confirm must be true")
            }
            const { registry, board } = await load(ctx)
            const id = registry.current
            clearBoard(board, actorFrom(context))
            await save(ctx, registry)
            return ok(`Board cleared: ${id}`)
          } catch (e) {
            return err(e)
          }
        },
      })
    })

    const contextHook = await ctx.session.hook("context", async (event) => {
      try {
        const { registry, board } = await load(ctx)
        const open = listTasks(board, { status: ["pending", "running", "blocked"] })
        if (!board.plan && open.length === 0) return
        event.system.push({
          type: "text",
          text: [
            "Shared agent blackboard (source of truth across Manager and subagents):",
            renderStatus(board, registry.current),
            "",
            "Ops use the current board. bus_list / bus_use switch boards; bus_plan_set project= creates/selects a board; bus_clear wipes current only.",
            "Prefer bus_handoff(task_id) when spawning. Do not rewrite the whole plan without supersede_reason. Do not rely on parent session transcripts for shared state.",
          ].join("\n"),
        })
      } catch (e) {
        console.warn("[agent-bus] context hook failed:", e)
      }
    })

    return async () => {
      await contextHook.dispose()
      await tools.dispose()
    }
  },
})
