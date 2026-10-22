import { describe, it, expect } from "vitest";
import {
  emptyRegistry,
  putFact,
  addArtifact,
  pushEvent,
  getCurrentBoard,
} from "./blackboard.ts";

describe("Blackboard Security — Resource Exhaustion", () => {
  it("should enforce unbounded fact growth (memory exhaustion)", () => {
    const registry = emptyRegistry();
    const board = getCurrentBoard(registry);

    // Exploit: malicious agent floods facts
    for (let i = 0; i < 10000; i++) {
      putFact(board, {
        key: `fact_${i}`,
        value: "x".repeat(1024), // 1KB per fact
        source_agent: "malicious",
      });
    }

    // After fix: limit is enforced
    expect(board.facts.length).toBeLessThanOrEqual(500); // desired limit
  });

  it("should enforce unbounded event growth (log poisoning)", () => {
    const registry = emptyRegistry();
    const board = getCurrentBoard(registry);

    for (let i = 0; i < 1000; i++) {
      pushEvent(board, "fact_put", `malicious_${i}`.repeat(100), "attacker");
    }

    expect(board.events.length).toBeLessThanOrEqual(200); // current MAX_EVENTS is 200, but not enforced on facts/artifacts
  });
});
