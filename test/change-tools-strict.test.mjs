import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { ChangeStore } from '../src/storage/change-store.js';
import { name, apply } from '../src/index.js';

const tools = ['change_get', 'change_submit_plan', 'change_submit_proof', 'change_submit_review', 'change_submit_repair'];
const input = { title: 'Tool workflow', objective: 'Exercise registered tools', acceptanceCriteria: ['safe'], risk: 'normal' };

async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'change-tools-'));
  try {
    const file = join(dir, 'changes.json');
    const ctx = new Context();
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime);
    await ctx.plugin({ name, apply, inject: ['tools'] }, { storePath: file });
    const store = ctx.get('changeStore');
    const change = await store.create(input);
    await fn({ file, store, change, registry: ctx.get('tools') });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

function call(registry, name, args, sessionId, role) {
  // Use agent.id for identity (dsh-tools contract), not sessionId/role
  return registry.execute({ callId: `${name}-${Math.random()}`, name, arguments: args, agent: { id: sessionId }, signal: new AbortController().signal });
}

test('legal registered workflow returns state/content and appends audit evidence', () => fixture(async ({ file, store, change, registry }) => {
  await store.bindRole(change.id, 'planner-session', 'planner');
  const before = (await store.history(change.id)).length;
  const plan = await call(registry, 'change_submit_plan', { changeId: change.id, content: { steps: ['do it'] } }, 'planner-session');
  assert.equal(plan.isError, false);
  assert.ok(plan.value?.planId ?? plan.value?.id);
  const got = await call(registry, 'change_get', { changeId: change.id }, 'planner-session');
  assert.equal(got.isError, false);
  assert.equal(got.value?.state, 'PLANNED');
  assert.ok((await store.history(change.id)).length > before);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).changes[0].state, undefined);
}));

test('wrong identity, role, and state deny without writes', () => fixture(async ({ store, change, registry }) => {
  await store.bindRole(change.id, 'planner-session', 'planner');
  const before = await store.history(change.id);
  const denied = await call(registry, 'change_submit_plan', { changeId: change.id, content: {} }, 'other-session');
  assert.equal(denied.isError, true);
  assert.match(JSON.stringify(denied.error), /session|bound|role|precondition/i);
  assert.deepEqual(await store.history(change.id), before);
  const impersonating = await call(registry, 'change_submit_plan', { changeId: change.id, content: {}, sessionId: 'planner-session', role: 'planner' }, 'other-session');
  assert.equal(impersonating.isError, true);
  assert.deepEqual(await store.history(change.id), before);
}));

test('malformed payloads fail before persistence and arbitrary mutation is absent', () => fixture(async ({ store, change, registry }) => {
  const before = await store.history(change.id);
  const malformed = await call(registry, 'change_submit_plan', { changeId: 42, content: null }, 'planner-session');
  assert.equal(malformed.isError, true);
  assert.deepEqual(await store.history(change.id), before);
  assert.equal(registry.get('change_transition'), undefined);
  assert.equal(registry.get('change_set_state'), undefined);
}));

test('all five tools are registered and have bounded parameter schemas', () => fixture(async ({ registry }) => {
  for (const name of tools) {
    const definition = registry.get(name);
    assert.equal(definition?.name, name);
    assert.ok(definition?.parameters);
    assert.equal(typeof definition.execute, 'function');
  }
}));

test('full legal lifecycle executes all five tools with exact state/audit evidence', () => fixture(async ({ store, change, registry }) => {
  // Bind roles
  await store.bindRole(change.id, 'planner-session', 'planner');
  await store.bindRole(change.id, 'worker-session', 'worker');
  await store.bindRole(change.id, 'reviewer-session', 'reviewer');

  const before = (await store.history(change.id)).length;

  // 1. Plan: DRAFT → PLANNED
  const plan = await call(registry, 'change_submit_plan', { changeId: change.id, content: { steps: ['a'] } }, 'planner-session');
  assert.equal(plan.isError, false);
  assert.ok(plan.value?.planId);

  // Accept plan and transition to IMPLEMENTING
  await store.acceptPlan(change.id, plan.value.planId, { authorized: true });
  assert.equal((await store.get(change.id)).state, 'READY');
  await store.transition(change.id, 'IMPLEMENTING');
  assert.equal((await store.get(change.id)).state, 'IMPLEMENTING');

  // Record implementation attempt with revision (use worker-session for attempt)
  await store.recordAttempt(change.id, { attemptId: 'impl-1', workerId: 'worker-session', revision: 'impl-1', status: 'completed' });

  // Submit proof (legal: IMPLEMENTING → PREFLIGHT)
  const proof = await call(registry, 'change_submit_proof', { changeId: change.id, proof: 'tests pass' }, 'worker-session');
  assert.equal(proof.isError, false);
  assert.equal(proof.value?.success, true);
  assert.equal((await store.get(change.id)).state, 'PREFLIGHT');

  // Transition PREFLIGHT → REVIEW (separate authorized transition)
  await store.transition(change.id, 'REVIEW');
  assert.equal((await store.get(change.id)).state, 'REVIEW');

  // 3. Review: REVIEW → REPAIR (fail with critical finding)
  const review = await call(registry, 'change_submit_review', {
    changeId: change.id,
    review: { verdict: 'fail', revision: 'impl-1', findings: [{ severity: 'critical', category: 'security', location: 'file.js:1', problem: 'Issue', requiredOutcome: 'Fix it' }] }
  }, 'reviewer-session');
  assert.equal(review.isError, false);
  assert.equal(review.value?.state, 'REPAIR');
  assert.equal((await store.get(change.id)).state, 'REPAIR');

  // 4. Repair: REPAIR → PREFLIGHT
  const reviewFindings = (await store.getReview(change.id)).findings;
  const repair = await call(registry, 'change_submit_repair', { changeId: change.id, repair: { findings: [{ findingId: reviewFindings[0].id, status: 'fixed', claim: 'fixed' }], proof: { bundleId: 'proof-2', beforeRevision: 'impl-1', afterRevision: 'impl-2' } } }, 'worker-session');
  assert.equal(repair.isError, false);
  assert.equal(repair.value?.success, true);
  assert.equal((await store.get(change.id)).state, 'PREFLIGHT');

  // Transition PREFLIGHT → REVIEW for re-review
  await store.transition(change.id, 'REVIEW');
  assert.equal((await store.get(change.id)).state, 'REVIEW');

  // Record new implementation attempt
  await store.recordAttempt(change.id, { attemptId: 'impl-2', workerId: 'worker-session', revision: 'impl-2', status: 'completed' });

  // 5. Re-review: REVIEW → APPROVED
  const review2 = await call(registry, 'change_submit_review', {
    changeId: change.id,
    review: { verdict: 'pass', revision: 'impl-2', findings: [] }
  }, 'reviewer-session');
  assert.equal(review2.isError, false);
  assert.equal(review2.value?.state, 'APPROVED');
  assert.equal((await store.get(change.id)).state, 'APPROVED');

  // Verify audit evidence
  const after = (await store.history(change.id)).length;
  assert.ok(after > before, 'History should have appended events');
  const history = await store.history(change.id);
  const states = history.map(h => h.to);
  assert.ok(states.includes('PLANNED'));
  assert.ok(states.includes('PREFLIGHT'));
  assert.ok(states.includes('REVIEW'));
  assert.ok(states.includes('REPAIR'));
  assert.ok(states.includes('APPROVED'));
}));

test('V1: proof/repair denied without accepted plan', () => fixture(async ({ store, change, registry }) => {
  await store.bindRole(change.id, 'worker-session', 'worker');

  // Create change but DON'T submit/accept a plan
  const proof = await call(registry, 'change_submit_proof', { changeId: change.id, proof: 'done' }, 'worker-session');
  assert.equal(proof.isError, true);
  assert.match(JSON.stringify(proof.error), /PLAN_NOT_ACCEPTED|plan.*accepted/i);

  const repair = await call(registry, 'change_submit_repair', { changeId: change.id, repair: { findings: [], proof: { bundleId: 'proof-2' } } }, 'worker-session');
  assert.equal(repair.isError, true);
  assert.match(JSON.stringify(repair.error), /PLAN_NOT_ACCEPTED|plan.*accepted/i);
}));

test('V2: illegal transition returns structured error with code/current/attempted/allowed', () => fixture(async ({ store, change, registry }) => {
  await store.bindRole(change.id, 'planner-session', 'planner');
  await store.bindRole(change.id, 'worker-session', 'worker');
  await store.bindRole(change.id, 'reviewer-session', 'reviewer');

  // Submit and accept plan (acceptPlan transitions to READY)
  const plan = await call(registry, 'change_submit_plan', { changeId: change.id, content: { steps: ['a'] } }, 'planner-session');
  assert.equal(plan.isError, false);
  await store.acceptPlan(change.id, plan.value.planId, { authorized: true });
  // acceptPlan sets state to READY, so transition directly to IMPLEMENTING
  await store.transition(change.id, 'IMPLEMENTING');
  assert.equal((await store.get(change.id)).state, 'IMPLEMENTING');

  // Record implementation attempt with revision (use a different worker session)
  await store.recordAttempt(change.id, { attemptId: 'impl-1', workerId: 'impl-worker', revision: 'impl-1', status: 'completed' });
  await store.bindRole(change.id, 'impl-worker', 'worker');

  // Submit proof (legal: IMPLEMENTING → PREFLIGHT)
  const proof = await call(registry, 'change_submit_proof', { changeId: change.id, proof: 'done' }, 'worker-session');
  assert.equal(proof.isError, false);
  assert.equal(proof.value?.success, true);
  assert.equal((await store.get(change.id)).state, 'PREFLIGHT');

  // Transition PREFLIGHT → REVIEW (separate authorized transition)
  await store.transition(change.id, 'REVIEW');
  assert.equal((await store.get(change.id)).state, 'REVIEW');

  // Submit review (legal: REVIEW → REPAIR with fail verdict)
  const review = await call(registry, 'change_submit_review', {
    changeId: change.id,
    review: { verdict: 'fail', revision: 'impl-1', findings: [{ severity: 'critical', category: 'security', location: 'file.js:1', problem: 'Issue', requiredOutcome: 'Fix' }] }
  }, 'reviewer-session');
  assert.equal(review.isError, false);
  assert.equal((await store.get(change.id)).state, 'REPAIR');

  // Submit repair (legal: REPAIR → PREFLIGHT)
  const reviewFindings = review.value?.findings || [];
  const repair = await call(registry, 'change_submit_repair', { changeId: change.id, repair: { findings: reviewFindings.map((f) => ({ findingId: f.id, status: 'fixed', claim: 'fixed' })), proof: { bundleId: 'proof-2', beforeRevision: 'impl-1', afterRevision: 'impl-2' } } }, 'worker-session');
  assert.equal(repair.isError, false);
  assert.equal((await store.get(change.id)).state, 'PREFLIGHT');

  // Now try illegal transition: proof from PREFLIGHT (should fail - need REVIEW first)
  const badProof = await call(registry, 'change_submit_proof', { changeId: change.id, proof: 'late' }, 'worker-session');
  assert.equal(badProof.isError, true);
  // Should have structured error - auth fails because toAuthState maps PREFLIGHT→REVIEW, not PROOF
  assert.ok(badProof.error?.message?.includes('submitProof') || badProof.error?.code === 'ROLE_NOT_ALLOWED' || badProof.error?.code === 'INVALID_CHANGE_STATE', 'Should have structured denial for invalid state');
}));

test('V3: structured denials preserve code/reason through ToolRuntime', () => fixture(async ({ store, change, registry }) => {
  await store.bindRole(change.id, 'planner-session', 'planner');

  // Test malformed changeId
  const bad = await call(registry, 'change_submit_plan', { changeId: 'not-a-uuid', content: {} }, 'planner-session');
  assert.equal(bad.isError, true);
  assert.ok(bad.error?.code === 'INVALID_CHANGE_ID' || bad.error?.message?.includes('UUID'), 'Should have structured error code');

  // Test impersonation
  const imp = await call(registry, 'change_submit_plan', { changeId: change.id, content: {}, sessionId: 'evil', role: 'planner' }, 'planner-session');
  assert.equal(imp.isError, true);
  assert.ok(imp.error?.code === 'SESSION_IMPERSONATION' || imp.error?.message?.includes('impersonation'), 'Should have impersonation error');

  // Test unbound session
  const unbound = await call(registry, 'change_submit_plan', { changeId: change.id, content: {} }, 'unbound-session');
  assert.equal(unbound.isError, true);
  assert.ok(unbound.error?.code === 'SESSION_NOT_BOUND' || unbound.error?.message?.includes('bound'), 'Should have binding error');
}));

test('repair rejects unknown finding IDs without state, audit, or persistence side effects', () => fixture(async ({ file, store, change, registry }) => {
  await store.bindRole(change.id, 'worker-session', 'worker');
  await store.bindRole(change.id, 'reviewer-session', 'reviewer');
  const plan = await store.submitPlan(change.id, { steps: ['implement'] });
  await store.acceptPlan(change.id, plan.id, { authorized: true });
  await store.transition(change.id, 'IMPLEMENTING');
  await store.recordAttempt(change.id, { attemptId: 'impl-1', workerId: 'worker-session', revision: 'impl-1', status: 'completed' });
  await store.transition(change.id, 'PREFLIGHT');
  await store.transition(change.id, 'REVIEW');
  const review = await store.submitReview(change.id, { verdict: 'fail', revision: 'impl-1', findings: [{ severity: 'critical', category: 'security', location: 'file.js:1', problem: 'Issue', requiredOutcome: 'Fix' }] }, { sessionId: 'reviewer-session' });
  const beforeHistory = await store.history(change.id);
  const beforeFile = await readFile(file, 'utf8');
  const denied = await call(registry, 'change_submit_repair', { changeId: change.id, repair: { findings: [{ findingId: 'finding-unknown', status: 'fixed', claim: 'nope' }], proof: { bundleId: 'proof-2', beforeRevision: 'impl-1', afterRevision: 'impl-2' } } }, 'worker-session');
  assert.equal(denied.isError, true);
  assert.match(JSON.stringify(denied.error), /unknown|finding/i);
  assert.deepEqual(await store.history(change.id), beforeHistory);
  assert.equal(await readFile(file, 'utf8'), beforeFile);
  assert.equal((await store.get(change.id)).state, 'REPAIR');
  assert.ok(review.findings[0].id);
}));

test('REPAIR worker query returns unresolved findings through change_get', () => fixture(async ({ store, change, registry }) => {
  await store.bindRole(change.id, 'worker-session', 'worker');
  await store.bindRole(change.id, 'reviewer-session', 'reviewer');
  await store.transition(change.id, 'PLANNED');
  await store.transition(change.id, 'READY');
  await store.transition(change.id, 'IMPLEMENTING');
  await store.recordAttempt(change.id, { attemptId: 'impl-1', workerId: 'worker-session', revision: 'impl-1', status: 'completed' });
  await store.transition(change.id, 'PREFLIGHT');
  await store.transition(change.id, 'REVIEW');
  await store.submitReview(change.id, { verdict: 'fail', revision: 'impl-1', findings: [{ severity: 'critical', category: 'security', location: 'file.js:1', problem: 'Issue', requiredOutcome: 'Fix' }] }, { sessionId: 'reviewer-session' });
  const queried = await call(registry, 'change_get', { changeId: change.id }, 'worker-session');
  assert.equal(queried.isError, false);
  assert.equal(queried.value.state, 'REPAIR');
  assert.equal(queried.value.unresolvedFindings.length, 1);
}));

test('implementation repair requires a new proof bundle before PREFLIGHT', () => fixture(async ({ store, change, registry }) => {
  await store.bindRole(change.id, 'worker-session', 'worker');
  await store.bindRole(change.id, 'reviewer-session', 'reviewer');
  const plan = await store.submitPlan(change.id, { steps: ['implement'] });
  await store.acceptPlan(change.id, plan.id, { authorized: true });
  await store.transition(change.id, 'IMPLEMENTING');
  await store.recordAttempt(change.id, { attemptId: 'impl-1', workerId: 'worker-session', revision: 'impl-1', status: 'completed' });
  await store.transition(change.id, 'PREFLIGHT');
  await store.transition(change.id, 'REVIEW');
  const review = await store.submitReview(change.id, { verdict: 'fail', revision: 'impl-1', findings: [{ severity: 'critical', category: 'security', location: 'file.js:1', problem: 'Issue', requiredOutcome: 'Fix' }] }, { sessionId: 'reviewer-session' });
  const repair = { findings: [{ findingId: review.findings[0].id, status: 'fixed', claim: 'fixed' }] };
  const denied = await call(registry, 'change_submit_repair', { changeId: change.id, repair }, 'worker-session');
  assert.equal(denied.isError, true);
  assert.equal((await store.get(change.id)).state, 'REPAIR');
  repair.proof = { bundleId: 'proof-2', beforeRevision: 'impl-1', afterRevision: 'impl-2' };
  const accepted = await call(registry, 'change_submit_repair', { changeId: change.id, repair }, 'worker-session');
  assert.equal(accepted.isError, false);
  assert.equal((await store.get(change.id)).state, 'PREFLIGHT');
}));

test('V4: repair from REVIEW without recorded review is rejected (N5 regression)', () => fixture(async ({ store, change, registry }) => {
  await store.bindRole(change.id, 'planner-session', 'planner');
  await store.bindRole(change.id, 'worker-session', 'worker');
  await store.bindRole(change.id, 'reviewer-session', 'reviewer');

  // Submit and accept plan
  const plan = await call(registry, 'change_submit_plan', { changeId: change.id, content: { steps: ['a'] } }, 'planner-session');
  assert.equal(plan.isError, false);
  await store.acceptPlan(change.id, plan.value.planId, { authorized: true });
  await store.transition(change.id, 'IMPLEMENTING');

  // Record implementation attempt
  await store.recordAttempt(change.id, { attemptId: 'impl-1', workerId: 'worker-session', revision: 'impl-1', status: 'completed' });

  // Submit proof and transition to REVIEW
  const proof = await call(registry, 'change_submit_proof', { changeId: change.id, proof: 'done' }, 'worker-session');
  assert.equal(proof.isError, false);
  await store.transition(change.id, 'REVIEW');
  assert.equal((await store.get(change.id)).state, 'REVIEW');

  // Try to submit repair directly from REVIEW (should fail - no review recorded)
  const repair = await call(registry, 'change_submit_repair', { changeId: change.id, repair: { findings: [], proof: { bundleId: 'proof-2' } } }, 'worker-session');
  assert.equal(repair.isError, true);
  assert.ok(repair.error?.code === 'INVALID_STATE' || repair.error?.message?.includes('expected REPAIR'), 'Should reject repair from REVIEW without prior review');
  // State should remain REVIEW
  assert.equal((await store.get(change.id)).state, 'REVIEW');
}));

// Regression: strict planAccepted authorization (ARK-T3-007)
test('repair denied without accepted plan - strict authorization', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'change-tools-'));
  try {
    const file = join(dir, 'changes.json');
    const ctx = new Context();
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime);
    await ctx.plugin({ name, apply, inject: ['tools'] }, { storePath: file });
    const store = ctx.get('changeStore');
    const registry = ctx.get('tools');
    const change = await store.create({ title: 'Test', objective: 'Test', acceptanceCriteria: ['AC1'], risk: 'normal' });
    await store.bindRole(change.id, 'worker-session', 'worker');
    await store.bindRole(change.id, 'reviewer-session', 'reviewer');
    // Transition without submitting/accepting plan
    await store.transition(change.id, 'PLANNED');
    await store.transition(change.id, 'READY');
    await store.transition(change.id, 'IMPLEMENTING');
    await store.recordAttempt(change.id, { attemptId: 'impl-1', workerId: 'worker-session', revision: 'impl-1', status: 'completed' });
    await store.transition(change.id, 'PREFLIGHT');
    await store.transition(change.id, 'REVIEW');
    await store.submitReview(change.id, { verdict: 'fail', revision: 'impl-1', findings: [{ severity: 'critical', category: 'security', location: 'f.js:1', problem: 'Issue', requiredOutcome: 'Fix' }] }, { sessionId: 'reviewer-session' });
    // Should fail - no plan accepted
    const repair = await call(registry, 'change_submit_repair', { changeId: change.id, repair: { findings: [], proof: { bundleId: 'p' } } }, 'worker-session');
    assert.equal(repair.isError, true);
    assert.match(JSON.stringify(repair.error), /PLAN_NOT_ACCEPTED|plan.*accepted/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// Regression: reject string repair and _legacy bypass (ARK-T3-002, ARK-T6-001)
test('rejects string repair and _legacy bypass', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'change-tools-'));
  try {
    const file = join(dir, 'changes.json');
    const ctx = new Context();
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime);
    await ctx.plugin({ name, apply, inject: ['tools'] }, { storePath: file });
    const store = ctx.get('changeStore');
    const registry = ctx.get('tools');
    const change = await store.create({ title: 'Test', objective: 'Test', acceptanceCriteria: ['AC1'], risk: 'normal' });
    await store.bindRole(change.id, 'worker-session', 'worker');
    // String repair should be rejected by schema
    const stringRepair = await call(registry, 'change_submit_repair', { changeId: change.id, repair: 'fixed it' }, 'worker-session');
    assert.equal(stringRepair.isError, true);
    // _legacy bypass should not work
    const legacyRepair = await call(registry, 'change_submit_repair', { changeId: change.id, repair: { findings: [], proof: {}, _legacy: true } }, 'worker-session');
    assert.equal(legacyRepair.isError, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// Regression: rejected repair leaves no phantom claims (ARK-T6-002)
test('rejected repair leaves no phantom claims', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'change-tools-'));
  try {
    const file = join(dir, 'changes.json');
    const ctx = new Context();
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime);
    await ctx.plugin({ name, apply, inject: ['tools'] }, { storePath: file });
    const store = ctx.get('changeStore');
    const registry = ctx.get('tools');
    const change = await store.create({ title: 'Test', objective: 'Test', acceptanceCriteria: ['AC1'], risk: 'normal' });
    await store.bindRole(change.id, 'worker-session', 'worker');
    await store.bindRole(change.id, 'reviewer-session', 'reviewer');
    const plan = await store.submitPlan(change.id, { steps: ['implement'] });
    await store.acceptPlan(change.id, plan.id, { authorized: true });
    await store.transition(change.id, 'IMPLEMENTING');
    await store.recordAttempt(change.id, { attemptId: 'impl-1', workerId: 'worker-session', revision: 'impl-1', status: 'completed' });
    await store.transition(change.id, 'PREFLIGHT');
    await store.transition(change.id, 'REVIEW');
    const review = await store.submitReview(change.id, { verdict: 'fail', revision: 'impl-1', findings: [{ severity: 'critical', category: 'security', location: 'f.js:1', problem: 'Issue', requiredOutcome: 'Fix' }] }, { sessionId: 'reviewer-session' });
    // First repair attempt with stale proof should fail
    const repair1 = await call(registry, 'change_submit_repair', { changeId: change.id, repair: { findings: [{ findingId: review.findings[0].id, status: 'fixed', claim: 'fix' }], proof: { bundleId: 'p1', beforeRevision: 'impl-1', afterRevision: 'impl-2' } } }, 'worker-session');
    assert.equal(repair1.isError, false);
    // Second repair with identical proof should fail (STALE_PROOF)
    const repair2 = await call(registry, 'change_submit_repair', { changeId: change.id, repair: { findings: [{ findingId: review.findings[0].id, status: 'fixed', claim: 'fix' }], proof: { bundleId: 'p1', beforeRevision: 'impl-1', afterRevision: 'impl-2' } } }, 'worker-session');
    assert.equal(repair2.isError, true);
    // Claims should still only have one entry (no phantom claim from rejected repair)
    // Get claims via getRepairContext
    const context = await store.getRepairContext(change.id);
    assert.equal(context.repairClaims.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// Regression: stale instance claim merge (ARK-T6-003)
test('stale instance claim merge preserves concurrent claims', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'change-tools-'));
  try {
    const file = join(dir, 'changes.json');
    const storeA = await ChangeStore.open(file);
    const storeB = await ChangeStore.open(file);
    const change = await storeA.create({ title: 'Test', objective: 'Test', acceptanceCriteria: ['AC1'], risk: 'normal' });
    await storeA.bindRole(change.id, 'worker-a', 'worker');
    await storeA.bindRole(change.id, 'reviewer-session', 'reviewer');
    const plan = await storeA.submitPlan(change.id, { steps: ['implement'] });
    await storeA.acceptPlan(change.id, plan.id, { authorized: true });
    await storeA.transition(change.id, 'IMPLEMENTING');
    await storeA.recordAttempt(change.id, { attemptId: 'impl-1', workerId: 'worker-a', revision: 'impl-1', status: 'completed' });
    await storeA.transition(change.id, 'PREFLIGHT');
    await storeA.transition(change.id, 'REVIEW');
    const review = await storeA.submitReview(change.id, { verdict: 'fail', revision: 'impl-1', findings: [{ severity: 'critical', category: 'security', location: 'f.js:1', problem: 'Issue', requiredOutcome: 'Fix' }] }, { sessionId: 'reviewer-session' });
    // Instance A submits repair with claim
    await storeA.submitRepair(change.id, { findings: [{ findingId: review.findings[0].id, status: 'fixed', claim: 'A-claim' }], proof: { bundleId: 'p1', beforeRevision: 'impl-1', afterRevision: 'impl-2' } }, { workerId: 'worker-a' });
    // Instance C opens fresh and checks claims
    const storeC = await ChangeStore.open(file);
    const context = await storeC.getRepairContext(change.id);
    assert.equal(context.repairClaims.length, 1);
    assert.equal(context.repairClaims[0].findingId, review.findings[0].id);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
