import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChangeStore } from '../src/storage/change-store.js';

async function setup(t, budgetPolicy = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-budget-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'changes.json');
  const store = await ChangeStore.open(file, { budgetPolicy });
  const change = await store.create({ title: 'budgeted change' });
  return { file, store, change };
}

// AC1: all execution counters are durable, including the review round and failures.
test('persists implementation, repair, review-round, review-failure, and preflight-failure counters', async (t) => {
  const { file, store, change } = await setup(t);
  await store.recordBudgetEvent(change.id, 'implementation');
  await store.recordBudgetEvent(change.id, 'repair');
  await store.recordBudgetEvent(change.id, 'reviewRound');
  await store.recordBudgetEvent(change.id, 'reviewFailure');
  await store.recordBudgetEvent(change.id, 'preflightFailure');

  const reopened = await ChangeStore.open(file);
  assert.deepEqual(await reopened.getBudget(change.id), {
    implementationAttempts: 1,
    repairAttempts: 1,
    reviewRounds: 1,
    reviewFailures: 1,
    preflightFailures: 1,
    escalated: false,
  });
});

// AC2: thresholds are host policy, not model-provided values.
test('host budget policy exposes maxRepairAttempts and maxReviewFailures', async (t) => {
  const { store, change } = await setup(t, { maxRepairAttempts: 2, maxReviewFailures: 3 });
  assert.deepEqual((await store.getBudget(change.id)).limits, {
    maxRepairAttempts: 2,
    maxReviewFailures: 3,
  });
});

// AC3: threshold breaches explicitly escalate and stop further loop work.
test('threshold breach records escalation and stops silent continuation', async (t) => {
  const { store, change } = await setup(t, { maxRepairAttempts: 1, maxReviewFailures: 1 });
  await store.recordBudgetEvent(change.id, 'repair');
  const result = await store.recordBudgetEvent(change.id, 'repair');
  assert.equal(result.escalated, true);
  assert.equal(result.continue, false);
  assert.equal((await store.getBudget(change.id)).escalation.reason, 'maxRepairAttempts');
  assert.ok((await store.history(change.id)).some((event) => event.type === 'BUDGET_ESCALATED'));
});

// AC4: model-facing operations cannot reset durable counters.
test('rejects model counter resets and leaves budget unchanged', async (t) => {
  const { store, change } = await setup(t);
  await store.recordBudgetEvent(change.id, 'implementation');
  await assert.rejects(() => store.resetBudget(change.id, { actorType: 'model' }), /host|reset|denied/i);
  assert.equal((await store.getBudget(change.id)).implementationAttempts, 1);
});

// AC5: escalation contains no provider/model identity and applies across providers.
test('escalation is provider-neutral', async (t) => {
  const { store, change } = await setup(t, { maxReviewFailures: 0 });
  const result = await store.recordBudgetEvent(change.id, 'reviewFailure', { provider: 'provider-a', model: 'model-a' });
  assert.equal(result.escalated, true);
  const escalation = (await store.getBudget(change.id)).escalation;
  assert.equal(escalation.provider, undefined);
  assert.equal(escalation.model, undefined);
  assert.equal(await store.canContinue(change.id, { provider: 'provider-b', model: 'model-b' }), false);
});

// AC6: only an identified human may override, and the override is audited.
test('human override is explicitly audited', async (t) => {
  const { store, change } = await setup(t, { maxRepairAttempts: 0 });
  await store.recordBudgetEvent(change.id, 'repair');
  await assert.rejects(() => store.overrideBudget(change.id, { actorType: 'model', actor: 'worker' }), /human|denied/i);
  await store.overrideBudget(change.id, { actorType: 'human', actor: 'ops@example.test', reason: 'incident approved' });
  assert.equal((await store.getBudget(change.id)).override.actor, 'ops@example.test');
  const events = await store.history(change.id);
  assert.ok(events.some((event) => event.type === 'BUDGET_OVERRIDE' && event.actor === 'ops@example.test'));
});

// BLR-001: an audited human override grants runway beyond the breached limit and survives restart.
test('human override waives breached limit and persists continued runway', async (t) => {
  const { file, store, change } = await setup(t, { maxRepairAttempts: 1 });
  await store.recordBudgetEvent(change.id, 'repair');
  await store.recordBudgetEvent(change.id, 'repair');
  assert.equal(await store.canContinue(change.id), false);
  const overridden = await store.overrideBudget(change.id, { actorType: 'human', actor: 'ops@example.test', reason: 'incident approved' });
  assert.deepEqual(overridden.override.waived, ['maxRepairAttempts']);
  assert.equal(await store.canContinue(change.id), true);
  for (let i = 0; i < 3; i++) assert.deepEqual(await store.recordBudgetEvent(change.id, 'repair'), { escalated: false, continue: true });
  const reopened = await ChangeStore.open(file, { budgetPolicy: { maxRepairAttempts: 1 } });
  assert.equal(await reopened.canContinue(change.id), true);
  assert.equal((await reopened.getBudget(change.id)).repairAttempts, 5);
  assert.ok((await reopened.history(change.id)).some((event) => event.type === 'BUDGET_OVERRIDE' && event.waivedLimits.includes('maxRepairAttempts')));
});

// BLR-002: host policy rejects unknown keys and invalid values before any state exists.
test('rejects unsupported and negative budget policy values', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-budget-policy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(() => ChangeStore.open(join(dir, 'unknown.json'), { budgetPolicy: { maxReviewRounds: 1 } }), { code: 'INVALID_BUDGET_POLICY' });
  await assert.rejects(() => ChangeStore.open(join(dir, 'negative.json'), { budgetPolicy: { maxRepairAttempts: -1 } }), { code: 'INVALID_BUDGET_POLICY' });
});

// BLR-003: concurrent store instances retain every additive counter increment.
test('retains concurrent budget increments across ChangeStore instances', async (t) => {
  const { file, store, change } = await setup(t);
  const second = await ChangeStore.open(file);
  await Promise.all([
    ...Array.from({ length: 20 }, () => store.recordBudgetEvent(change.id, 'repair')),
    ...Array.from({ length: 20 }, () => second.recordBudgetEvent(change.id, 'repair')),
  ]);
  const reopened = await ChangeStore.open(file);
  assert.equal((await reopened.getBudget(change.id)).repairAttempts, 40);
});
