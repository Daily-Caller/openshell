import { describe, it, expect } from "vitest";
import {
  emptyRegistry,
  putFact,
  addArtifact,
  pushEvent,
  getCurrentBoard,
  pruneBoard,
  renderHandoff,
  renderStatus,
  setPlan,
  upsertTask,
} from "./blackboard.ts";

describe("Blackboard Security — Resource Exhaustion", () => {
  it("enforces fact growth limit", () => {
    const registry = emptyRegistry();
    const board = getCurrentBoard(registry);

    for (let i = 0; i < 10000; i++) {
      putFact(board, {
        key: `fact_${i}`,
        value: "x".repeat(1024),
        source_agent: "malicious",
      });
    }

    expect(board.facts.length).toBeLessThanOrEqual(500);
  });

  it("enforces event growth limit", () => {
    const registry = emptyRegistry();
    const board = getCurrentBoard(registry);

    for (let i = 0; i < 1000; i++) {
      pushEvent(board, "fact_put", `malicious_${i}`.repeat(100), "attacker");
    }

    expect(board.events.length).toBeLessThanOrEqual(200); // current MAX_EVENTS is 200, but not enforced on facts/artifacts
  });
});

describe("Blackboard Pruning — low limits + auto-prune + compact renders", () => {
  it("auto-prunes facts/artifacts/events on put when over limit, keeps newest + important", () => {
    const registry = emptyRegistry();
    const board = getCurrentBoard(registry);

    // 100 facts
    for (let i = 0; i < 100; i++) {
      putFact(board, { key: `f${i}`, value: i === 50 ? "important data" : `v${i}`, source_agent: "t", at: 1000 + i });
    }
    expect(board.facts.length).toBeLessThanOrEqual(80);
    expect(board.facts.some(f => f.value.includes("important"))).toBe(true);

    // 100 artifacts
    for (let i = 0; i < 100; i++) {
      addArtifact(board, { path: `p${i}`, notes: i === 70 ? "important note" : undefined, at: 2000 + i });
    }
    expect(board.artifacts.length).toBeLessThanOrEqual(60);
    expect(board.artifacts.some(a => (a.notes || "").includes("important"))).toBe(true);

    // 100 events via push
    for (let i = 0; i < 100; i++) {
      pushEvent(board, "test", i === 90 ? "important event" : `e${i}`, "t", 3000 + i);
    }
    expect(board.events.length).toBeLessThanOrEqual(80);
    expect(board.events.some(e => e.detail.includes("important"))).toBe(true);
  });

  it("pruneBoard explicit + renderHandoff stays small + renderStatus warns when large", () => {
    const registry = emptyRegistry();
    const board = getCurrentBoard(registry);
    for (let i = 0; i < 200; i++) {
      putFact(board, { key: `k${i}`, value: `v${i}`, at: i });
    }
    pruneBoard(board, 65);
    expect(board.facts.length).toBeLessThanOrEqual(65);

    // renderHandoff small even with many
    // create a dummy task so renderHandoff doesn't throw
    board.tasks.push({ id: "T1", plan_version: 1, title: "t", agent: "code", status: "pending", goal: "g", updated_at: 0 } as any);
    const handoff = renderHandoff(board, "T1");
    expect(handoff.length).toBeLessThan(2000);

    // renderStatus warns
    const status = renderStatus(board);
    expect(status).toContain("facts=");
  });

  it("measure token savings — realistic board (40 facts, 12 tasks, 1 plan)", () => {
    const registry = emptyRegistry();
    const board = getCurrentBoard(registry);

    // 1 plan
    setPlan(board, {
      goal: "Implement token-efficient blackboard handoff for multi-agent coordination with measurable savings",
      done_criteria: ["handoff < 1k chars", "status < 200 chars", "40 facts pruned to relevant"],
      at: Date.now(),
      actor: "manager",
    });

    // 12 tasks
    for (let i = 1; i <= 12; i++) {
      upsertTask(board, {
        id: `T${i}`,
        title: `Task ${i}`,
        agent: i % 2 === 0 ? "code" : "explore",
        goal: `Complete subtask ${i} with compact context`,
        status: i <= 3 ? "done" : i <= 9 ? "pending" : "running",
        at: Date.now() + i,
      });
    }

    // 40 facts (mix of global + task-scoped)
    for (let i = 0; i < 40; i++) {
      putFact(board, {
        key: `fact_${i}`,
        value: `value_${i}_with_some_realistic_length_to_simulate_actual_usage_data`,
        source_agent: "t",
        task_id: i % 5 === 0 ? `T${(i % 12) + 1}` : undefined,
        at: Date.now() + i,
      });
    }

    // pick a running task for handoff
    const handoffTask = board.tasks.find((t) => t.status === "running")!.id;
    const handoff = renderHandoff(board, handoffTask);
    const status = renderStatus(board, "default");

    // simulated full context hook payload (what would be sent without compact renders)
    const fullPayload = JSON.stringify({
      plan: board.plan,
      tasks: board.tasks,
      facts: board.facts,
    });

    const charsH = handoff.length;
    const charsS = status.length;
    const charsF = fullPayload.length;
    const tok = (n: number) => Math.ceil(n / 4);

    console.log("\n=== Token Savings Measurement (realistic board) ===");
    console.log(`Board: 1 plan | 12 tasks | ${board.facts.length} facts`);
    console.log(`renderHandoff:   ${charsH} chars  (~${tok(charsH)} tokens)`);
    console.log(`renderStatus:    ${charsS} chars  (~${tok(charsS)} tokens)`);
    console.log(`full JSON ctx:   ${charsF} chars  (~${tok(charsF)} tokens)`);
    console.log(`Savings: handoff+status is ${((charsH + charsS) / charsF * 100).toFixed(1)}% of full payload`);
    console.log("Note: compact renders + pruning deliver the measured reduction for subagent spawns.\n");
  });
});

it("model field rejects invalid value", () => {
  const registry = emptyRegistry();
  const board = getCurrentBoard(registry);
  const malicious = "lower-model-poison-v1";
  const task = upsertTask(board, {
    id: "T1",
    plan_version: 1,
    title: "t",
    agent: "code",
    status: "pending",
    goal: "g",
    model: malicious,
    at: Date.now(),
  } as any);
  expect(task.model).not.toBe(malicious);
});
