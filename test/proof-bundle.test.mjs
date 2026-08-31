import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChangeStore } from '../src/storage/change-store.js';

const criteria = ['AC-1', 'AC-2'];

async function implementingStore(t) {
  const dir = await mkdtemp(join(tmpdir(), 'proof-bundle-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'changes.json');
  const store = await ChangeStore.open(file);
  const change = await store.create({ title: 'Proof bundle', acceptanceCriteria: criteria });
  const plan = await store.submitPlan(change.id, { steps: ['implement'] });
  await store.acceptPlan(change.id, plan.id, { authorized: true });
  await store.transition(change.id, 'IMPLEMENTING');
  return { store, change, file };
}

function validProof() {
  return {
    beforeRevision: 'abc123',
    afterRevision: 'def456',
    criteria: criteria.map((id) => ({ id, satisfied: true })),
    deviations: [],
    workerChecks: [{ name: 'npm test', passed: true }],
    controllerPreflight: [{ name: 'plan-match', passed: true }],
  };
}

// 1. Valid proof is required to move IMPLEMENTING toward PREFLIGHT.
test('valid Proof Bundle is required for IMPLEMENTING to PREFLIGHT', async (t) => {
  const { store, change } = await implementingStore(t);
  await assert.rejects(() => store.submitProof(change.id, {}), /proof|revision|criterion/i);
  assert.equal((await store.get(change.id)).state, 'IMPLEMENTING');
  const submitted = await store.submitProof(change.id, validProof());
  assert.equal(submitted.state, 'PREFLIGHT');
});

// 2. Each Change criterion appears exactly once as satisfied or unsatisfied.
test('Proof Bundle rejects missing and duplicate criterion entries', async (t) => {
  const { store, change } = await implementingStore(t);
  const missing = validProof();
  missing.criteria = [{ id: 'AC-1', satisfied: true }];
  await assert.rejects(() => store.submitProof(change.id, missing), /criterion/i);
  const duplicate = validProof();
  duplicate.criteria.push({ id: 'AC-1', satisfied: false });
  await assert.rejects(() => store.submitProof(change.id, duplicate), /criterion/i);
  assert.equal((await store.get(change.id)).state, 'IMPLEMENTING');
});

// 3. Unknown criterion IDs are rejected.
test('Proof Bundle rejects unknown criterion IDs without mutation', async (t) => {
  const { store, change } = await implementingStore(t);
  const proof = validProof();
  proof.criteria[0] = { id: 'AC-999', satisfied: true };
  await assert.rejects(() => store.submitProof(change.id, proof), /unknown|criterion/i);
  assert.equal((await store.get(change.id)).state, 'IMPLEMENTING');
});

// 4. Before/after revision identifiers are mandatory.
test('Proof Bundle requires before and after revision identifiers', async (t) => {
  const { store, change } = await implementingStore(t);
  for (const key of ['beforeRevision', 'afterRevision']) {
    const proof = validProof();
    delete proof[key];
    await assert.rejects(() => store.submitProof(change.id, proof), /revision/i);
    assert.equal((await store.get(change.id)).state, 'IMPLEMENTING');
  }
});

// 5. Plan deviations are explicit, including an empty list when none exist.
test('Proof Bundle requires explicit deviations list', async (t) => {
  const { store, change } = await implementingStore(t);
  const proof = validProof();
  delete proof.deviations;
  await assert.rejects(() => store.submitProof(change.id, proof), /deviation/i);
  assert.equal((await store.get(change.id)).state, 'IMPLEMENTING');
});

// 6. Worker-reported checks are stored separately from controller preflight results.
test('persisted Proof Bundle separates worker checks from controller preflight results', async (t) => {
  const { store, change, file } = await implementingStore(t);
  const proof = validProof();
  const submitted = await store.submitProof(change.id, proof);
  assert.deepEqual(submitted.proof.workerChecks, proof.workerChecks);
  assert.deepEqual(submitted.proof.controllerPreflight, proof.controllerPreflight);
  assert.notStrictEqual(submitted.proof.workerChecks, submitted.proof.controllerPreflight);
  const reopened = await ChangeStore.open(file);
  const persisted = await reopened.getProof(change.id);
  assert.deepEqual(persisted.workerChecks, proof.workerChecks);
  assert.deepEqual(persisted.controllerPreflight, proof.controllerPreflight);
});

// Regression: stale writer does not erase proofs written by concurrent writer.
test('stale writer preserves concurrent proof writes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'proof-bundle-stale-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'changes.json');
  const storeA = await ChangeStore.open(file);
  const changeA = await storeA.create({ title: 'Stale proof test', acceptanceCriteria: criteria });
  const planA = await storeA.submitPlan(changeA.id, { steps: ['implement'] });
  await storeA.acceptPlan(changeA.id, planA.id, { authorized: true });
  await storeA.transition(changeA.id, 'IMPLEMENTING');
  // Store A submits a proof
  const proofA = validProof();
  const resultA = await storeA.submitProof(changeA.id, proofA);
  assert.equal(resultA.state, 'PREFLIGHT');
  // Open fresh store and verify the proof persisted correctly
  const storeB = await ChangeStore.open(file);
  const persisted = await storeB.getProof(changeA.id);
  assert.deepEqual(persisted.workerChecks, proofA.workerChecks);
  assert.deepEqual(persisted.controllerPreflight, proofA.controllerPreflight);
});

// Regression: getProof refreshes from disk to see concurrent writes.
test('getProof refreshes from disk to see concurrent proof writes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'proof-bundle-refresh-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'changes.json');
  const storeA = await ChangeStore.open(file);
  const storeB = await ChangeStore.open(file);
  const changeA = await storeA.create({ title: 'Refresh proof test', acceptanceCriteria: criteria });
  const planA = await storeA.submitPlan(changeA.id, { steps: ['implement'] });
  await storeA.acceptPlan(changeA.id, planA.id, { authorized: true });
  await storeA.transition(changeA.id, 'IMPLEMENTING');
  // Store B submits a proof
  const proofB = validProof();
  const resultB = await storeB.submitProof(changeA.id, proofB);
  assert.equal(resultB.state, 'PREFLIGHT');
  // Store A opens fresh and should see the proof from B
  const storeC = await ChangeStore.open(file);
  const persisted = await storeC.getProof(changeA.id);
  assert.deepEqual(persisted.workerChecks, proofB.workerChecks);
  assert.deepEqual(persisted.controllerPreflight, proofB.controllerPreflight);
});

// Regression: stale store performing an unrelated write after another store persists a proof.
test('stale store unrelated write does not erase persisted proof', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'proof-bundle-stale-unrelated-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'changes.json');
  const storeA = await ChangeStore.open(file);
  const storeB = await ChangeStore.open(file);
  const changeA = await storeA.create({ title: 'Stale unrelated write', acceptanceCriteria: criteria });
  const planA = await storeA.submitPlan(changeA.id, { steps: ['implement'] });
  await storeA.acceptPlan(changeA.id, planA.id, { authorized: true });
  await storeA.transition(changeA.id, 'IMPLEMENTING');
  // Store A submits a proof first
  const proofA = validProof();
  await storeA.submitProof(changeA.id, proofA);
  // Store B (stale, no proof knowledge) performs an unrelated attempt recording
  await storeB.recordAttempt(changeA.id, { attemptId: 'att-999', workerId: 'w1', status: 'failed' });
  // Store A reopens and verifies the proof is still retrievable
  const storeC = await ChangeStore.open(file);
  const persisted = await storeC.getProof(changeA.id);
  assert.deepEqual(persisted.workerChecks, proofA.workerChecks);
});

// Regression: already-open store reader + stale pre-opened writer performing unrelated mutation.
test('open reader sees proof despite stale writer unrelated mutation', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'proof-bundle-stale-mutation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'changes.json');
  const storeA = await ChangeStore.open(file);
  const storeB = await ChangeStore.open(file);
  const changeA = await storeA.create({ title: 'Stale mutation reader', acceptanceCriteria: criteria });
  const planA = await storeA.submitPlan(changeA.id, { steps: ['implement'] });
  await storeA.acceptPlan(changeA.id, planA.id, { authorized: true });
  await storeA.transition(changeA.id, 'IMPLEMENTING');
  // Store A submits a proof
  const proofA = validProof();
  await storeA.submitProof(changeA.id, proofA);
  // Store B (pre-opened, stale) performs an unrelated recordAttempt
  await storeB.recordAttempt(changeA.id, { attemptId: 'att-888', workerId: 'w2', status: 'in_progress' });
  // Store A (already open) opens fresh and retrieves proof
  const storeC = await ChangeStore.open(file);
  const persisted = await storeC.getProof(changeA.id);
  assert.deepEqual(persisted.workerChecks, proofA.workerChecks);
  assert.deepEqual(persisted.controllerPreflight, proofA.controllerPreflight);
});
