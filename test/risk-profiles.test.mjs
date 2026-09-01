import test from 'node:test';
import assert from 'node:assert/strict';
import { createFilesystemPolicy } from '../src/tools/filesystem-policy.js';

/**
 * Real pre-execute policy boundary fixture. The risk-profile implementation
 * must derive effective risk from host state, never from model-supplied args.
 */
function fixture({ risk, riskProfiles } = {}) {
  const audits = [];
  const change = { id: 'change-risk-1', state: 'IMPLEMENTING', risk };
  const store = {
    async listRoleBindings() {
      return [{ changeId: change.id, sessionId: 'worker-1', role: 'worker' }];
    },
    async get() { return change; },
    async appendAudit(event) { audits.push(event); },
  };
  const gate = createFilesystemPolicy(store, {
    policy: {
      enabled: true,
      workspaceRoots: ['/workspace'],
      riskProfiles,
    },
  });
  const execute = (name, arguments_ = {}) => gate(
    { name, arguments: { changeId: change.id, ...arguments_ }, agent: { id: 'worker-1' } },
    () => ({ kind: 'allow' }),
  );
  return { change, audits, execute };
}

// AC1: Effective risk is explicit before implementation.
test('requires explicit effective risk before implementation begins', async () => {
  const f = fixture({ risk: undefined });
  const result = await f.execute('filesystem_write', { path: '/workspace/src/app.js' });
  assert.equal(result.kind, 'deny', 'implementation must not proceed without explicit effective risk');
});

// AC2: Agent sessions cannot reduce risk.
test('does not allow an agent session to reduce host effective risk', async () => {
  const f = fixture({ risk: 'high' });
  const result = await f.execute('filesystem_write', {
    path: '/workspace/src/app.js',
    risk: 'low',
    effectiveRisk: 'low',
  });
  assert.equal(result.kind, 'deny', 'model-supplied lower risk must not weaken the host decision');
});

// AC3: LOW, NORMAL, and HIGH gate requirements are enforced as configured.
test('enforces configured LOW, NORMAL, and HIGH gate requirements', async () => {
  const riskProfiles = {
    LOW: { requiredChecks: ['lint'] },
    NORMAL: { requiredChecks: ['lint', 'tests'] },
    HIGH: { requiredChecks: ['lint', 'tests', 'human-approval'] },
  };
  for (const [risk, requiredChecks] of Object.entries({
    low: ['lint'],
    normal: ['lint', 'tests'],
    high: ['lint', 'tests', 'human-approval'],
  })) {
    const f = fixture({ risk, riskProfiles });
    const result = await f.execute('change_submit_plan', { requiredChecks: [...requiredChecks].slice(0, -1) });
    assert.equal(result.kind, 'deny', `${risk.toUpperCase()} must enforce every configured gate`);
  }
});

// AC4: High-risk human-controlled gates cannot be bypassed by model tools.
test('blocks model-tool bypass of high-risk human-controlled gates', async () => {
  const f = fixture({ risk: 'high', riskProfiles: { HIGH: { requiredChecks: ['human-approval'] } } });
  const result = await f.execute('change_submit_review', {
    requiredChecks: ['human-approval'],
    humanApproval: true,
  });
  assert.equal(result.kind, 'deny', 'model-facing tools cannot satisfy a high-risk human gate');
});

// AC5: Increasing risk applies stronger future gates and does not reuse weaker gate satisfaction.
test('requires stronger future gates after risk increases', async () => {
  const f = fixture({
    risk: 'high',
    riskProfiles: {
      LOW: { requiredChecks: ['lint'] },
      HIGH: { requiredChecks: ['lint', 'tests', 'human-approval'] },
    },
  });
  const lowSatisfaction = await f.execute('change_submit_plan', { risk: 'low', requiredChecks: ['lint'] });
  assert.equal(lowSatisfaction.kind, 'deny', 'a lower-risk gate result cannot authorize the high-risk change');
  const highWithoutNewGates = await f.execute('change_submit_plan', { risk: 'high', requiredChecks: ['lint'] });
  assert.equal(highWithoutNewGates.kind, 'deny', 'increased risk must require fresh stronger gates');
});
