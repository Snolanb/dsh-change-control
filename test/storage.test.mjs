import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChangeStore } from '../src/storage/change-store.js';

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-change-'));
  try {
    return await fn(join(dir, 'changes.json'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const input = (title = 'Rotate API key') => ({
  title,
  objective: 'Rotate the production API key safely',
  acceptanceCriteria: ['Old key is revoked after the new key works'],
  risk: 'normal',
});

const snapshot = (change) => ({
  id: change.id,
  title: change.title,
  objective: change.objective,
  acceptanceCriteria: change.acceptanceCriteria,
  risk: change.risk,
  acceptedPlanId: change.acceptedPlanId,
  state: change.state,
  createdAt: change.createdAt,
  updatedAt: change.updatedAt,
});

// AC1: Changes survive restart with identical IDs/data and latest legal state.
test('persists changes and latest legal state across restart', () => withStore(async (file) => {
  const first = await ChangeStore.open(file);
  const created = await first.create(input());
  await first.transition(created.id, 'PLANNED');
  const expected = snapshot(await first.get(created.id));

  const second = await ChangeStore.open(file);
  assert.deepEqual(snapshot(await second.get(created.id)), expected);
}));

// AC2: Each successful mutation commits exactly one corresponding audit event.
test('appends exactly one audit event for each successful mutation', () => withStore(async (file) => {
  const store = await ChangeStore.open(file);
  const created = await store.create(input());
  await store.transition(created.id, 'PLANNED');

  const events = await store.history(created.id);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map(({ changeId, from, to }) => ({ changeId, from, to })), [
    { changeId: created.id, from: null, to: 'DRAFT' },
    { changeId: created.id, from: 'DRAFT', to: 'PLANNED' },
  ]);
}));

// AC3: Rejected operations leave state unchanged and append no successful transition event.
test('rejects illegal transition without changing state or successful history', () => withStore(async (file) => {
  const store = await ChangeStore.open(file);
  const created = await store.create(input());
  const before = await store.history(created.id);
  const stateBefore = snapshot(await store.get(created.id));

  await assert.rejects(store.transition(created.id, 'APPROVED'));
  assert.deepEqual(snapshot(await store.get(created.id)), stateBefore);
  assert.deepEqual(await store.history(created.id), before);
}));

// AC4: History is deterministic and append-only through public APIs.
test('returns deterministic immutable append-only history', () => withStore(async (file) => {
  const store = await ChangeStore.open(file);
  const created = await store.create(input());
  await store.transition(created.id, 'PLANNED');

  const history = await store.history(created.id);
  const expected = structuredClone(history);
  assert.deepEqual(await store.history(created.id), expected);
  history.reverse();
  history[0].to = 'tampered';
  assert.deepEqual(await store.history(created.id), expected);
  await store.transition(created.id, 'READY');
  assert.deepEqual((await store.history(created.id)).map((event) => event.to), [
    'DRAFT', 'PLANNED', 'READY',
  ]);
}));

// AC5: Concurrent writes use serialization or version checks so successful mutations are not silently lost.
test('preserves concurrent successful mutations', () => withStore(async (file) => {
  const store = await ChangeStore.open(file);
  const [first, second] = await Promise.all([
    store.create(input('Change one')),
    store.create(input('Change two')),
  ]);

  assert.equal((await store.get(first.id)).title, 'Change one');
  assert.equal((await store.get(second.id)).title, 'Change two');
  assert.equal((await store.history(first.id)).length, 1);
  assert.equal((await store.history(second.id)).length, 1);
}));

// AC (repair): Two ChangeStore.open(file) instances coordinating writes; both records and audit events persist.
test('concurrent writes through two ChangeStore.open(file) instances persist both records and audit events', () => withStore(async (file) => {
  const [storeA, storeB] = await Promise.all([
    ChangeStore.open(file),
    ChangeStore.open(file),
  ]);

  // Both stores create a change concurrently
  const [changeA, changeB] = await Promise.all([
    storeA.create(input('From store A')),
    storeB.create(input('From store B')),
  ]);

  assert.notEqual(changeA.id, changeB.id);

  // Both transitions happen (serialized via module-level lock per file)
  await Promise.all([
    storeA.transition(changeA.id, 'PLANNED'),
    storeB.transition(changeB.id, 'PLANNED'),
  ]);

  // Reopen and assert both records and all 4 audit events persist
  const storeC = await ChangeStore.open(file);
  assert.equal((await storeC.get(changeA.id)).title, 'From store A');
  assert.equal((await storeC.get(changeA.id)).state, 'PLANNED');
  assert.equal((await storeC.get(changeB.id)).title, 'From store B');
  assert.equal((await storeC.get(changeB.id)).state, 'PLANNED');

  const historyA = await storeC.history(changeA.id);
  const historyB = await storeC.history(changeB.id);
  assert.equal(historyA.length, 2);
  assert.equal(historyB.length, 2);
  assert.deepEqual(historyA.map((e) => ({ changeId: e.changeId, from: e.from, to: e.to })), [
    { changeId: changeA.id, from: null, to: 'DRAFT' },
    { changeId: changeA.id, from: 'DRAFT', to: 'PLANNED' },
  ]);
  assert.deepEqual(historyB.map((e) => ({ changeId: e.changeId, from: e.from, to: e.to })), [
    { changeId: changeB.id, from: null, to: 'DRAFT' },
    { changeId: changeB.id, from: 'DRAFT', to: 'PLANNED' },
  ]);

  // Total audit events across both changes = 4
  const allAudit = await storeC.history(changeA.id);
  const allAuditB = await storeC.history(changeB.id);
  assert.equal(allAudit.length + allAuditB.length, 4);
}));

// AC (repair-round-3): Two opened stores concurrently transitioning the same change;
// one succeeds, one rejects, history has exactly one transition, reopen succeeds.
test('concurrent transitions on same change: one succeeds, one rejects, single audit event', () => withStore(async (file) => {
  const [storeA, storeB] = await Promise.all([
    ChangeStore.open(file),
    ChangeStore.open(file),
  ]);

  const created = await storeA.create(input('Same change'));
  // Reopen storeB to pick up the created change from disk
  await storeB.close?.();
  const storeB2 = await ChangeStore.open(file);

  // Both attempt the same transition concurrently
  const [resultA, resultB] = await Promise.allSettled([
    storeA.transition(created.id, 'PLANNED'),
    storeB2.transition(created.id, 'PLANNED'),
  ]);

  // One must succeed, the other must reject (stale state after disk refresh)
  const successIdx = resultA.status === 'fulfilled' ? 0 : 1;
  const succeededStore = successIdx === 0 ? storeA : storeB2;
  const rejected = resultA.status === 'rejected' ? resultA.reason : resultB.reason;
  assert.ok(resultA.status === 'fulfilled' || resultB.status === 'fulfilled', 'one transition must succeed');
  assert.ok(rejected instanceof Error, 'the other must reject');

  // History has exactly one transition event
  const history = await succeededStore.history(created.id);
  assert.equal(history.length, 2); // DRAFT + one PLANNED
  assert.deepEqual(history.map((e) => ({ changeId: e.changeId, from: e.from, to: e.to })), [
    { changeId: created.id, from: null, to: 'DRAFT' },
    { changeId: created.id, from: 'DRAFT', to: 'PLANNED' },
  ]);

  // Reopen succeeds and sees the correct state
  const storeC = await ChangeStore.open(file);
  assert.equal((await storeC.get(created.id)).state, 'PLANNED');
}));

// AC (repair-round-3): File paths are canonicalized (absolute/resolved).
test('canonicalizes file paths so relative and absolute paths target the same store', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-canonical-'));
  try {
    const absFile = join(dir, 'changes.json');
    const { relative } = await import('node:path');
    const relFile = relative(process.cwd(), absFile);

    const storeAbs = await ChangeStore.open(absFile);
    const storeRel = await ChangeStore.open(relFile);

    const changeAbs = await storeAbs.create(input('Via absolute path'));
    const changeRel = await storeRel.create(input('Via relative path'));

    // Both stores share the same underlying file, so they should see each other's changes
    // and transitions should be serialized through the same lock
    await storeAbs.transition(changeAbs.id, 'PLANNED');
    await storeRel.transition(changeRel.id, 'PLANNED');

    const storeCheck = await ChangeStore.open(absFile);
    const histAbs = await storeCheck.history(changeAbs.id);
    const histRel = await storeCheck.history(changeRel.id);
    // Both should have exactly 2 events (DRAFT + PLANNED)
    assert.equal(histAbs.length, 2);
    assert.equal(histRel.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// AC (repair-round-2): Multiple REVIEW->REPAIR->PREFLIGHT->REVIEW cycles;
// history length equals number of successful mutations; reopen state matches.
test('REVIEW-REPAIR-PREFLIGHT-REVIEW cycles preserve history count and state across reopen', () => withStore(async (file) => {
  const store = await ChangeStore.open(file);
  const created = await store.create(input('Cycle test'));
  // Drive to REVIEW state
  await store.transition(created.id, 'PLANNED');
  await store.transition(created.id, 'READY');
  await store.transition(created.id, 'IMPLEMENTING');
  await store.transition(created.id, 'PROOF');
  await store.transition(created.id, 'PREFLIGHT');
  await store.transition(created.id, 'REVIEW');

  const beforeReopen = snapshot(await store.get(created.id));
  assert.equal(beforeReopen.state, 'REVIEW');
  const historyBefore = await store.history(created.id);
  // DRAFT + PLANNED + READY + IMPLEMENTING + PROOF + PREFLIGHT + REVIEW = 7 events
  assert.equal(historyBefore.length, 7);

  // Two full REVIEW->REPAIR->PREFLIGHT->REVIEW cycles = 6 more transitions
  await store.transition(created.id, 'REPAIR');
  await store.transition(created.id, 'PREFLIGHT');
  await store.transition(created.id, 'REVIEW');
  await store.transition(created.id, 'REPAIR');
  await store.transition(created.id, 'PREFLIGHT');
  await store.transition(created.id, 'REVIEW');

  const historyAfter = await store.history(created.id);
  // 7 initial + 6 cycle transitions = 13 events
  assert.equal(historyAfter.length, 13);

  // Capture expected state after all transitions (before reopen)
  const expectedAfter = snapshot(await store.get(created.id));
  assert.equal(expectedAfter.state, 'REVIEW');

  // Reopen and verify state and history are preserved
  const store2 = await ChangeStore.open(file);
  const afterReopen = snapshot(await store2.get(created.id));
  assert.deepEqual(afterReopen, expectedAfter);
  const historyReopened = await store2.history(created.id);
  assert.equal(historyReopened.length, 13);
}));

// AC (repair-round-3): Simulate cross-process restart by resetting the module counter,
// writing a new event, and asserting no committed events are dropped and state is preserved.
test('cross-process restart preserves all audit events and state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-restart-'));
  try {
    const file = join(dir, 'changes.json');

    // First process: create a change and drive it through several transitions
    const store1 = await ChangeStore.open(file);
    const created = await store1.create(input('Restart test'));
    await store1.transition(created.id, 'PLANNED');
    await store1.transition(created.id, 'READY');
    await store1.transition(created.id, 'IMPLEMENTING');

    const stateBefore = snapshot(await store1.get(created.id));
    const historyBefore = await store1.history(created.id);
    assert.equal(historyBefore.length, 4); // DRAFT + 3 transitions
    assert.equal(stateBefore.state, 'IMPLEMENTING');

    // Simulate a second "process" by creating a fresh store instance
    // The module-level eventIdSeq persists in-process, but we also test
    // the disk-seeding path by opening a brand-new node process via spawn
    const { spawn } = await import('node:child_process');
    const storePath = new URL('../src/storage/change-store.js', import.meta.url).href;
    const script = `
      import { ChangeStore } from '${storePath}';
      const store = await ChangeStore.open(process.env.DATA_FILE);
      const c = await store.get('${created.id}');
      const proofTransitioned = await store.transition(c.id, 'PROOF');
      const transitioned = await store.transition(c.id, 'PREFLIGHT');
      const h = await store.history('${created.id}');
      console.log(JSON.stringify({ state: transitioned.state, historyLength: h.length }));
    `;
    const scriptFile = join(dir, 'write.js');
    await writeFile(scriptFile, script, 'utf8');

    const proc = spawn(process.execPath, [scriptFile, file], {
      env: { ...process.env, DATA_FILE: file, NODE_PATH: undefined },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdout = await new Promise((resolve) => {
      let out = '';
      proc.stdout.on('data', (d) => { out += d; });
      proc.stderr.on('data', (d) => { console.error(d.toString()); });
      proc.on('close', () => resolve(out.trim()));
    });

    assert.equal(proc.exitCode, 0, `second process failed: ${stdout}`);
    const result = JSON.parse(stdout);
    assert.equal(result.historyLength, 6); // 5 previous + 1 new (PROOF added)
    assert.equal(result.state, 'PREFLIGHT');

    // Reopen in this process and verify everything is preserved
    const store2 = await ChangeStore.open(file);
    const afterReopen = snapshot(await store2.get(created.id));
    assert.equal(afterReopen.state, 'PREFLIGHT');
    const historyAfter = await store2.history(created.id);
    assert.equal(historyAfter.length, 6);
    assert.deepEqual(historyAfter.map((e) => ({ changeId: e.changeId, from: e.from, to: e.to })), [
      { changeId: created.id, from: null, to: 'DRAFT' },
      { changeId: created.id, from: 'DRAFT', to: 'PLANNED' },
      { changeId: created.id, from: 'PLANNED', to: 'READY' },
      { changeId: created.id, from: 'READY', to: 'IMPLEMENTING' },
      { changeId: created.id, from: 'IMPLEMENTING', to: 'PROOF' },
      { changeId: created.id, from: 'PROOF', to: 'PREFLIGHT' },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// AC (BLOCKER-6): Stale store creates a new change after another process writes;
// the creation event must persist (no eventId collision loss).
test('stale store create after cross-process writes preserves creation event', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-stale-'));
  try {
    const file = join(dir, 'changes.json');

    // Store A opens and creates a change
    const storeA = await ChangeStore.open(file);
    const changeA = await storeA.create(input('Store A change'));
    await storeA.transition(changeA.id, 'PLANNED');

    // A separate process appends events (simulating another writer)
    const { spawn } = await import('node:child_process');
    const storePath = new URL('../src/storage/change-store.js', import.meta.url).href;
    const script = `
      import { ChangeStore } from '${storePath}';
      const store = await ChangeStore.open(process.env.DATA_FILE);
      const c = await store.get('${changeA.id}');
      await store.transition(c.id, 'READY');
      const c2 = await store.create({title:'Process B change',objective:'',acceptanceCriteria:[],risk:'normal'});
      await store.transition(c2.id, 'PLANNED');
      console.log(JSON.stringify({ readyDone: true, bId: c2.id }));
    `;
    const scriptFile = join(dir, 'write.js');
    await writeFile(scriptFile, script, 'utf8');

    const proc = spawn(process.execPath, [scriptFile], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DATA_FILE: file },
    });
    const stdout = await new Promise((resolve) => {
      let out = '';
      proc.stdout.on('data', (d) => { out += d; });
      proc.on('close', () => resolve(out.trim()));
    });
    assert.equal(proc.exitCode, 0, `second process failed: ${stdout}`);
    const spawnResult = JSON.parse(stdout);
    assert.equal(spawnResult.readyDone, true);
    assert.ok(spawnResult.bId);

    // Store A (now stale) creates another change
    const changeB = await storeA.create(input('Store A stale create'));
    await storeA.transition(changeB.id, 'PLANNED');

    // Reopen fresh and verify:
    // - changeA has 3 events (DRAFT, PLANNED, READY)
    // - changeB has 2 events (DRAFT, PLANNED)
    // - Process B's change has 2 events (DRAFT, PLANNED)
    const storeFresh = await ChangeStore.open(file);
    const histA = await storeFresh.history(changeA.id);
    const histB = await storeFresh.history(changeB.id);
    const histSpawnB = await storeFresh.history(spawnResult.bId);

    assert.equal(histA.length, 3, 'changeA should have 3 events');
    assert.equal(histB.length, 2, 'changeB (from stale store) should have 2 events');
    assert.equal(histSpawnB.length, 2, "spawn B's change should have 2 events");
    assert.equal((await storeFresh.get(changeA.id)).state, 'READY');
    assert.equal((await storeFresh.get(changeB.id)).state, 'PLANNED');
    assert.equal((await storeFresh.get(spawnResult.bId)).state, 'PLANNED');

    // Total audit events = 3 + 2 + 2 = 7
    const allAudit = await storeFresh.history(changeA.id);
    const allB = await storeFresh.history(changeB.id);
    const allSpawn = await storeFresh.history(spawnResult.bId);
    assert.equal(allAudit.length + allB.length + allSpawn.length, 7);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
