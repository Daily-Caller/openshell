/** Shared agent blackboard — ESM mirror of blackboard.ts for node verify. */

export const TASK_STATUSES = ["pending", "running", "done", "blocked", "cancelled"]
export const TASK_AGENTS = ["explore", "code", "plan", "manager-shell"]

/** Default board id for single-board / legacy storage. */
export const DEFAULT_BOARD_ID = "default"

const MAX_EVENTS = 200

const ALLOWED = {
  pending: ["running", "cancelled", "done", "blocked"],
  running: ["done", "blocked", "pending", "cancelled"],
  blocked: ["pending", "running", "cancelled", "done"],
  done: [],
  cancelled: ["pending"],
}

export function emptyBoard() {
  return { plan: null, tasks: [], facts: [], artifacts: [], events: [] }
}

/** Fresh registry with a single empty default board selected. */
export function emptyRegistry(currentId = DEFAULT_BOARD_ID) {
  const id = (currentId && String(currentId).trim()) || DEFAULT_BOARD_ID
  return { current: id, boards: { [id]: emptyBoard() } }
}

/** True when value has the multi-board shape (current + boards map). */
export function isBoardRegistry(value) {
  if (value === null || typeof value !== "object") return false
  return (
    typeof value.current === "string" &&
    value.boards !== null &&
    typeof value.boards === "object" &&
    !Array.isArray(value.boards)
  )
}

export function parseBoard(value) {
  if (value === null || typeof value !== "object") return emptyBoard()
  // Avoid treating a registry payload as a bare board.
  if (isBoardRegistry(value)) return emptyBoard()
  const board = emptyBoard()
  if (value.plan && typeof value.plan === "object" && typeof value.plan.version === "number") {
    board.plan = {
      version: value.plan.version,
      goal: String(value.plan.goal ?? ""),
      done_criteria: Array.isArray(value.plan.done_criteria) ? value.plan.done_criteria.filter((x) => typeof x === "string") : [],
      blocked_criteria: Array.isArray(value.plan.blocked_criteria) ? value.plan.blocked_criteria.filter((x) => typeof x === "string") : [],
      updated_at: typeof value.plan.updated_at === "number" ? value.plan.updated_at : 0,
      updated_by: typeof value.plan.updated_by === "string" ? value.plan.updated_by : "unknown",
    }
    if (typeof value.plan.supersede_reason === "string") board.plan.supersede_reason = value.plan.supersede_reason
    if (typeof value.plan.project === "string" && value.plan.project.trim()) {
      board.plan.project = value.plan.project.trim()
    }
  }
  if (Array.isArray(value.tasks)) {
    for (const t of value.tasks) {
      if (!t || typeof t.id !== "string" || !TASK_AGENTS.includes(t.agent) || !TASK_STATUSES.includes(t.status)) continue
      board.tasks.push({ ...t, id: t.id.trim() })
    }
  }
  if (Array.isArray(value.facts)) {
    for (const f of value.facts) {
      if (!f || typeof f.key !== "string" || typeof f.value !== "string") continue
      board.facts.push({ ...f })
    }
  }
  if (Array.isArray(value.artifacts)) {
    for (const a of value.artifacts) {
      if (!a || typeof a.id !== "string" || typeof a.path !== "string") continue
      board.artifacts.push({ ...a })
    }
  }
  if (Array.isArray(value.events)) {
    for (const e of value.events) {
      if (!e || typeof e.at !== "number" || typeof e.op !== "string") continue
      board.events.push({ ...e })
    }
  }
  return board
}

/**
 * Parse storage into a BoardRegistry.
 * Backward compatible: a bare Board (plan/tasks/facts/…) becomes the default board.
 */
export function parseRegistry(value) {
  if (value === null || typeof value !== "object") return emptyRegistry()

  if (isBoardRegistry(value)) {
    const boards = {}
    for (const [id, b] of Object.entries(value.boards)) {
      const key = id.trim()
      if (!key) continue
      boards[key] = parseBoard(b)
    }
    let current = (value.current ?? "").trim() || DEFAULT_BOARD_ID
    if (Object.keys(boards).length === 0) {
      return emptyRegistry(current === DEFAULT_BOARD_ID ? DEFAULT_BOARD_ID : current)
    }
    if (!boards[current]) {
      current = boards[DEFAULT_BOARD_ID] ? DEFAULT_BOARD_ID : Object.keys(boards).sort()[0]
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
export function getCurrentBoard(registry) {
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
export function listBoardIds(registry) {
  return Object.keys(registry.boards).sort()
}

/** Ensure a board exists under id; returns it without changing current. */
export function ensureBoard(registry, id) {
  const boardId = (id && String(id).trim()) || DEFAULT_BOARD_ID
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
export function switchToBoard(registry, id) {
  const boardId = id && String(id).trim()
  if (!boardId) throw new Error("board id required")
  ensureBoard(registry, boardId)
  registry.current = boardId
}

/**
 * Switch the current board pointer (returns the board; optional event).
 * Creates an empty board when missing unless create=false.
 */
export function switchBoard(registry, id, opts) {
  const boardId = id && String(id).trim()
  if (!boardId) throw new Error("board id required")
  const create = opts?.create !== false
  if (!registry.boards[boardId]) {
    if (!create) throw new Error(`unknown board ${boardId}`)
    registry.boards[boardId] = emptyBoard()
  }
  registry.current = boardId
  const board = registry.boards[boardId]
  const at = opts?.at ?? Date.now()
  pushEvent(board, "board_switch", `current=${boardId}`, opts?.actor, at)
  return board
}

/**
 * Remove a non-current board. Refuses to delete the active board.
 */
export function removeBoard(registry, id) {
  const boardId = id && String(id).trim()
  if (!boardId) throw new Error("board id required")
  if (!registry.boards[boardId]) throw new Error(`unknown board ${boardId}`)
  if (boardId === registry.current) {
    throw new Error(`cannot remove current board ${boardId}; switch first`)
  }
  delete registry.boards[boardId]
}

/** JSON-safe registry snapshot for storage. */
export function registryToJson(registry) {
  const boards = {}
  for (const [id, b] of Object.entries(registry.boards)) {
    boards[id] = boardToJson(b)
  }
  return { current: registry.current, boards }
}

/** Human-readable board list (* marks current). */
export function renderBoardList(registry) {
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

export function pushEvent(board, op, detail, agent, at = Date.now()) {
  board.events.push({ at, op, detail, ...(agent ? { agent } : {}) })
  if (board.events.length > MAX_EVENTS) board.events = board.events.slice(-MAX_EVENTS)
}

/** Normalize project/board id; empty or missing → DEFAULT_BOARD_ID. */
export function resolveProjectId(project) {
  const id = project && String(project).trim()
  return id || DEFAULT_BOARD_ID
}

/**
 * Switch/create board from input.project (default "default"), then setPlan
 * on the current board. Prefer this from bus_plan_set over bare setPlan.
 */
export function setPlanOnRegistry(registry, input) {
  const boardId = resolveProjectId(input.project)
  switchToBoard(registry, boardId)
  const board = getCurrentBoard(registry)
  return setPlan(board, { ...input, project: boardId })
}

export function setPlan(board, input) {
  const goal = input.goal?.trim()
  if (!goal) throw new Error("bus_plan_set requires non-empty goal")
  const at = input.at ?? Date.now()
  const actor = input.actor ?? "unknown"
  if (board.plan && !input.supersede_reason?.trim()) {
    throw new Error(`active plan v${board.plan.version} exists; pass supersede_reason to replace it (do not silently rewrite)`)
  }
  const version = board.plan ? board.plan.version + 1 : 1
  const plan = {
    version,
    goal,
    done_criteria: (input.done_criteria ?? []).map((s) => String(s).trim()).filter(Boolean),
    blocked_criteria: (input.blocked_criteria ?? []).map((s) => String(s).trim()).filter(Boolean),
    project: resolveProjectId(input.project),
    updated_at: at,
    updated_by: actor,
  }
  if (input.supersede_reason?.trim()) plan.supersede_reason = input.supersede_reason.trim()
  const retained = board.tasks.filter((t) => t.status === "done" || t.status === "cancelled" || t.plan_version === version)
  const nextTasks = [...retained]
  const seed = input.tasks ?? []
  seed.forEach((s, i) => {
    if (!TASK_AGENTS.includes(s.agent)) throw new Error(`task #${i + 1}: invalid agent`)
    const title = s.title?.trim()
    const tgoal = s.goal?.trim()
    if (!title) throw new Error(`task #${i + 1}: title required`)
    if (!tgoal) throw new Error(`task #${i + 1}: goal required`)
    const id = (s.id?.trim() || `T${i + 1}`).toUpperCase()
    if (nextTasks.some((t) => t.id === id && t.plan_version === version)) throw new Error(`duplicate task id ${id}`)
    const task = { id, plan_version: version, title, agent: s.agent, status: "pending", goal: tgoal, updated_at: at, updated_by: actor }
    if (s.constraints?.trim()) task.constraints = s.constraints.trim()
    if (s.acceptance?.trim()) task.acceptance = s.acceptance.trim()
    if (s.inputs?.trim()) task.inputs = s.inputs.trim()
    nextTasks.push(task)
  })
  board.plan = plan
  board.tasks = nextTasks
  pushEvent(board, "plan_set", `v${version}: ${goal.slice(0, 120)}`, actor, at)
  return board
}

function applyStatus(task, next, opts) {
  if (task.status === next) return
  const allowed = ALLOWED[task.status]
  if (!allowed.includes(next)) {
    throw new Error(`illegal status transition ${task.id}: ${task.status} -> ${next} (allowed: ${allowed.join(", ") || "none"})`)
  }
  if (next === "blocked" && !opts.blocked_reason?.trim() && !task.blocked_reason) {
    throw new Error(`${task.id}: blocked_reason required when status=blocked`)
  }
  task.status = next
  task.updated_at = opts.at
  task.updated_by = opts.actor
  if (next === "blocked" && opts.blocked_reason?.trim()) task.blocked_reason = opts.blocked_reason.trim()
  if (next === "running") task.blocked_reason = undefined
}

export function upsertTask(board, input) {
  if (!TASK_AGENTS.includes(input.agent)) throw new Error("invalid agent")
  const title = input.title?.trim()
  const goal = input.goal?.trim()
  if (!title) throw new Error("title required")
  if (!goal) throw new Error("goal required")
  const at = input.at ?? Date.now()
  const actor = input.actor ?? "unknown"
  const planVersion = board.plan?.version ?? 1
  let id = input.id?.trim().toUpperCase()
  if (!id) {
    const nums = board.tasks.map((t) => /^T(\d+)$/i.exec(t.id)?.[1]).filter(Boolean).map(Number)
    id = `T${(nums.length ? Math.max(...nums) : 0) + 1}`
  }
  const existing = board.tasks.find((t) => t.id === id)
  if (existing) {
    existing.title = title
    existing.agent = input.agent
    existing.goal = goal
    existing.plan_version = planVersion
    existing.updated_at = at
    existing.updated_by = actor
    if (input.constraints !== undefined) existing.constraints = input.constraints.trim() || undefined
    if (input.acceptance !== undefined) existing.acceptance = input.acceptance.trim() || undefined
    if (input.inputs !== undefined) existing.inputs = input.inputs.trim() || undefined
    if (input.status) applyStatus(existing, input.status, { actor, at })
    pushEvent(board, "task_upsert", `${id} updated`, actor, at)
    return existing
  }
  const status = input.status ?? "pending"
  const task = { id, plan_version: planVersion, title, agent: input.agent, status, goal, updated_at: at, updated_by: actor }
  if (input.constraints?.trim()) task.constraints = input.constraints.trim()
  if (input.acceptance?.trim()) task.acceptance = input.acceptance.trim()
  if (input.inputs?.trim()) task.inputs = input.inputs.trim()
  board.tasks.push(task)
  pushEvent(board, "task_upsert", `${id} created`, actor, at)
  return task
}

export function updateTask(board, input) {
  const id = input.id?.trim().toUpperCase()
  if (!id) throw new Error("id required")
  const task = board.tasks.find((t) => t.id === id)
  if (!task) throw new Error(`unknown task ${id}`)
  const at = input.at ?? Date.now()
  const actor = input.actor ?? "unknown"
  if (input.title?.trim()) task.title = input.title.trim()
  if (input.goal?.trim()) task.goal = input.goal.trim()
  if (input.constraints !== undefined) task.constraints = input.constraints.trim() || undefined
  if (input.acceptance !== undefined) task.acceptance = input.acceptance.trim() || undefined
  if (input.inputs !== undefined) task.inputs = input.inputs.trim() || undefined
  if (input.result_summary !== undefined) task.result_summary = input.result_summary.trim() || undefined
  if (input.failure_signature !== undefined) task.failure_signature = input.failure_signature.trim() || undefined
  if (input.blocked_reason !== undefined) task.blocked_reason = input.blocked_reason.trim() || undefined
  if (input.status) {
    applyStatus(task, input.status, { actor, at, blocked_reason: input.blocked_reason ?? task.blocked_reason })
  } else {
    task.updated_at = at
    task.updated_by = actor
  }
  pushEvent(board, "task_update", `${id} -> ${task.status}`, actor, at)
  return task
}

export function putFact(board, input) {
  const key = input.key?.trim()
  if (!key) throw new Error("key required")
  if (typeof input.value !== "string") throw new Error("value required")
  const at = input.at ?? Date.now()
  const existing = board.facts.find((f) => f.key === key)
  if (existing) {
    existing.value = input.value
    existing.created_at = at
    if (input.source_agent) existing.source_agent = input.source_agent
    if (input.task_id) existing.task_id = input.task_id
    return existing
  }
  const fact = { key, value: input.value, created_at: at }
  if (input.source_agent) fact.source_agent = input.source_agent
  if (input.task_id) fact.task_id = input.task_id
  board.facts.push(fact)
  return fact
}

export function getFact(board, key) {
  return board.facts.find((f) => f.key === key.trim())
}

export function addArtifact(board, input) {
  const path = input.path?.trim()
  if (!path) throw new Error("path required")
  const at = input.at ?? Date.now()
  const art = {
    id: `A${board.artifacts.length + 1}`,
    path,
    kind: input.kind?.trim() || "file",
    created_at: at,
  }
  if (input.task_id?.trim()) art.task_id = input.task_id.trim().toUpperCase()
  if (input.notes?.trim()) art.notes = input.notes.trim()
  board.artifacts.push(art)
  return art
}

export function listTasks(board, filter) {
  let tasks = board.tasks
  if (filter?.plan_version != null) tasks = tasks.filter((t) => t.plan_version === filter.plan_version)
  if (filter?.status) {
    const set = new Set(Array.isArray(filter.status) ? filter.status : [filter.status])
    tasks = tasks.filter((t) => set.has(t.status))
  }
  return tasks
}

export function getTask(board, id) {
  return board.tasks.find((t) => t.id === id.trim().toUpperCase())
}

export function clearBoard(board, actor = "unknown", at = Date.now()) {
  board.plan = null
  board.tasks = []
  board.facts = []
  board.artifacts = []
  pushEvent(board, "clear", "board cleared", actor, at)
  return board
}

export function renderTask(task) {
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

export function renderHandoff(board, taskId) {
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
  if (board.plan) lines.push("", `## Active plan v${board.plan.version}`, `goal: ${board.plan.goal}`)
  if (facts.length) {
    lines.push("", "## Facts")
    for (const f of facts.slice(0, 40)) lines.push(`- ${f.key}: ${f.value}`)
  }
  if (arts.length) {
    lines.push("", "## Artifacts")
    for (const a of arts) lines.push(`- ${a.id} (${a.kind}) ${a.path}${a.notes ? ` — ${a.notes}` : ""}`)
  }
  lines.push("", "## Before you finish", `Call bus_task_update with id=${task.id}, status=done|blocked, and result_summary.`, "Put durable findings in bus_fact_put. Record output paths with bus_artifact_add.")
  return lines.join("\n")
}

/**
 * Human-readable status for one board.
 * Optional boardId prefixes the output (used by bus_status / multi-board).
 */
export function renderStatus(board, boardId) {
  const lines = []
  if (boardId) lines.push(`Board: ${boardId}`)
  if (!board.plan) lines.push("No active plan.")
  else {
    lines.push(`Plan v${board.plan.version}: ${board.plan.goal}`)
    if (board.plan.done_criteria.length) lines.push("Done: " + board.plan.done_criteria.map((c) => `• ${c}`).join(" "))
  }
  const open = listTasks(board, { status: ["pending", "running", "blocked"] })
  if (!open.length) lines.push("Open tasks: (none)")
  else {
    lines.push("Open tasks:")
    for (const t of open) {
      const mark = t.status === "running" ? "[•]" : t.status === "blocked" ? "[!]" : "[ ]"
      lines.push(`  ${mark} ${t.id} (${t.agent}) ${t.title}`)
    }
  }
  const done = listTasks(board, { status: "done" }).length
  const cancelled = listTasks(board, { status: "cancelled" }).length
  lines.push(`Closed: ${done} done, ${cancelled} cancelled | facts=${board.facts.length} artifacts=${board.artifacts.length}`)
  return lines.join("\n")
}

export function boardToJson(board) {
  return {
    plan: board.plan ? { ...board.plan } : null,
    tasks: board.tasks.map((t) => ({ ...t })),
    facts: board.facts.map((f) => ({ ...f })),
    artifacts: board.artifacts.map((a) => ({ ...a })),
    events: board.events.map((e) => ({ ...e })),
  }
}
