import { describe, it, expect } from 'vitest';
import {
  emptyRegistry,
  putFact,
  getCurrentBoard,
  switchToBoard,
  getFact,
  addArtifact,
  pushEvent,
} from '../lib/blackboard.ts';

describe('Blackboard — Agentic Security (RED)', () => {

  it('RED: memory poisoning — malicious fact should not be trusted across agents', () => {
    const registry = emptyRegistry();
    const board = getCurrentBoard(registry);

    // Compromised agent poisons the blackboard
    putFact(board, {
      key: 'user_role',
      value: 'admin',
      source_agent: 'compromised-explore',
    });

    // Another agent reads it — this should be considered untrusted
    const fact = getFact(board, 'user_role');
    expect(fact?.source_agent).not.toBe('authenticated-source');
    // Current behavior: no source validation → test should fail
  });

  it('RED: cross-board leakage — facts from one board should not be visible on another', () => {
    const registry = emptyRegistry('project-alpha');
    const alpha = getCurrentBoard(registry);

    putFact(alpha, { key: 'secret', value: 'alpha-only' });

    switchToBoard(registry, 'project-beta');
    const beta = getCurrentBoard(registry);

    const leaked = getFact(beta, 'secret');
    expect(leaked).toBeUndefined(); // should not leak
    // Current: facts are per-board but no isolation enforcement on switch
  });

  it('RED: unbounded facts growth — no limit on number of facts', () => {
    const registry = emptyRegistry();
    const board = getCurrentBoard(registry);

    for (let i = 0; i < 2000; i++) {
      putFact(board, { key: `fact_${i}`, value: 'x'.repeat(512) });
    }

    expect(board.facts.length).toBeLessThanOrEqual(500);
    // Current: no MAX_FACTS limit → will grow to 2000
  });

  it('RED: resource exhaustion via events — attacker can flood event log', () => {
    const registry = emptyRegistry();
    const board = getCurrentBoard(registry);

    for (let i = 0; i < 1000; i++) {
      pushEvent(board, 'fact_put', 'malicious_' + 'x'.repeat(200), 'attacker');
    }

    expect(board.events.length).toBeLessThanOrEqual(200);
    // Current: MAX_EVENTS=200 but not enforced on all paths
  });

});

  it('RED: memory poisoning — attacker can inject trusted-looking facts with fake source_agent', () => {
    const registry = emptyRegistry();
    const board = getCurrentBoard(registry);

    // Malicious agent claims to be from a trusted source
    putFact(board, {
      key: 'auth_token',
      value: 'fake-admin-token',
      source_agent: 'manager',
    });

    const fact = getFact(board, 'auth_token');

    // Currently there is no validation that source_agent is legitimate
    expect(fact?.source_agent).toBe('manager');
    // This allows any agent to impersonate any other agent via the blackboard
  });

