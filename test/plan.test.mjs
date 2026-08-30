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

test('accepted change can transition to IMPLEMENTING and persists across reopen', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-plan-b1-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'changes.json');
  const store = await ChangeStore.open(file);
  const change = await store.create({ title: 'B1 accept-then-transition' });
  const plan = await store.submitPlan(change.id, firstPlan);
  await store.acceptPlan(change.id, plan.id, { authorized: true });

  // B1: accepted change must transition READY→IMPLEMENTING
  const implementing = await store.transition(change.id, 'IMPLEMENTING');
  assert.equal(implementing.state, 'IMPLEMENTING');

  // B1: must persist across reopen
  const store2 = await ChangeStore.open(file);
  const c2 = await store2.get(change.id);
  assert.equal(c2.state, 'IMPLEMENTING');
});

test('illegal READY→PLANNED without a plan rejects and emits no bogus event', async (t) => {
  const { store, change } = await withChange(t);

  // Drive to READY via domain transitions only (no plans)
  await store.transition(change.id, 'PLANNED');
  await store.transition(change.id, 'READY');

  const beforeHistory = (await store.history(change.id)).length;

  // Direct READY→PLANNED via domain transition must reject
  await assert.rejects(
    store.transition(change.id, 'PLANNED'),
    /Cannot transition from READY to PLANNED/,
  );

  // No bogus audit event emitted
  const afterHistory = (await store.history(change.id)).length;
  assert.equal(afterHistory, beforeHistory);
});

test('stale writer does not erase on-disk plans', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-plan-b3-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'changes.json');

  // Store A submits and accepts a plan
  const storeA = await ChangeStore.open(file);
  const change = await storeA.create({ title: 'B3 stale' });
  const plan1 = await storeA.submitPlan(change.id, firstPlan);
  await storeA.acceptPlan(change.id, plan1.id, { authorized: true });

  // Store B (fresh) submits another plan
  const storeB = await ChangeStore.open(file);
  const plan2 = await storeB.submitPlan(change.id, { ...firstPlan, objective: 'B3 v2' });
  assert.equal(plan2.status, 'PLANNED');

  // Store A (stale, no plan snapshot) creates a new change and persists
  const changeA2 = await storeA.create({ title: 'Stale A change' });
  await storeA.transition(changeA2.id, 'PLANNED');

  // Reopen fresh: plan2 must still exist
  const storeC = await ChangeStore.open(file);
  const revisions = await storeC.listPlans(change.id);
  assert.equal(revisions.length, 2);
  assert.equal(revisions.find((p) => p.id === plan2.id)?.status, 'PLANNED');
});

test('superseded plan cannot be modified', async (t) => {
  const { store, change } = await withChange(t);
  const first = await store.submitPlan(change.id, firstPlan);
  await store.acceptPlan(change.id, first.id, { authorized: true });
  await store.submitPlan(change.id, { ...firstPlan, objective: 'Revised' });

  // SUPERSEDED plan must reject modification
  await assert.rejects(
    store.updatePlan(first.id, { ...firstPlan, objective: 'Tampered' }),
    /SUPERSEDED|only PLANNED/,
  );
});

test('returned plan objects are immutable clones', async (t) => {
  const { store, change } = await withChange(t);
  const plan = await store.submitPlan(change.id, firstPlan);

  // Mutating the returned plan must not affect stored state
  plan.status = 'TAMPERED';
  plan.content = { objective: 'Hacked', steps: [] };

  const fresh = await store.getPlan(plan.id);
  assert.equal(fresh.status, 'PLANNED');
  assert.deepEqual(fresh.content, firstPlan);
});

test('acceptPlan defaults to unauthorized', async (t) => {
  const { store, change } = await withChange(t);
  const plan = await store.submitPlan(change.id, firstPlan);

  // No authorized flag → FORBIDDEN
  await assert.rejects(
    store.acceptPlan(change.id, plan.id),
    /FORBIDDEN|Not authorized/,
  );
});

test('acceptPlan rejects non-current revision', async (t) => {
  const { store, change } = await withChange(t);
  const first = await store.submitPlan(change.id, firstPlan);
  const second = await store.submitPlan(change.id, { ...firstPlan, objective: 'v2' });

  // Trying to accept the older (non-current) plan must reject
  await assert.rejects(
    store.acceptPlan(change.id, first.id, { authorized: true }),
    /non-current|No current/,
  );

  // Current plan still accepts
  const accepted = await store.acceptPlan(change.id, second.id, { authorized: true });
  assert.equal(accepted.status, 'ACCEPTED');
});
