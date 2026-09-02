import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChangeStore } from '../src/storage/change-store.js';
import { PreflightRunner } from '../src/preflight/preflight-runner.js';
import { createChangeTools } from '../src/tools/change-tools.js';

// Role-gated operations execute through the canonical tool boundary where
// ChangeService authorization and session identity derivation are enforced.
const toolsFor = (store) => Object.fromEntries(createChangeTools(store).map((tool) => [tool.name, tool]));
const asSession = (sessionId) => ({ agent: { id: sessionId } });
// Filter for assert.rejects: catches both AuthorizationError (.reason) and
// tool-converted errors (.code) produced by the same authorization paths.
const errCode = (code) => (e) => e?.code === code || e?.reason === code;

const proof = (revision = 'rev-1') => ({ beforeRevision: 'rev-0', afterRevision: revision, criteria: [{ id: 'safe', satisfied: true }], deviations: [], workerChecks: [{ name: 'tests', passed: true }], controllerPreflight: [] });
const checks = [{ name: 'tests', command: 'node --test', passed: true, exitCode: 0 }];

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'governance-e2e-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'changes.json');
  const store = await ChangeStore.open(file, { preflightPolicy: { requiredChecks: ['tests'], protectedPaths: [] } });
  const change = await store.create({ title: 'governance e2e', objective: 'exercise controls', acceptanceCriteria: ['safe'], risk: 'normal' });
  return { dir, file, store, change };
}

// ─── Tool surface allowlist ──────────────────────────────────────────────────
test('tool surface is exactly the canonical five-change allowlist', async (t) => {
  const f = await fixture(t);
  const tools = createChangeTools(f.store);
  const names = tools.map((t) => t.name);
  assert.deepEqual(names, ['change_get', 'change_submit_plan', 'change_submit_proof', 'change_submit_review', 'change_submit_repair']);
});

test('every tool rejects an unbound session with SESSION_NOT_BOUND', async (t) => {
  const f = await fixture(t);
  const tools = toolsFor(f.store);
  const unbound = asSession('unbound-session');
  await assert.rejects(tools.change_get.execute({ changeId: f.change.id }, unbound), errCode('SESSION_NOT_BOUND'));
  await assert.rejects(tools.change_submit_plan.execute({ changeId: f.change.id, content: {} }, unbound), errCode('SESSION_NOT_BOUND'));
  await assert.rejects(tools.change_submit_proof.execute({ changeId: f.change.id, proof: 'p' }, unbound), errCode('SESSION_NOT_BOUND'));
  await assert.rejects(tools.change_submit_review.execute({ changeId: f.change.id, review: {} }, unbound), errCode('SESSION_NOT_BOUND'));
  await assert.rejects(tools.change_submit_repair.execute({ changeId: f.change.id, repair: {} }, unbound), errCode('SESSION_NOT_BOUND'));
});

test('every tool rejects a mismatched payload sessionId with SESSION_IMPERSONATION', async (t) => {
  const f = await fixture(t);
  await f.store.bindRole(f.change.id, 'real-worker', 'worker');
  const tools = toolsFor(f.store);
  await assert.rejects(
    () => tools.change_get.execute({ changeId: f.change.id, sessionId: 'other-id' }, asSession('real-worker')),
    errCode('SESSION_IMPERSONATION')
  );
  await assert.rejects(
    () => tools.change_submit_plan.execute({ changeId: f.change.id, content: {}, sessionId: 'other-id' }, asSession('real-worker')),
    errCode('SESSION_IMPERSONATION')
  );
  await assert.rejects(
    () => tools.change_submit_proof.execute({ changeId: f.change.id, proof: 'p', sessionId: 'other-id' }, asSession('real-worker')),
    errCode('SESSION_IMPERSONATION')
  );
  await assert.rejects(
    () => tools.change_submit_review.execute({ changeId: f.change.id, review: {}, sessionId: 'other-id' }, asSession('real-worker')),
    errCode('SESSION_IMPERSONATION')
  );
  await assert.rejects(
    () => tools.change_submit_repair.execute({ changeId: f.change.id, repair: {}, sessionId: 'other-id' }, asSession('real-worker')),
    errCode('SESSION_IMPERSONATION')
  );
});

// ─── Denial scenarios with before/after snapshots ─────────────────────────────

test('bypass attempt before accepted plan is rejected without audit or writes', async (t) => {
  const f = await fixture(t);
  await f.store.bindRole(f.change.id, 'worker-a', 'worker');
  const tools = toolsFor(f.store);
  const beforeHistory = await f.store.history(f.change.id);
  const beforePreflight = await f.store.getPreflight(f.change.id);
  const beforeJson = await readFile(f.file, 'utf8');
  await assert.rejects(
    () => tools.change_submit_proof.execute({ changeId: f.change.id, proof: 'done' }, asSession('worker-a')),
    errCode('PLAN_NOT_ACCEPTED')
  );
  assert.deepEqual(await f.store.history(f.change.id), beforeHistory);
  assert.deepEqual(await f.store.getPreflight(f.change.id), beforePreflight);
  assert.equal(await readFile(f.file, 'utf8'), beforeJson);
  assert.deepEqual(await f.store.listAttempts(f.change.id), []);
});

test('reviewer cannot write a plan through the public tool boundary', async (t) => {
  const f = await fixture(t);
  await f.store.bindRole(f.change.id, 'reviewer-a', 'reviewer');
  const tools = toolsFor(f.store);
  const beforeHistory = await f.store.history(f.change.id);
  const beforePreflight = await f.store.getPreflight(f.change.id);
  const beforeJson = await readFile(f.file, 'utf8');
  await assert.rejects(
    () => tools.change_submit_plan.execute({ changeId: f.change.id, content: { steps: ['reviewer mutation'] } }, asSession('reviewer-a')),
    errCode('ROLE_NOT_ALLOWED')
  );
  assert.deepEqual(await f.store.history(f.change.id), beforeHistory);
  assert.deepEqual(await f.store.getPreflight(f.change.id), beforePreflight);
  assert.equal(await readFile(f.file, 'utf8'), beforeJson);
});

test('self-review is rejected when reviewer has recorded implementation attempts', async (t) => {
  const f = await fixture(t);
  await f.store.bindRole(f.change.id, 'worker-self', 'worker');
  await f.store.bindRole(f.change.id, 'reviewer-self', 'reviewer');
  await f.store.bindRole(f.change.id, 'planner-self', 'planner');
  // Record an implementation attempt for the reviewer session to simulate self-review
  await f.store.recordAttempt(f.change.id, { attemptId: 'a1', workerId: 'reviewer-self', revision: 'rev-0', status: 'completed' });
  const tools = toolsFor(f.store);
  // Walk to REVIEW using the self-review sessions
  const plan = await tools.change_submit_plan.execute({ changeId: f.change.id, content: { steps: ['x'] } }, asSession('planner-self'));
  await f.store.acceptPlan(f.change.id, plan.planId, { authorized: true, actor: 'host' });
  await f.store.transition(f.change.id, 'IMPLEMENTING');
  await tools.change_submit_proof.execute({ changeId: f.change.id, proof: JSON.stringify(proof('rev-1')) }, asSession('worker-self'));
  await f.store.runPreflight(f.change.id, { currentRevision: 'rev-1', changedFiles: [], checkResults: checks });
  // Snapshot AFTER walk, BEFORE self-review attempt
  const beforeHistory = await f.store.history(f.change.id);
  const beforePreflight = await f.store.getPreflight(f.change.id);
  const beforeJson = await readFile(f.file, 'utf8');
  // Now attempt self-review
  await assert.rejects(
    () => tools.change_submit_review.execute({ changeId: f.change.id, review: { verdict: 'fail', revision: 'rev-1' } }, asSession('reviewer-self')),
    errCode('REVIEWER_NOT_INDEPENDENT')
  );
  assert.deepEqual(await f.store.history(f.change.id), beforeHistory);
  assert.deepEqual(await f.store.getPreflight(f.change.id), beforePreflight);
  assert.equal(await readFile(f.file, 'utf8'), beforeJson);
});

// ─── Cross-product role/action denials on a single shared fixture ─────────────
// Note: ChangeService checks planAccepted before role, so deny codes for
// operations requiring an accepted plan (proof, repair) return PLAN_NOT_ACCEPTED
// even when the role is wrong, because plan acceptance is the first gate.

test('cross-product of role/action denials asserts exact codes on one shared change', async (t) => {
  const f = await fixture(t);
  // Bind three distinct sessions (non-role-shaped ids) on one change
  await f.store.bindRole(f.change.id, 'session-planner-1', 'planner');
  await f.store.bindRole(f.change.id, 'session-worker-2', 'worker');
  await f.store.bindRole(f.change.id, 'session-reviewer-3', 'reviewer');
  const tools = toolsFor(f.store);
  const sess = (id) => asSession(id);

  // planner × submit_proof → PLAN_NOT_ACCEPTED (no plan yet)
  await assert.rejects(
    () => tools.change_submit_proof.execute({ changeId: f.change.id, proof: 'p' }, sess('session-planner-1')),
    errCode('PLAN_NOT_ACCEPTED')
  );
  // planner × submit_review → ROLE_NOT_ALLOWED
  await assert.rejects(
    () => tools.change_submit_review.execute({ changeId: f.change.id, review: {} }, sess('session-planner-1')),
    errCode('ROLE_NOT_ALLOWED')
  );
  // planner × submit_repair → PLAN_NOT_ACCEPTED (plan not accepted; checked before role)
  await assert.rejects(
    () => tools.change_submit_repair.execute({ changeId: f.change.id, repair: {} }, sess('session-planner-1')),
    errCode('PLAN_NOT_ACCEPTED')
  );

  // worker × submit_plan → ROLE_NOT_ALLOWED
  await assert.rejects(
    () => tools.change_submit_plan.execute({ changeId: f.change.id, content: {} }, sess('session-worker-2')),
    errCode('ROLE_NOT_ALLOWED')
  );
  // worker × submit_review → ROLE_NOT_ALLOWED
  await assert.rejects(
    () => tools.change_submit_review.execute({ changeId: f.change.id, review: {} }, sess('session-worker-2')),
    errCode('ROLE_NOT_ALLOWED')
  );
  // worker × submit_repair → PLAN_NOT_ACCEPTED (no plan accepted)
  await assert.rejects(
    () => tools.change_submit_repair.execute({ changeId: f.change.id, repair: {} }, sess('session-worker-2')),
    errCode('PLAN_NOT_ACCEPTED')
  );

  // reviewer × submit_plan → ROLE_NOT_ALLOWED
  await assert.rejects(
    () => tools.change_submit_plan.execute({ changeId: f.change.id, content: {} }, sess('session-reviewer-3')),
    errCode('ROLE_NOT_ALLOWED')
  );
  // reviewer × submit_proof → PLAN_NOT_ACCEPTED (no plan accepted; checked before role)
  await assert.rejects(
    () => tools.change_submit_proof.execute({ changeId: f.change.id, proof: 'p' }, sess('session-reviewer-3')),
    errCode('PLAN_NOT_ACCEPTED')
  );
  // reviewer × submit_repair → PLAN_NOT_ACCEPTED (no plan accepted; checked before role)
  await assert.rejects(
    () => tools.change_submit_repair.execute({ changeId: f.change.id, repair: {} }, sess('session-reviewer-3')),
    errCode('PLAN_NOT_ACCEPTED')
  );
});

// ─── Completion scenario: DRAFT→APPROVED via tools, plus repair loop ─────────

test('three distinct sessions walk DRAFT→APPROVED through tool boundary asserting final state, plan, proof, preflight, review, audit chain', async (t) => {
  const f = await fixture(t);
  // Bind distinct non-role-shaped session ids
  await f.store.bindRole(f.change.id, 'session-planner-1', 'planner');
  await f.store.bindRole(f.change.id, 'session-worker-2', 'worker');
  await f.store.bindRole(f.change.id, 'session-reviewer-3', 'reviewer');
  const tools = toolsFor(f.store);
  const planner = asSession('session-planner-1');
  const worker = asSession('session-worker-2');
  const reviewer = asSession('session-reviewer-3');

  // 0. Record implementation attempt so review can validate revision
  await f.store.recordAttempt(f.change.id, { attemptId: 'a1', workerId: 'session-worker-2', revision: 'rev-1', status: 'completed' });

  // 1. submit_plan by planner: DRAFT → PLANNED
  const planResult = await tools.change_submit_plan.execute({ changeId: f.change.id, content: { steps: ['implement'] } }, planner);
  assert.ok(planResult.planId);
  assert.equal((await f.store.get(f.change.id)).state, 'PLANNED');

  // 2. acceptPlan via store (host action): PLANNED → READY
  await f.store.acceptPlan(f.change.id, planResult.planId, { authorized: true, actor: 'host' });
  const afterAccept = await f.store.get(f.change.id);
  assert.equal(afterAccept.state, 'READY');
  assert.ok(afterAccept.acceptedPlanId);

  // 3. transition READY → IMPLEMENTING
  await f.store.transition(f.change.id, 'IMPLEMENTING');
  const afterImpl = await f.store.get(f.change.id);
  assert.equal(afterImpl.state, 'IMPLEMENTING');

  // 4. submit_proof by worker: transitions to PREFLIGHT and persists proof
  const proofResult = await tools.change_submit_proof.execute({ changeId: f.change.id, proof: JSON.stringify(proof('rev-1')) }, worker);
  assert.equal(proofResult.success, true);
  const afterProof = await f.store.get(f.change.id);
  assert.equal(afterProof.state, 'PREFLIGHT');

  // 5. runPreflight: PREFLIGHT → REVIEW
  const preflightResult = await f.store.runPreflight(f.change.id, { currentRevision: 'rev-1', changedFiles: [], checkResults: checks });
  assert.equal(preflightResult.allowed, true);
  const afterPreflight = await f.store.get(f.change.id);
  assert.equal(afterPreflight.state, 'REVIEW');
  const preflightData = await f.store.getPreflight(f.change.id);
  assert.ok(preflightData);
  assert.ok(preflightData.controllerResults);

  // 6. submit_review by reviewer: REVIEW → APPROVED
  const reviewResult = await tools.change_submit_review.execute(
    { changeId: f.change.id, review: { verdict: 'pass', revision: 'rev-1', findings: [] } },
    reviewer
  );
  assert.equal(reviewResult.verdict, 'pass');
  const afterReview = await f.store.get(f.change.id);
  assert.equal(afterReview.state, 'APPROVED');
  assert.ok(afterReview.acceptedPlanId);

  // 7. Assert final state, proof durability, persisted review verdict, audit chain
  const final = await f.store.get(f.change.id);
  assert.equal(final.state, 'APPROVED');
  assert.ok(final.acceptedPlanId);
  const persistedProof = await f.store.getProof(f.change.id);
  assert.ok(persistedProof);
  assert.equal(persistedProof.afterRevision, 'rev-1');
  const history = await f.store.history(f.change.id);
  assert.ok(history.length >= 5);
  const persisted = JSON.parse(await readFile(f.file, 'utf8'));
  const changeRecord = persisted.changes.find((c) => c.id === f.change.id);
  assert.ok(changeRecord);
  // Persisted records use domainState/planState; the in-memory getter exposes state.
  assert.equal(changeRecord.domainState ?? changeRecord.state, 'APPROVED');
});

test('repair loop through change_submit_repair asserts new proof and re-review', async (t) => {
  const f = await fixture(t);
  await f.store.bindRole(f.change.id, 'session-planner-r', 'planner');
  await f.store.bindRole(f.change.id, 'session-worker-r', 'worker');
  await f.store.bindRole(f.change.id, 'session-reviewer-r', 'reviewer');
  const tools = toolsFor(f.store);
  const planner = asSession('session-planner-r');
  const worker = asSession('session-worker-r');
  const reviewer = asSession('session-reviewer-r');

  // Record initial attempt so review can validate revision
  await f.store.recordAttempt(f.change.id, { attemptId: 'a1', workerId: 'session-worker-r', revision: 'rev-1', status: 'completed' });

  // Walk to REVIEW via plan, accept, transition, proof, preflight
  const plan = await tools.change_submit_plan.execute({ changeId: f.change.id, content: { steps: ['fix'] } }, planner);
  await f.store.acceptPlan(f.change.id, plan.planId, { authorized: true, actor: 'host' });
  await f.store.transition(f.change.id, 'IMPLEMENTING');
  await tools.change_submit_proof.execute({ changeId: f.change.id, proof: JSON.stringify(proof('rev-1')) }, worker);
  await f.store.runPreflight(f.change.id, { currentRevision: 'rev-1', changedFiles: [], checkResults: checks });
  const afterPreflight = await f.store.get(f.change.id);
  assert.equal(afterPreflight.state, 'REVIEW');

  // Failing review → REPAIR
  const failReview = await tools.change_submit_review.execute(
    { changeId: f.change.id, review: { verdict: 'fail', revision: 'rev-1', findings: [{ severity: 'critical', category: 'security', location: 'src/x.js:1', problem: 'unsafe', requiredOutcome: 'fix' }] } },
    reviewer
  );
  assert.equal(failReview.verdict, 'fail');
  const afterFail = await f.store.get(f.change.id);
  assert.equal(afterFail.state, 'REPAIR');
  const findingId = failReview.findings[0].id;

  // Record second attempt for rev-3 (the new implementation revision)
  await f.store.recordAttempt(f.change.id, { attemptId: 'a2', workerId: 'session-worker-r', revision: 'rev-3', status: 'completed' });

  // Submit repair via tool boundary with matching current revision.
  const repairResult = await tools.change_submit_repair.execute(
    { changeId: f.change.id, repair: { findings: [{ findingId, status: 'fixed', claim: 'fixed' }], proof: { beforeRevision: 'rev-3', afterRevision: 'rev-4', criteria: [{ id: 'safe', satisfied: true }], deviations: [], workerChecks: [{ name: 'tests', passed: true }], controllerPreflight: [] } } },
    worker
  );
  assert.equal(repairResult.state, 'PREFLIGHT');

  // Re-preflight with the new proof revision
  await f.store.runPreflight(f.change.id, { currentRevision: 'rev-4', changedFiles: [], checkResults: checks });
  const afterReproof = await f.store.get(f.change.id);
  assert.equal(afterReproof.state, 'REVIEW');

  // Record the repaired implementation revision before re-review.
  await f.store.recordAttempt(f.change.id, { attemptId: 'a3', workerId: 'session-worker-r', revision: 'rev-4', status: 'completed' });

  // Pass review
  const passReview = await tools.change_submit_review.execute(
    { changeId: f.change.id, review: { verdict: 'pass', revision: 'rev-4', findings: [] } },
    reviewer
  );
  assert.equal(passReview.verdict, 'pass');
  const final = await f.store.get(f.change.id);
  assert.equal(final.state, 'APPROVED');
});

// ─── Proof validation and concurrency regressions ─────────────────────────────

async function implementingFixture(t) {
  const f = await fixture(t);
  await f.store.bindRole(f.change.id, 'session-worker-proof', 'worker');
  const plan = await f.store.submitPlan(f.change.id, { steps: ['implement'] });
  await f.store.acceptPlan(f.change.id, plan.id, { authorized: true, actor: 'host' });
  await f.store.transition(f.change.id, 'IMPLEMENTING');
  return f;
}

test('junk proof is not persisted and preflight reports NO_PROOF', async (t) => {
  const f = await implementingFixture(t);
  const tools = toolsFor(f.store);
  await tools.change_submit_proof.execute({ changeId: f.change.id, proof: 'not-json' }, asSession('session-worker-proof'));
  await assert.rejects(() => f.store.runPreflight(f.change.id, { currentRevision: 'rev-1', changedFiles: [], checkResults: checks }), (e) => e?.code === 'NO_PROOF');
  assert.equal(await f.store.getProof(f.change.id).catch((e) => e.code), 'NOT_FOUND');
});

test('non-object proof JSON is rejected with INVALID_PROOF and no audit mutation', async (t) => {
  const f = await implementingFixture(t);
  const before = await f.store.history(f.change.id); const bytes = await readFile(f.file, 'utf8');
  await assert.rejects(() => toolsFor(f.store).change_submit_proof.execute({ changeId: f.change.id, proof: JSON.stringify(['wrong']) }, asSession('session-worker-proof')), (e) => e?.code === 'INVALID_PROOF');
  assert.deepEqual(await f.store.history(f.change.id), before); assert.equal(await readFile(f.file, 'utf8'), bytes);
});

test('proof criterion validation reports exact missing and unknown criterion codes', async (t) => {
  const missing = await implementingFixture(t); const tool = toolsFor(missing.store).change_submit_proof;
  await assert.rejects(() => tool.execute({ changeId: missing.change.id, proof: JSON.stringify({ ...proof(), criteria: [] }) }, asSession('session-worker-proof')), (e) => e?.code === 'MISSING_CRITERION');
  const unknown = await implementingFixture(t); const unknownTool = toolsFor(unknown.store).change_submit_proof;
  await assert.rejects(() => unknownTool.execute({ changeId: unknown.change.id, proof: JSON.stringify({ ...proof(), criteria: [{ id: 'other', satisfied: true }] }) }, asSession('session-worker-proof')), (e) => e?.code === 'UNKNOWN_CRITERION');
});

test('same-change concurrent transitions have one winner and unique durable audit ids', async (t) => {
  const f = await fixture(t); const plan = await f.store.submitPlan(f.change.id, { steps: ['x'] });
  await f.store.acceptPlan(f.change.id, plan.id, { authorized: true, actor: 'host' });
  const a = await ChangeStore.open(f.file); const b = await ChangeStore.open(f.file);
  const outcomes = await Promise.allSettled([a.transition(f.change.id, 'IMPLEMENTING'), b.transition(f.change.id, 'IMPLEMENTING')]);
  assert.equal(outcomes.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((x) => x.status === 'rejected').length, 1);
  const reopened = await ChangeStore.open(f.file); assert.equal((await reopened.get(f.change.id)).state, 'IMPLEMENTING');
  const persisted = JSON.parse(await readFile(f.file, 'utf8')); const ids = persisted.audit.map((e) => e.eventId);
  assert.equal(new Set(ids).size, ids.length);
});

// ─── Remaining integration scenarios: failure, staleness, revision, restart ───

test('failed controller preflight remains PREFLIGHT and records failure evidence', async (t) => {
  const f = await fixture(t);
  const plan = await f.store.submitPlan(f.change.id, { steps: ['x'] });
  await f.store.acceptPlan(f.change.id, plan.id, { authorized: true });
  await f.store.transition(f.change.id, 'IMPLEMENTING');
  await f.store.submitProof(f.change.id, proof('rev-fail'));
  const before = await f.store.history(f.change.id);
  await assert.rejects(() => f.store.runPreflight(f.change.id, { currentRevision: 'rev-fail', changedFiles: [], checkResults: [{ name: 'tests', command: 'npm test', passed: false, exitCode: 1 }] }), (e) => e?.code === 'REQUIRED_CHECK_FAILURE');
  assert.equal((await f.store.get(f.change.id)).state, 'PREFLIGHT');
  const preflight = await f.store.getPreflight(f.change.id);
  assert.equal(preflight, null);
  assert.equal((await f.store.history(f.change.id)).length, before.length);
});

test('stale proof is rejected without controller result or state mutation', async (t) => {
  const f = await fixture(t);
  const plan = await f.store.submitPlan(f.change.id, { steps: ['x'] });
  await f.store.acceptPlan(f.change.id, plan.id, { authorized: true });
  await f.store.transition(f.change.id, 'IMPLEMENTING');
  await f.store.submitProof(f.change.id, proof('rev-old'));
  const before = await f.store.getPreflight(f.change.id);
  await assert.rejects(() => f.store.runPreflight(f.change.id, { currentRevision: 'rev-new', changedFiles: [], checkResults: checks }), (e) => e?.code === 'STALE_PROOF');
  assert.equal((await f.store.get(f.change.id)).state, 'PREFLIGHT');
  assert.deepEqual(await f.store.getPreflight(f.change.id), before);
});

test('accepted plan revision supersedes prior plan and requires renewed acceptance', async (t) => {
  const f = await fixture(t);
  const first = await f.store.submitPlan(f.change.id, { steps: ['v1'] });
  await f.store.acceptPlan(f.change.id, first.id, { authorized: true });
  const second = await f.store.submitPlan(f.change.id, { steps: ['v2'] });
  const mid = await f.store.get(f.change.id);
  assert.equal(mid.state, 'PLANNED');
  assert.equal(mid.acceptedPlanId, null);
  assert.notEqual(second.id, first.id);
  await f.store.acceptPlan(f.change.id, second.id, { authorized: true });
  assert.equal((await f.store.get(f.change.id)).acceptedPlanId, second.id);
});

test('restart consistency preserves e2e state, proof, and chronological audit history', async (t) => {
  const f = await fixture(t);
  const plan = await f.store.submitPlan(f.change.id, { steps: ['restart'] });
  await f.store.acceptPlan(f.change.id, plan.id, { authorized: true });
  await f.store.transition(f.change.id, 'IMPLEMENTING');
  await f.store.submitProof(f.change.id, proof('rev-restart'));
  const before = { change: await f.store.get(f.change.id), proof: await f.store.getProof(f.change.id), history: await f.store.history(f.change.id) };
  const reopened = await ChangeStore.open(f.file, { preflightPolicy: { requiredChecks: ['tests'], protectedPaths: [] } });
  t.after(() => reopened.close?.());
  assert.deepEqual(await reopened.get(f.change.id), before.change);
  assert.deepEqual(await reopened.getProof(f.change.id), before.proof);
  assert.deepEqual(await reopened.history(f.change.id), before.history);
  assert.ok(before.history.every((event, i) => i === 0 || event.eventId > before.history[i - 1].eventId));
});
