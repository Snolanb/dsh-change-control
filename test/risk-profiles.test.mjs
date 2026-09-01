import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFilesystemPolicy } from '../src/tools/filesystem-policy.js';
import { ChangeStore } from '../src/storage/change-store.js';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools';
import { name, apply } from '../src/index.js';

/**
 * Real pre-execute policy boundary fixture. The risk-profile implementation
 * derives effective risk and gate satisfaction from host state only; model
 * arguments can never influence either.
 */
function fixture({ risk, riskProfiles, policy = {} } = {}) {
  const audits = [];
  const satisfaction = [];
  const change = { id: 'change-risk-1', state: 'IMPLEMENTING', risk };
  const store = {
    async listRoleBindings() {
      return [{ changeId: change.id, sessionId: 'worker-1', role: 'worker' }];
    },
    async get() { return change; },
    async appendAudit(event) { audits.push(event); },
    async getGateSatisfaction() { return satisfaction; },
  };
  const gate = createFilesystemPolicy(store, {
    policy: { enabled: true, workspaceRoots: ['/workspace'], riskProfiles, ...policy },
  });
  const execute = (toolName, arguments_ = {}) => gate(
    { name: toolName, arguments: { changeId: change.id, ...arguments_ }, agent: { id: 'worker-1' } },
    () => ({ kind: 'allow' }),
  );
  return { change, audits, satisfaction, execute };
}

// AC1: Effective risk is explicit before implementation.
test('requires explicit effective risk before implementation begins', async () => {
  const f = fixture({ risk: undefined });
  const result = await f.execute('filesystem_write', { path: '/workspace/src/app.js' });
  assert.equal(result.kind, 'deny', 'implementation must not proceed without explicit effective risk');
  assert.equal(result.code, 'RISK_NOT_EXPLICIT');
});

// Real ChangeStore lifecycle: risk starts unset and implementation is denied
// until the host sets it explicitly.
test('real ChangeStore starts risk unset and denies implementation until the host sets it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-risk-explicit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await ChangeStore.open(join(dir, 'changes.json'));
  const change = await store.create({ title: 'No risk yet', objective: 'o', acceptanceCriteria: ['a'] });
  assert.equal(change.risk, null, 'absence of a risk decision must be distinguishable from NORMAL');
  await store.submitPlan(change.id, { steps: ['implement'] });
  const plan = (await store.listPlans(change.id)).at(-1);
  await store.acceptPlan(change.id, plan.id, { authorized: true });
  await store.transition(change.id, 'IMPLEMENTING');
  await store.bindRole(change.id, 'worker-1', 'worker');
  const gate = createFilesystemPolicy(store, {
    policy: { enabled: true, workspaceRoots: ['/workspace'], riskProfiles: { low: { requiredChecks: [] } } },
  });
  const denied = await gate(
    { name: 'filesystem_write', arguments: { changeId: change.id, path: '/workspace/x.js' }, agent: { id: 'worker-1' } },
    () => ({ kind: 'allow' }),
  );
  assert.equal(denied.kind, 'deny');
  assert.equal(denied.code, 'RISK_NOT_EXPLICIT');
  await store.setRisk(change.id, 'low');
  const allowed = await gate(
    { name: 'filesystem_write', arguments: { changeId: change.id, path: '/workspace/x.js' }, agent: { id: 'worker-1' } },
    () => ({ kind: 'allow' }),
  );
  assert.equal(allowed.kind, 'allow');
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
  assert.equal(result.code, 'RISK_REDUCTION');
});

// AC2: nested downgrade claims with any recognized key spelling are caught.
test('rejects nested risk downgrade claims with alternate key spellings', async () => {
  const f = fixture({ risk: 'high' });
  for (const args of [
    { path: '/workspace/a.js', payload: { effective_risk: 'low' } },
    { path: '/workspace/a.js', options: { riskLevel: 'normal' }, nested: [{ risk_level: 'low' }] },
  ]) {
    const result = await f.execute('filesystem_write', args);
    assert.equal(result.kind, 'deny', 'nested downgrade claims must be denied');
    assert.equal(result.code, 'RISK_REDUCTION');
  }
});

// AC3: LOW, NORMAL, and HIGH gate requirements are enforced as configured,
// against host-recorded satisfaction — never tool arguments.
test('enforces configured LOW, NORMAL, and HIGH gate requirements against host state', async () => {
  const riskProfiles = {
    low: { requiredChecks: ['lint'] },
    normal: { requiredChecks: ['lint', 'tests'] },
    high: { requiredChecks: ['lint', 'tests', { name: 'sign-off', control: 'human' }] },
  };
  for (const risk of ['low', 'normal', 'high']) {
    // No host-recorded satisfaction: deny regardless of arguments.
    const f = fixture({ risk, riskProfiles });
    const result = await f.execute('change_submit_plan', { requiredChecks: ['lint', 'tests'] });
    assert.equal(result.kind, 'deny', `${risk.toUpperCase()} must require every configured gate`);
    assert.equal(result.code, 'RISK_GATE_INCOMPLETE');
  }
});

// AC3: argument-free HIGH-risk submission and filesystem mutation both deny.
test('denies argument-free HIGH-risk submissions and mutations without host gate records', async () => {
  const riskProfiles = { high: { requiredChecks: ['lint'] } };
  const f = fixture({ risk: 'high', riskProfiles });
  const submission = await f.execute('change_submit_plan');
  assert.equal(submission.kind, 'deny');
  assert.equal(submission.code, 'RISK_GATE_INCOMPLETE');
  const mutation = await f.execute('filesystem_write', { path: '/workspace/src/app.js' });
  assert.equal(mutation.kind, 'deny');
  assert.equal(mutation.code, 'RISK_GATE_INCOMPLETE');
});

// AC4: model-facing tools cannot supply or assert a human-controlled gate,
// even one whose name does not mention "human".
test('blocks model-tool assertion of human-controlled gates regardless of gate naming', async () => {
  const riskProfiles = { high: { requiredChecks: ['lint', { name: 'sign-off', control: 'human' }] } };
  const f = fixture({ risk: 'high', riskProfiles });
  const result = await f.execute('change_submit_review', {
    requiredChecks: ['lint', 'sign-off'],
    humanApproval: true,
  });
  assert.equal(result.kind, 'deny', 'model-facing tools cannot satisfy a human-controlled gate');
  assert.equal(result.code, 'HUMAN_GATE_BYPASS');
  const approvalOnly = await f.execute('change_submit_review', { approval: true });
  assert.equal(approvalOnly.kind, 'deny');
  assert.equal(approvalOnly.code, 'HUMAN_GATE_BYPASS');
});

// Positive: once the host records every configured gate (including the
// human gate satisfied out-of-band), the HIGH-risk action is allowed.
test('allows HIGH-risk actions once the host has recorded every configured gate', async () => {
  const riskProfiles = { high: { requiredChecks: ['lint', 'tests', { name: 'sign-off', control: 'human' }] } };
  const f = fixture({ risk: 'high', riskProfiles });
  for (const gate_ of ['lint', 'tests', 'sign-off']) {
    f.satisfaction.push({ name: gate_, risk: 'high', recordedAt: new Date().toISOString() });
  }
  const result = await f.execute('filesystem_write', { path: '/workspace/src/app.js' });
  assert.equal(result.kind, 'allow', 'host-recorded satisfaction of every gate must allow the action');
});

// AC5: risk escalation is host-owned state; previous weaker-level gate
// satisfaction cannot authorize the change after escalation.
test('risk escalation invalidates weaker gate satisfaction and requires stronger gates', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-risk-escalation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await ChangeStore.open(join(dir, 'changes.json'));
  const change = await store.create({ title: 'Escalation', objective: 'o', acceptanceCriteria: ['a'], risk: 'low' });
  await store.submitPlan(change.id, { steps: ['implement'] });
  const plan = (await store.listPlans(change.id)).at(-1);
  await store.acceptPlan(change.id, plan.id, { authorized: true });
  await store.transition(change.id, 'IMPLEMENTING');
  await store.bindRole(change.id, 'worker-1', 'worker');
  const gate = createFilesystemPolicy(store, {
    policy: {
      enabled: true,
      workspaceRoots: ['/workspace'],
      riskProfiles: {
        low: { requiredChecks: ['lint'] },
        high: { requiredChecks: ['lint', 'tests', { name: 'sign-off', control: 'human' }] },
      },
    },
  });
  const run = () => gate(
    { name: 'change_submit_plan', arguments: { changeId: change.id }, agent: { id: 'worker-1' } },
    () => ({ kind: 'allow' }),
  );

  // Satisfy the LOW profile gates; the action is allowed.
  await store.recordGateSatisfaction(change.id, { name: 'lint' });
  assert.equal((await run()).kind, 'allow', 'LOW gates satisfied should allow the action');

  // Host escalates LOW -> HIGH; the escalation is audited with from/to.
  await store.setRisk(change.id, 'high');
  const history = await store.history(change.id);
  const escalation = history.find((e) => e.type === 'RISK_ESCALATION');
  assert.ok(escalation, 'escalation must be recorded in the append-only audit');
  assert.equal(escalation.from, 'low');
  assert.equal(escalation.to, 'high');

  // Previously satisfying LOW-level records no longer authorize the change.
  const stale = await run();
  assert.equal(stale.kind, 'deny', 'weaker-level gate satisfaction cannot authorize the escalated change');
  assert.equal(stale.code, 'RISK_GATE_INCOMPLETE');

  // Host records the full HIGH profile (human gate satisfied out-of-band).
  for (const gate_ of ['lint', 'tests', 'sign-off']) {
    await store.recordGateSatisfaction(change.id, { name: gate_ });
  }
  assert.equal((await run()).kind, 'allow', 'fresh stronger gates authorize the escalated change');

  // Risk cannot be lowered — not even by this host API.
  await assert.rejects(
    () => store.setRisk(change.id, 'low'),
    (err) => err.code === 'RISK_DOWNGRADE',
  );
});

// Legacy tolerance is an explicit host-owned opt-in, never the default.
test('legacy riskless changes require explicit opt-in and fail closed by default', async () => {
  const defaulted = fixture({ risk: null });
  assert.equal(
    (await defaulted.execute('filesystem_write', { path: '/workspace/a.js' })).code,
    'RISK_NOT_EXPLICIT',
    'absent risk fails closed without the flag',
  );
  const legacy = fixture({ risk: null, policy: { allowLegacyRisklessChanges: true } });
  const result = await legacy.execute('filesystem_write', { path: '/workspace/a.js' });
  assert.equal(result.kind, 'allow', 'explicit host opt-in tolerates legacy riskless changes');
});

// Config contract: riskProfiles are validated/normalized at plugin wiring,
// and the same config path as production enforces the gates end-to-end.
test('validates riskProfiles at plugin wiring and enforces them at the tool boundary', async (t) => {
  // Malformed configuration fails fast at wiring.
  for (const bad of [
    { other: { requiredChecks: [] } },
    { low: {} },
    { low: { requiredChecks: [42] } },
  ]) {
    const ctx = new Context();
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime);
    // ctx.plugin returns a cordis Fiber; wrap so assert.rejects sees a promise.
    await assert.rejects(
      async () => ctx.plugin({ name, apply, inject: ['tools'] }, { storePath: '/tmp/unused.json', policy: { enabled: true, riskProfiles: bad } }),
      /riskProfiles/,
    );
  }

  // Valid lowercase configuration enforces gates through the real registry.
  const dir = await mkdtemp(join(tmpdir(), 'dsh-risk-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  await ctx.plugin({ name, apply, inject: ['tools'] }, {
    storePath: join(dir, 'changes.json'),
    policy: {
      enabled: true,
      workspaceRoots: [dir],
      riskProfiles: { high: { requiredChecks: ['lint'] } },
    },
  });
  const store = ctx.get('changeStore');
  const registry = ctx.get('tools');
  registry.register(defineTool({
    name: 'filesystem_write',
    description: 'test write',
    parameters: { path: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => v },
    execute: async () => ({ written: true }),
  }));
  const change = await store.create({ title: 'cfg', objective: 'o', acceptanceCriteria: ['a'] });
  await store.submitPlan(change.id, { steps: ['i'] });
  const plan = (await store.listPlans(change.id)).at(-1);
  await store.acceptPlan(change.id, plan.id, { authorized: true });
  await store.transition(change.id, 'IMPLEMENTING');
  await store.setRisk(change.id, 'high');
  await store.bindRole(change.id, 'worker-1', 'worker');
  const call = (args) => registry.execute({
    callId: `call-${Math.random()}`, name: 'filesystem_write', arguments: args,
    agent: { id: 'worker-1' }, signal: new AbortController().signal,
  });
  assert.equal((await call({ changeId: change.id, path: join(dir, 'x.txt') })).isError, true,
    'unrecorded gates must deny through the plugin-configured boundary');
  await store.recordGateSatisfaction(change.id, { name: 'lint' });
  assert.equal((await call({ changeId: change.id, path: join(dir, 'x.txt') })).isError, false,
    'host-recorded gates must allow through the plugin-configured boundary');
});
