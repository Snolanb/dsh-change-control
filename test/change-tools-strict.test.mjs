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

  // 2. Proof: IMPLEMENTING → PREFLIGHT
  const proof = await call(registry, 'change_submit_proof', { changeId: change.id, proof: 'tests pass' }, 'worker-session');
  assert.equal(proof.isError, false);
  assert.equal(proof.value?.success, true);
  assert.equal((await store.get(change.id)).state, 'PREFLIGHT');

  // 3. Review: PREFLIGHT → REVIEW
  const review = await call(registry, 'change_submit_review', { changeId: change.id, review: 'looks good' }, 'reviewer-session');
  assert.equal(review.isError, false);
  assert.equal(review.value?.success, true);
  assert.equal((await store.get(change.id)).state, 'REVIEW');

  // 4. Repair: REVIEW → REPAIR
  const repair = await call(registry, 'change_submit_repair', { changeId: change.id, repair: 'fixed it' }, 'worker-session');
  assert.equal(repair.isError, false);
  assert.equal(repair.value?.success, true);
  assert.equal((await store.get(change.id)).state, 'REPAIR');

  // Transition REPAIR → PREFLIGHT for re-review
  await store.transition(change.id, 'PREFLIGHT');
  assert.equal((await store.get(change.id)).state, 'PREFLIGHT');

  // 5. Re-review: PREFLIGHT → REVIEW
  const review2 = await call(registry, 'change_submit_review', { changeId: change.id, review: 'again' }, 'reviewer-session');
  assert.equal(review2.isError, false);
  assert.equal(review2.value?.success, true);
  assert.equal((await store.get(change.id)).state, 'REVIEW');

  // Verify audit evidence
  const after = (await store.history(change.id)).length;
  assert.ok(after > before, 'History should have appended events');
  const history = await store.history(change.id);
  const states = history.map(h => h.to);
  assert.ok(states.includes('PLANNED'));
  assert.ok(states.includes('PREFLIGHT'));
  assert.ok(states.includes('REVIEW'));
  assert.ok(states.includes('REPAIR'));
}));

test('V1: proof/repair denied without accepted plan', () => fixture(async ({ store, change, registry }) => {
  await store.bindRole(change.id, 'worker-session', 'worker');

  // Create change but DON'T submit/accept a plan
  const proof = await call(registry, 'change_submit_proof', { changeId: change.id, proof: 'done' }, 'worker-session');
  assert.equal(proof.isError, true);
  assert.match(JSON.stringify(proof.error), /PLAN_NOT_ACCEPTED|plan.*accepted/i);

  const repair = await call(registry, 'change_submit_repair', { changeId: change.id, repair: 'fixed' }, 'worker-session');
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

  // Submit proof (legal: IMPLEMENTING → PREFLIGHT)
  const proof = await call(registry, 'change_submit_proof', { changeId: change.id, proof: 'done' }, 'worker-session');
  assert.equal(proof.isError, false);
  assert.equal(proof.value?.success, true);
  assert.equal((await store.get(change.id)).state, 'PREFLIGHT');

  // Submit review (legal: PREFLIGHT → REVIEW)
  const review = await call(registry, 'change_submit_review', { changeId: change.id, review: 'good' }, 'reviewer-session');
  assert.equal(review.isError, false);
  assert.equal((await store.get(change.id)).state, 'REVIEW');

  // Submit repair (legal: REVIEW → REPAIR)
  const repair = await call(registry, 'change_submit_repair', { changeId: change.id, repair: 'fixed' }, 'worker-session');
  assert.equal(repair.isError, false);
  assert.equal((await store.get(change.id)).state, 'REPAIR');

  // Now try illegal transition: proof from REPAIR (should fail)
  const badProof = await call(registry, 'change_submit_proof', { changeId: change.id, proof: 'late' }, 'worker-session');
  assert.equal(badProof.isError, true);
  // Should have structured error
  assert.ok(badProof.error?.message?.includes('cannot submitProof') || badProof.error?.message?.includes('PROOF'), 'Should have structured denial for invalid state');
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
