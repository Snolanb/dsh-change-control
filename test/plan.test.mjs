import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChangeStore } from '../src/storage/change-store.js';

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-plan-'));
  const store = await ChangeStore.open(join(dir, 'changes.json'));
  const change = await store.create({ title: 'Ship plans' });
  return {
    store,
    change,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

const firstPlan = {
  objective: 'Deploy safely',
  steps: ['build', 'verify', 'release'],
};

async function withChange(t) {
  const state = await setup();
  t.after(state.cleanup);
  return state;
}

test('submitting a plan stores an immutable revision and moves DRAFT to PLANNED', async (t) => {
  const { store, change } = await withChange(t);

  const plan = await store.submitPlan(change.id, firstPlan);

  assert.equal(plan.changeId, change.id);
  assert.equal(plan.status, 'PLANNED');
  assert.equal(plan.revision, 1);
  assert.ok(plan.id);
  assert.ok(plan.digest);
  assert.deepEqual(plan.content, firstPlan);
  assert.equal((await store.get(change.id)).state, 'PLANNED');
});

test('plan digest is stable for identical content and changes with content', async (t) => {
  const { store, change } = await withChange(t);

  const first = await store.submitPlan(change.id, firstPlan);
  const second = await store.submitPlan(change.id, { ...firstPlan, steps: ['build', 'verify', 'release'] });

  assert.equal(first.digest, second.digest);
  assert.notEqual(first.id, second.id);
});

test('authorized acceptance marks plan ACCEPTED and moves PLANNED to READY', async (t) => {
  const { store, change } = await withChange(t);
  const plan = await store.submitPlan(change.id, firstPlan);

  const accepted = await store.acceptPlan(change.id, plan.id, { authorized: true });

  assert.equal(accepted.status, 'ACCEPTED');
  assert.equal((await store.get(change.id)).acceptedPlanId, plan.id);
  assert.equal((await store.get(change.id)).state, 'READY');
});

test('accepted plan content cannot be modified', async (t) => {
  const { store, change } = await withChange(t);
  const plan = await store.submitPlan(change.id, firstPlan);
  await store.acceptPlan(change.id, plan.id, { authorized: true });

  await assert.rejects(
    store.updatePlan(plan.id, { ...firstPlan, objective: 'Altered after acceptance' }),
    /immutable|accepted|cannot.*modif/i,
  );
});

test('post-acceptance revision supersedes prior plan, returns Change to PLANNED, and needs acceptance', async (t) => {
  const { store, change } = await withChange(t);
  const first = await store.submitPlan(change.id, firstPlan);
  await store.acceptPlan(change.id, first.id, { authorized: true });

  const revised = await store.submitPlan(change.id, { ...firstPlan, objective: 'Deploy with rollback' });

  assert.equal(revised.revision, 2);
  assert.equal(revised.status, 'PLANNED');
  assert.equal(revised.supersedesPlanId, first.id);
  assert.equal((await store.get(change.id)).state, 'PLANNED');
  assert.equal((await store.get(change.id)).acceptedPlanId, null);
});

test('all plan revisions and statuses remain retrievable', async (t) => {
  const { store, change } = await withChange(t);
  const first = await store.submitPlan(change.id, firstPlan);
  await store.acceptPlan(change.id, first.id, { authorized: true });
  const revised = await store.submitPlan(change.id, { ...firstPlan, objective: 'Deploy with rollback' });

  const revisions = await store.listPlans(change.id);

  assert.equal(revisions.length, 2);
  assert.deepEqual(revisions.map(({ id }) => id), [first.id, revised.id]);
  assert.equal(revisions[0].status, 'SUPERSEDED');
  assert.equal(revisions[1].status, 'PLANNED');
  assert.deepEqual(await store.getPlan(first.id), revisions[0]);
  assert.deepEqual(await store.getPlan(revised.id), revisions[1]);
});

test('second ChangeStore instance sees plans submitted by first instance', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-plan-multi-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'changes.json');

  // Store A drives the full lifecycle
  const storeA = await ChangeStore.open(file);
  const change = await storeA.create({ title: 'Multi-instance' });
  const plan1 = await storeA.submitPlan(change.id, firstPlan);
  await storeA.acceptPlan(change.id, plan1.id, { authorized: true });
  const plan2 = await storeA.submitPlan(change.id, { ...firstPlan, objective: 'Deploy v2' });

  // Store B reopens the same file
  const storeB = await ChangeStore.open(file);

  // Change state is correct
  const cB = await storeB.get(change.id);
  assert.equal(cB.state, 'PLANNED');
  assert.equal(cB.acceptedPlanId, null);

  // Both plan revisions are visible with correct statuses
  const revisionsB = await storeB.listPlans(change.id);
  assert.equal(revisionsB.length, 2);
  assert.equal(revisionsB[0].status, 'SUPERSEDED');
  assert.equal(revisionsB[0].id, plan1.id);
  assert.equal(revisionsB[1].status, 'PLANNED');
  assert.equal(revisionsB[1].id, plan2.id);

  // getPlan resolves both revisions
  assert.deepEqual(await storeB.getPlan(plan1.id), revisionsB[0]);
  assert.deepEqual(await storeB.getPlan(plan2.id), revisionsB[1]);

  // Store B can accept the pending plan
  const acceptedB = await storeB.acceptPlan(change.id, plan2.id, { authorized: true });
  assert.equal(acceptedB.status, 'ACCEPTED');
  const cBAccepted = await storeB.get(change.id);
  assert.equal(cBAccepted.state, 'READY');
  assert.equal(cBAccepted.acceptedPlanId, plan2.id);
});
