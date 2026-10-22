/**
 * Shared agent blackboard: plan, tasks, facts, artifacts. Pure logic, no I/O.
 *
 * Copyright (c) Lee Holdings International
 * Improvements and modifications Copyright (c) The Daily Caller
 *
 * SPDX-License-Identifier: MIT
 */


export type TaskStatus = "pending" | "running" | "done" | "blocked" | "cancelled"
export type TaskAgent = "explore" | "code" | "plan" | "manager-shell"

export const TASK_STATUSES: readonly TaskStatus[] = [
  "pending",
  "running",
  "done",
  "blocked",
  "cancelled",
] as const

export const TASK_AGENTS: readonly TaskAgent[] = [
  "explore",
  "code",
  "plan",
  "manager-shell",
] as const

export type Plan = {
  version: number
  goal: string
  done_criteria: string[]
  blocked_criteria: string[]
  supersede_reason?: string
  /** Board / project id this plan belongs to (opaque; defaults to "default"). */
  project?: string
  updated_at: number
  updated_by: string
}

export type Task = {
  id: string
  plan_version: number
  title: string
  agent: TaskAgent
  status: TaskStatus
  goal: string
  constraints?: string
  acceptance?: string
  inputs?: string
  result_summary?: string
  failure_signature?: string
  blocked_reason?: string
  updated_at: number
  updated_by?: string
}

export type Fact = {
  key: string
  value: string
  source_agent?: string
  task_id?: string
  created_at: number
}

export type Artifact = {
  id: string
  path: string
  kind: string
  task_id?: string
  notes?: string
  created_at: number
}

export type BusEvent = {
  at: number
  agent?: string
  op: string
  detail: string
}

export type Board = {
  plan: Plan | null
  tasks: Task[]
  facts: Fact[]
  artifacts: Artifact[]
  events: BusEvent[]
}

/** Default board id for single-board / legacy storage. */
export const DEFAULT_BOARD_ID = "default"

/**
 * Multi-board registry: named boards plus which one is current.
 * All bus_* ops should resolve against getCurrentBoard(registry).
 * Board ids are opaque strings (e.g. "default", project path, session id).
 */
export type BoardRegistry = {
  /** Id of the active board. */
  current: string
  /** Named boards keyed by id. */
  boards: Record<string, Board>
}

export const EMPTY_BOARD: Board = {
  plan: null,
  tasks: [],
  facts: [],
  artifacts: [],
  events: [],
}

const MAX_EVENTS = 200
export const MAX_EVENT_DETAIL_SIZE = 4096 // 4KB per event detail
/** Security limits to prevent resource exhaustion */
export const MAX_FACTS = 500
export const MAX_ARTIFACTS = 200

/** Agents that are allowed to set privileged source_agent values */
export const TRUSTED_INTERNAL_AGENTS = ["manager", "system"] as const;


const ALLOWED: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ["running", "cancelled", "done", "blocked"],
  running: ["done", "blocked", "pending", "cancelled"],
  blocked: ["pending", "running", "cancelled", "done"],
  done: [],
  cancelled: ["pending"],
}

export function emptyBoard(): Board {
  return {
    plan: null,
    tasks: [],
    facts: [],
    artifacts: [],
    events: [],
  }
}

/** Fresh registry with a single empty default board selected. */
export function emptyRegistry(currentId = DEFAULT_BOARD_ID): BoardRegistry {
  const id = currentId.trim() || DEFAULT_BOARD_ID
  return {
    current: id,
    boards: { [id]: emptyBoard() },
  }
}

/** True when value has the multi-board shape (current + boards map). */
export function isBoardRegistry(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false
  const raw = value as Record<string, unknown>
  return (
    typeof raw.current === "string" &&
    raw.boards !== null &&
    typeof raw.boards === "object" &&
    !Array.isArray(raw.boards)
  )
}

export function parseBoard(value: unknown): Board {
  if (value === null || typeof value !== "object") return emptyBoard()
  // Avoid treating a registry payload as a bare board.
  if (isBoardRegistry(value)) return emptyBoard()
  const raw = value as Partial<Board>
  const board: Board = {
    plan: null,
    tasks: [],
    facts: [],
    artifacts: [],
    events: [],
  }
  if (raw.plan && typeof raw.plan === "object") {
    const p = raw.plan as Partial<Plan>
    if (typeof p.version === "number" && typeof p.goal === "string") {
      board.plan = {
        version: p.version,
        goal: p.goal,
        done_criteria: Array.isArray(p.done_criteria)
          ? p.done_criteria.filter((x): x is string => typeof x === "string")
          : [],
        blocked_criteria: Array.isArray(p.blocked_criteria)
          ? p.blocked_criteria.filter((x): x is string => typeof x === "string")
          : [],
        updated_at: typeof p.updated_at === "number" ? p.updated_at : 0,
        updated_by: typeof p.updated_by === "string" ? p.updated_by : "unknown",
      }
      if (typeof p.supersede_reason === "string") {
        board.plan.supersede_reason = p.supersede_reason
      }
      if (typeof p.project === "string" && p.project.trim()) {
        board.plan.project = p.project.trim()
      }
    }
  }
  if (Array.isArray(raw.tasks)) {
    for (const t of raw.tasks) {
      const task = coerceTask(t)
      if (task) board.tasks.push(task)
    }
  }
  if (Array.isArray(raw.facts)) {
    for (const f of raw.facts) {
      if (!f || typeof f !== "object") continue
      const item = f as Partial<Fact>
      if (typeof item.key !== "string" || typeof item.value !== "string") continue
      const fact: Fact = {
        key: item.key,
        value: item.value,
        created_at: typeof item.created_at === "number" ? item.created_at : 0,
      }
      if (typeof item.source_agent === "string") fact.source_agent = item.source_agent
      if (typeof item.task_id === "string") fact.task_id = item.task_id
      board.facts.push(fact)
    }
  }
  if (Array.isArray(raw.artifacts)) {
    for (const a of raw.artifacts) {
      if (!a || typeof a !== "object") continue
      const item = a as Partial<Artifact>
      if (typeof item.id !== "string" || typeof item.path !== "string") continue
      const art: Artifact = {
        id: item.id,
        path: item.path,
        kind: typeof item.kind === "string" ? item.kind : "file",
        created_at: typeof item.created_at === "number" ? item.created_at : 0,
      }
      if (typeof item.task_id === "string") art.task_id = item.task_id
      if (typeof item.notes === "string") art.notes = item.notes
      board.artifacts.push(art)
    }
  }
  if (Array.isArray(raw.events)) {
    for (const e of raw.events) {
      if (!e || typeof e !== "object") continue
      const item = e as Partial<BusEvent>
      if (typeof item.at !== "number" || typeof item.op !== "string") continue
      const ev: BusEvent = {
        at: item.at,
        op: item.op,
        detail: typeof item.detail === "string" ? item.detail : "",
      }
      if (typeof item.agent === "string") ev.agent = item.agent
      board.events.push(ev)
    }
  }
  return board
}

/**
 * Parse storage into a BoardRegistry.
 * Backward compatible: a bare Board (plan/tasks/facts/…) becomes the default board.
 */
export function parseRegistry(value: unknown): BoardRegistry {
  if (value === null || typeof value !== "object") return emptyRegistry()

  if (isBoardRegistry(value)) {
    const raw = value as { current: string; boards: Record<string, unknown> }
    const boards: Record<string, Board> = {}
    for (const [id, b] of Object.entries(raw.boards)) {
      const key = id.trim()
      if (!key) continue
      boards[key] = parseBoard(b)
    }
    let current = (raw.current ?? "").trim() || DEFAULT_BOARD_ID
    if (Object.keys(boards).length === 0) {
      return emptyRegistry(current === DEFAULT_BOARD_ID ? DEFAULT_BOARD_ID : current)
    }
    if (!boards[current]) {
      // Stale current pointer: fall back to default if present, else first key.
      current = boards[DEFAULT_BOARD_ID] ? DEFAULT_BOARD_ID : Object.keys(boards).sort()[0]!
    }
    return { current, boards }
  }

  // Legacy single-board payload.
  return {
    current: DEFAULT_BOARD_ID,
    boards: { [DEFAULT_BOARD_ID]: parseBoard(value) },
  }
}

/** Active board; creates an empty board if the current id is missing. */
export function getCurrentBoard(registry: BoardRegistry): Board {
  const id = (registry.current ?? "").trim() || DEFAULT_BOARD_ID
  let board = registry.boards[id]
  if (!board) {
    board = emptyBoard()
    registry.boards[id] = board
    registry.current = id
  }
  return board
}

/** Sorted board ids. */
export function listBoardIds(registry: BoardRegistry): string[] {
  return Object.keys(registry.boards).sort()
}

/** Ensure a board exists under id; returns it without changing current. */
export function ensureBoard(registry: BoardRegistry, id: string): Board {
  const boardId = id?.trim() || DEFAULT_BOARD_ID
  let board = registry.boards[boardId]
  if (!board) {
    board = emptyBoard()
    registry.boards[boardId] = board
  }
  return board
}

/**
 * Point current at id. Creates an empty board if missing.
 * Does not write a board event (use switchBoard when you need audit opts).
 */
export function switchToBoard(registry: BoardRegistry, id: string): void {
  const boardId = id?.trim()
  if (!boardId) throw new Error("board id required")
  ensureBoard(registry, boardId)
  registry.current = boardId
}

export type SwitchBoardOpts = {
  /** Create board if missing (default true). */
  create?: boolean
  actor?: string
  at?: number
}

/**
 * Switch the current board pointer (returns the board; optional event).
 * Creates an empty board when missing unless create=false.
 */
export function switchBoard(
  registry: BoardRegistry,
  id: string,
  opts?: SwitchBoardOpts,
): Board {
  const boardId = id?.trim()
  if (!boardId) throw new Error("board id required")
  const create = opts?.create !== false
  if (!registry.boards[boardId]) {
    if (!create) throw new Error(`unknown board ${boardId}`)
    registry.boards[boardId] = emptyBoard()
  }
  registry.current = boardId
  const board = registry.boards[boardId]!
  const at = opts?.at ?? Date.now()
  pushEvent(board, "board_switch", `current=${boardId}`, opts?.actor, at)
  return board
}

/**
 * Remove a non-current board. Refuses to delete the active board.
 */
export function removeBoard(registry: BoardRegistry, id: string): void {
  const boardId = id?.trim()
  if (!boardId) throw new Error("board id required")
  if (!registry.boards[boardId]) throw new Error(`unknown board ${boardId}`)
  if (boardId === registry.current) {
    throw new Error(`cannot remove current board ${boardId}; switch first`)
  }
  delete registry.boards[boardId]
}

/** JSON-safe registry snapshot for storage. */
export function registryToJson(registry: BoardRegistry): BoardRegistry {
  const boards: Record<string, Board> = {}
  for (const [id, b] of Object.entries(registry.boards)) {
    boards[id] = boardToJson(b)
  }
  return {
    current: registry.current,
    boards,
  }
}

/** Human-readable board list (* marks current). */
export function renderBoardList(registry: BoardRegistry): string {
  const ids = listBoardIds(registry)
  if (!ids.length) return "(no boards)"
  return ids
    .map((id) => {
      const mark = id === registry.current ? "*" : " "
      const b = registry.boards[id] ?? emptyBoard()
      const plan = b.plan ? `plan v${b.plan.version}` : "no plan"
      const open = listTasks(b, { status: ["pending", "running", "blocked"] }).length
      return `${mark} ${id} (${plan}, open=${open})`
    })
    .join("\n")
}

function coerceTask(value: unknown): Task | null {
  if (!value || typeof value !== "object") return null
  const t = value as Partial<Task>
  if (typeof t.id !== "string" || !t.id.trim()) return null
  if (typeof t.title !== "string" || !t.title.trim()) return null
  if (typeof t.goal !== "string") return null
  if (!TASK_AGENTS.includes(t.agent as TaskAgent)) return null
  if (!TASK_STATUSES.includes(t.status as TaskStatus)) return null
  const task: Task = {
    id: t.id.trim(),
    plan_version: typeof t.plan_version === "number" ? t.plan_version : 1,
    title: t.title.trim(),
    agent: t.agent as TaskAgent,
    status: t.status as TaskStatus,
    goal: t.goal,
    updated_at: typeof t.updated_at === "number" ? t.updated_at : 0,
  }
  if (typeof t.constraints === "string") task.constraints = t.constraints
  if (typeof t.acceptance === "string") task.acceptance = t.acceptance
  if (typeof t.inputs === "string") task.inputs = t.inputs
  if (typeof t.result_summary === "string") task.result_summary = t.result_summary
  if (typeof t.failure_signature === "string") task.failure_signature = t.failure_signature
  if (typeof t.blocked_reason === "string") task.blocked_reason = t.blocked_reason
  if (typeof t.updated_by === "string") task.updated_by = t.updated_by
  return task
}

export function pushEvent(
  board: Board,
  op: string,
  detail: string,
  agent?: string,
  at = Date.now(),
): void {
  if (detail.length > MAX_EVENT_DETAIL_SIZE) {
    throw new Error(`event detail too large (max ${MAX_EVENT_DETAIL_SIZE} bytes)`)
  }
  board.events.push({ at, op, detail, ...(agent ? { agent } : {}) })
  if (board.events.length > MAX_EVENTS) {
    board.events = board.events.slice(-MAX_EVENTS)
  }
}

export type PlanSetInput = {
  goal: string
  done_criteria?: string[]
  blocked_criteria?: string[]
  supersede_reason?: string
  /**
   * Board id to place this plan on. When using setPlanOnRegistry, switches
   * current board to this id (creates if missing). Empty/omitted → "default".
   */
  project?: string
  tasks?: Array<{
    id?: string
    title: string
    agent: TaskAgent
    goal: string
    constraints?: string
    acceptance?: string
    inputs?: string
  }>
  actor?: string
  at?: number
}

/** Normalize project/board id; empty or missing → DEFAULT_BOARD_ID. */
export function resolveProjectId(project?: string | null): string {
  const id = project?.trim()
  return id || DEFAULT_BOARD_ID
}

/**
 * Switch/create board from input.project (default "default"), then setPlan
 * on the current board. Prefer this from bus_plan_set over bare setPlan.
 */
export function setPlanOnRegistry(registry: BoardRegistry, input: PlanSetInput): Board {
  const boardId = resolveProjectId(input.project)
  switchToBoard(registry, boardId)
  const board = getCurrentBoard(registry)
  return setPlan(board, { ...input, project: boardId })
}

/** Set or supersede the active plan. Existing plan requires supersede_reason. */
export function setPlan(board: Board, input: PlanSetInput): Board {
  const goal = input.goal?.trim()
  if (!goal) throw new Error("bus_plan_set requires non-empty goal")
  const at = input.at ?? Date.now()
  const actor = input.actor ?? "unknown"

  if (board.plan && !input.supersede_reason?.trim()) {
    throw new Error(
      `active plan v${board.plan.version} exists; pass supersede_reason to replace it (do not silently rewrite)`,
    )
  }

  const version = board.plan ? board.plan.version + 1 : 1
  const plan: Plan = {
    version,
    goal,
    done_criteria: (input.done_criteria ?? []).map((s) => String(s).trim()).filter(Boolean),
    blocked_criteria: (input.blocked_criteria ?? [])
      .map((s) => String(s).trim())
      .filter(Boolean),
    project: resolveProjectId(input.project),
    updated_at: at,
    updated_by: actor,
  }
  if (input.supersede_reason?.trim()) {
    plan.supersede_reason = input.supersede_reason.trim()
  }

  // Keep completed/cancelled history from prior plan; drop open tasks from old plan.
  const retained = board.tasks.filter(
    (t) => t.status === "done" || t.status === "cancelled" || t.plan_version === version,
  )

  const nextTasks: Task[] = [...retained]
  const seed = input.tasks ?? []
  seed.forEach((s, i) => {
    if (!TASK_AGENTS.includes(s.agent)) {
      throw new Error(`task #${i + 1}: invalid agent (expected ${TASK_AGENTS.join("|")})`)
    }
    const title = s.title?.trim()
    const tgoal = s.goal?.trim()
    if (!title) throw new Error(`task #${i + 1}: title required`)
    if (!tgoal) throw new Error(`task #${i + 1}: goal required`)
    const id = (s.id?.trim() || `T${i + 1}`).toUpperCase()
    if (nextTasks.some((t) => t.id === id && t.plan_version === version)) {
      throw new Error(`duplicate task id ${id} in new plan`)
    }
    const task: Task = {
      id,
      plan_version: version,
      title,
      agent: s.agent,
      status: "pending",
      goal: tgoal,
      updated_at: at,
      updated_by: actor,
    }
    if (s.constraints?.trim()) task.constraints = s.constraints.trim()
    if (s.acceptance?.trim()) task.acceptance = s.acceptance.trim()
    if (s.inputs?.trim()) task.inputs = s.inputs.trim()
    nextTasks.push(task)
  })

  board.plan = plan
  board.tasks = nextTasks
  pushEvent(
    board,
    "plan_set",
    `v${version}: ${goal.slice(0, 120)}${seed.length ? ` (+${seed.length} tasks)` : ""}`,
    actor,
    at,
  )
  return board
}

export type TaskUpsertInput = {
  id?: string
  title: string
  agent: TaskAgent
  goal: string
  status?: TaskStatus
  constraints?: string
  acceptance?: string
  inputs?: string
  actor?: string
  at?: number
}

export function upsertTask(board: Board, input: TaskUpsertInput): Task {
  if (!TASK_AGENTS.includes(input.agent)) {
    throw new Error(`invalid agent (expected ${TASK_AGENTS.join("|")})`)
  }
  const title = input.title?.trim()
  const goal = input.goal?.trim()
  if (!title) throw new Error("title required")
  if (!goal) throw new Error("goal required")
  const at = input.at ?? Date.now()
  const actor = input.actor ?? "unknown"
  const planVersion = board.plan?.version ?? 1

  let id = input.id?.trim().toUpperCase()
  if (!id) {
    const nums = board.tasks
      .map((t) => /^T(\d+)$/i.exec(t.id)?.[1])
      .filter(Boolean)
      .map((n) => Number(n))
    const next = (nums.length ? Math.max(...nums) : 0) + 1
    id = `T${next}`
  }

  const existing = board.tasks.find((t) => t.id === id)
  if (existing) {
    existing.title = title
    existing.agent = input.agent
    existing.goal = goal
    existing.plan_version = planVersion
    existing.updated_at = at
    existing.updated_by = actor
    if (input.constraints !== undefined) {
      existing.constraints = input.constraints.trim() || undefined
    }
    if (input.acceptance !== undefined) {
      existing.acceptance = input.acceptance.trim() || undefined
    }
    if (input.inputs !== undefined) {
      existing.inputs = input.inputs.trim() || undefined
    }
    if (input.status) {
      applyStatus(existing, input.status, { actor, at })
    }
    pushEvent(board, "task_upsert", `${id} updated`, actor, at)
    return existing
  }

  const status = input.status ?? "pending"
  if (!TASK_STATUSES.includes(status)) throw new Error(`invalid status ${status}`)
  const task: Task = {
    id,
    plan_version: planVersion,
    title,
    agent: input.agent,
    status,
    goal,
    updated_at: at,
    updated_by: actor,
  }
  if (input.constraints?.trim()) task.constraints = input.constraints.trim()
  if (input.acceptance?.trim()) task.acceptance = input.acceptance.trim()
  if (input.inputs?.trim()) task.inputs = input.inputs.trim()
  board.tasks.push(task)
  pushEvent(board, "task_upsert", `${id} created (${status})`, actor, at)
  return task
}

export type TaskUpdateInput = {
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
  actor?: string
  at?: number
}

function applyStatus(
  task: Task,
  next: TaskStatus,
  opts: { actor: string; at: number; blocked_reason?: string },
): void {
  if (task.status === next) return
  const allowed = ALLOWED[task.status]
  if (!allowed.includes(next)) {
    throw new Error(
      `illegal status transition ${task.id}: ${task.status} -> ${next} (allowed: ${allowed.join(", ") || "none"})`,
    )
  }
  if (next === "blocked" && !opts.blocked_reason?.trim() && !task.blocked_reason) {
    throw new Error(`${task.id}: blocked_reason required when status=blocked`)
  }
  task.status = next
  task.updated_at = opts.at
  task.updated_by = opts.actor
  if (next === "blocked" && opts.blocked_reason?.trim()) {
    task.blocked_reason = opts.blocked_reason.trim()
  }
  if (next === "done" || next === "cancelled") {
    // keep blocked_reason for history if any
  }
  if (next === "pending" || next === "running") {
    if (next === "running") task.blocked_reason = undefined
  }
}

export function updateTask(board: Board, input: TaskUpdateInput): Task {
  const id = input.id?.trim().toUpperCase()
  if (!id) throw new Error("id required")
  const task = board.tasks.find((t) => t.id === id)
  if (!task) throw new Error(`unknown task ${id}`)
  const at = input.at ?? Date.now()
  const actor = input.actor ?? "unknown"

  if (input.title?.trim()) task.title = input.title.trim()
  if (input.goal?.trim()) task.goal = input.goal.trim()
  if (input.constraints !== undefined) {
    task.constraints = input.constraints.trim() || undefined
  }
  if (input.acceptance !== undefined) {
    task.acceptance = input.acceptance.trim() || undefined
  }
  if (input.inputs !== undefined) {
    task.inputs = input.inputs.trim() || undefined
  }
  if (input.result_summary !== undefined) {
    task.result_summary = input.result_summary.trim() || undefined
  }
  if (input.failure_signature !== undefined) {
    task.failure_signature = input.failure_signature.trim() || undefined
  }
  if (input.blocked_reason !== undefined) {
    task.blocked_reason = input.blocked_reason.trim() || undefined
  }
  if (input.status) {
    applyStatus(task, input.status, {
      actor,
      at,
      blocked_reason: input.blocked_reason ?? task.blocked_reason,
    })
  } else {
    task.updated_at = at
    task.updated_by = actor
  }
  pushEvent(
    board,
    "task_update",
    `${id} -> ${task.status}${task.result_summary ? `: ${task.result_summary.slice(0, 80)}` : ""}`,
    actor,
    at,
  )
  return task
}

export function putFact(
  board: Board,
  input: {
    key: string
    value: string
    source_agent?: string
    task_id?: string
    at?: number
  },
): Fact {
  const key = input.key?.trim()
  if (!key) throw new Error("key required")
  if (typeof input.value !== "string") throw new Error("value required")

  if (input.source_agent && ["manager", "system"].includes(input.source_agent)) {
    // Only trusted internal systems may claim these identities
    throw new Error("source_agent \"" + input.source_agent + "\" is reserved");
  }

  if (board.facts.length >= MAX_FACTS) { throw new Error("fact limit exceeded (MAX_FACTS=" + MAX_FACTS + "). Consider pruning or using multiple boards.") }
  const at = input.at ?? Date.now()
  const existing = board.facts.find((f) => f.key === key)
  if (existing) {
    existing.value = input.value
    existing.created_at = at
    if (input.source_agent) existing.source_agent = input.source_agent
    if (input.task_id) existing.task_id = input.task_id
    pushEvent(board, "fact_put", `update ${key}`, input.source_agent, at)
    return existing
  }
  const fact: Fact = {
    key,
    value: input.value,
    created_at: at,
  }
  if (input.source_agent) fact.source_agent = input.source_agent
  if (input.task_id) fact.task_id = input.task_id
  board.facts.push(fact)
  pushEvent(board, "fact_put", `add ${key}`, input.source_agent, at)
  return fact
}

export function getFact(board: Board, key: string): Fact | undefined {
  return board.facts.find((f) => f.key === key.trim())
}

export function addArtifact(
  board: Board,
  input: {
    path: string
    kind?: string
    task_id?: string
    notes?: string
    actor?: string
    at?: number
  },
): Artifact {
  const path = input.path?.trim()
  if (!path) throw new Error("path required")
  if (board.artifacts.length >= MAX_ARTIFACTS) { throw new Error("artifact limit exceeded (MAX_ARTIFACTS=" + MAX_ARTIFACTS + "). Only store critical outputs.") }
  const at = input.at ?? Date.now()
  const n = board.artifacts.length + 1
  const art: Artifact = {
    id: `A${n}`,
    path,
    kind: (input.kind?.trim() || "file") as string,
    created_at: at,
  }
  if (input.task_id?.trim()) art.task_id = input.task_id.trim().toUpperCase()
  if (input.notes?.trim()) art.notes = input.notes.trim()
  board.artifacts.push(art)
  pushEvent(board, "artifact_add", `${art.id} ${path}`, input.actor, at)
  return art
}

export function listTasks(
  board: Board,
  filter?: { status?: TaskStatus | TaskStatus[]; plan_version?: number },
): Task[] {
  let tasks = board.tasks
  if (filter?.plan_version != null) {
    tasks = tasks.filter((t) => t.plan_version === filter.plan_version)
  }
  if (filter?.status) {
    const set = new Set(Array.isArray(filter.status) ? filter.status : [filter.status])
    tasks = tasks.filter((t) => set.has(t.status))
  }
  return tasks
}

export function getTask(board: Board, id: string): Task | undefined {
  return board.tasks.find((t) => t.id === id.trim().toUpperCase())
}

export function clearBoard(board: Board, actor = "unknown", at = Date.now()): Board {
  board.plan = null
  board.tasks = []
  board.facts = []
  board.artifacts = []
  pushEvent(board, "clear", "board cleared", actor, at)
  return board
}

export function renderTask(task: Task): string {
  const lines = [
    `## ${task.id} [${task.status}] ${task.title}`,
    `agent: ${task.agent}`,
    `plan_version: ${task.plan_version}`,
    `goal: ${task.goal}`,
  ]
  if (task.constraints) lines.push(`constraints: ${task.constraints}`)
  if (task.acceptance) lines.push(`acceptance: ${task.acceptance}`)
  if (task.inputs) lines.push(`inputs: ${task.inputs}`)
  if (task.result_summary) lines.push(`result_summary: ${task.result_summary}`)
  if (task.failure_signature) lines.push(`failure_signature: ${task.failure_signature}`)
  if (task.blocked_reason) lines.push(`blocked_reason: ${task.blocked_reason}`)
  return lines.join("\n")
}

export function renderHandoff(board: Board, taskId: string): string {
  const task = getTask(board, taskId)
  if (!task) throw new Error(`unknown task ${taskId}`)
  const facts = board.facts.filter((f) => !f.task_id || f.task_id === task.id)
  const arts = board.artifacts.filter((a) => a.task_id === task.id)
  const lines = [
    `task_id: ${task.id}`,
    `Load full context with bus_task_get({ id: "${task.id}" }) and bus_fact_list if needed.`,
    `Do not invent plan steps. Do not inspect parent sessions.`,
    "",
    renderTask(task),
  ]
  if (board.plan) {
    lines.push("", `## Active plan v${board.plan.version}`, `goal: ${board.plan.goal}`)
  }
  if (facts.length) {
    lines.push("", "## Facts")
    for (const f of facts.slice(0, 40)) {
      lines.push(`- ${f.key}: ${f.value}`)
    }
  }
  if (arts.length) {
    lines.push("", "## Artifacts")
    for (const a of arts) {
      lines.push(`- ${a.id} (${a.kind}) ${a.path}${a.notes ? ` — ${a.notes}` : ""}`)
    }
  }
  lines.push(
    "",
    "## Before you finish",
    `Call bus_task_update with id=${task.id}, status=done|blocked, and result_summary.`,
    "Put durable findings in bus_fact_put. Record output paths with bus_artifact_add.",
  )
  return lines.join("\n")
}

/**
 * Human-readable status for one board.
 * Optional boardId prefixes the output (used by bus_status / multi-board).
 */
export function renderStatus(board: Board, boardId?: string): string {
  const lines: string[] = []
  if (boardId) lines.push(`Board: ${boardId}`)
  if (!board.plan) {
    lines.push("No active plan.")
  } else {
    lines.push(`Plan v${board.plan.version}: ${board.plan.goal}`)
    if (board.plan.done_criteria.length) {
      lines.push("Done: " + board.plan.done_criteria.map((c) => `• ${c}`).join(" "))
    }
  }
  const open = listTasks(board, {
    status: ["pending", "running", "blocked"],
  })
  if (!open.length) {
    lines.push("Open tasks: (none)")
  } else {
    lines.push("Open tasks:")
    for (const t of open) {
      const mark =
        t.status === "running" ? "[•]" : t.status === "blocked" ? "[!]" : "[ ]"
      lines.push(`  ${mark} ${t.id} (${t.agent}) ${t.title}`)
    }
  }
  const done = listTasks(board, { status: "done" }).length
  const cancelled = listTasks(board, { status: "cancelled" }).length
  lines.push(`Closed: ${done} done, ${cancelled} cancelled | facts=${board.facts.length} artifacts=${board.artifacts.length}`)
  return lines.join("\n")
}

/** JSON-safe snapshot for storage. */
export function boardToJson(board: Board): Board {
  return {
    plan: board.plan ? { ...board.plan } : null,
    tasks: board.tasks.map((t) => ({ ...t })),
    facts: board.facts.map((f) => ({ ...f })),
    artifacts: board.artifacts.map((a) => ({ ...a })),
    events: board.events.map((e) => ({ ...e })),
  }
}
