import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChangeStore } from '../src/storage/change-store.js';

const input = {
  title: 'Bind implementation role',
  objective: 'Exercise session-scoped role ownership',
  acceptanceCriteria: ['The implementation attempt is recorded'],
  risk: 'normal',
};

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-role-bindings-'));
  try {
    return await fn(join(dir, 'changes.json'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// AC1: a role binding is durable and resolves by session identity, not model identity.
test('persists and resolves a Change role binding by session identity', () => withStore(async (file) => {
  const store = await ChangeStore.open(file);
  const change = await store.create(input);

  const binding = await store.bindRole(change.id, 'session-a', 'implementer');
  assert.deepEqual(binding, { changeId: change.id, sessionId: 'session-a', role: 'implementer' });
  assert.equal(await store.resolveRole(change.id, 'session-a'), 'implementer');

  const reopened = await ChangeStore.open(file);
  assert.equal(await reopened.resolveRole(change.id, 'session-a'), 'implementer');
}));

// AC2: provider/model routing metadata is not part of a persisted binding.
test('role bindings contain no model or provider identity', () => withStore(async (file) => {
  const store = await ChangeStore.open(file);
  const change = await store.create(input);
  const binding = await store.bindRole(change.id, 'session-r', 'reviewer');

  assert.deepEqual(Object.keys(binding).sort(), ['changeId', 'role', 'sessionId']);
  const raw = JSON.parse(await readFile(file, 'utf8'));
  const stored = raw.bindings?.find((entry) => entry.changeId === change.id);
  assert.deepEqual(Object.keys(stored).sort(), ['changeId', 'role', 'sessionId']);
  assert.equal(stored.model, undefined);
  assert.equal(stored.provider, undefined);
}));

// AC3: binding a missing Change rejects before writing any binding record.
test('rejects a binding for a nonexistent Change without partial persistence', () => withStore(async (file) => {
  const store = await ChangeStore.open(file);
  await assert.rejects(
    store.bindRole('missing-change', 'session-a', 'implementer'),
    /not found/i,
  );

  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(raw.bindings ?? [], []);
}));

// AC4: duplicate ownership is rejected; explicit rebinding is required to replace it.
test('does not silently overwrite an existing binding and supports explicit rebinding', () => withStore(async (file) => {
  const store = await ChangeStore.open(file);
  const change = await store.create(input);
  const original = await store.bindRole(change.id, 'session-a', 'implementer');

  await assert.rejects(
    store.bindRole(change.id, 'session-a', 'reviewer'),
    /already bound|exists|overwrite/i,
  );
  assert.equal(await store.resolveRole(change.id, 'session-a'), original.role);

  const rebound = await store.bindRole(change.id, 'session-a', 'reviewer', { rebind: true });
  assert.equal(rebound.role, 'reviewer');
  assert.equal(await store.resolveRole(change.id, 'session-a'), 'reviewer');
}));

// AC5: implementation attempts are durable records independent of session bindings.
test('records worker implementation attempts independently of session identity', () => withStore(async (file) => {
  const store = await ChangeStore.open(file);
  const change = await store.create(input);
  const attempt = await store.recordAttempt(change.id, {
    attemptId: 'attempt-1',
    workerId: 'worker-1',
    status: 'running',
  });

  assert.equal(attempt.changeId, change.id);
  assert.equal(attempt.attemptId, 'attempt-1');
  assert.equal(attempt.workerId, 'worker-1');
  assert.equal(attempt.sessionId, undefined);
  assert.deepEqual(await store.listAttempts(change.id), [attempt]);

  const reopened = await ChangeStore.open(file);
  assert.deepEqual(await reopened.listAttempts(change.id), [attempt]);
}));

// Regression: store A binds and attempts, store B does unrelated work, fresh store sees all.
test('bindings and attempts merge correctly across concurrent stores', () => withStore(async (file) => {
  const [storeA, storeB] = await Promise.all([
    ChangeStore.open(file),
    ChangeStore.open(file),
  ]);

  const changeA = await storeA.create(input);
  const changeB = await storeB.create({ title: 'Other', objective: '', acceptanceCriteria: [], risk: 'normal' });

  // Store A binds and records attempt
  await storeA.bindRole(changeA.id, 'session-a', 'implementer');
  await storeA.recordAttempt(changeA.id, { attemptId: 'attempt-a', workerId: 'worker-a', status: 'done' });

  // Store B binds its own change (triggers persist that should merge storeA's data)
  await storeB.bindRole(changeB.id, 'session-b', 'reviewer');
  await storeB.recordAttempt(changeB.id, { attemptId: 'attempt-b', workerId: 'worker-b', status: 'running' });

  // Fresh store should see all bindings and attempts
  const storeC = await ChangeStore.open(file);
  const bindings = await storeC.listRoleBindings();
  const attempts = await storeC.listAttempts(changeA.id);
  const attemptsB = await storeC.listAttempts(changeB.id);
  assert.equal(bindings.length, 2);
  assert.ok(bindings.some((b) => b.sessionId === 'session-a' && b.role === 'implementer'));
  assert.ok(bindings.some((b) => b.sessionId === 'session-b' && b.role === 'reviewer'));
  assert.equal(attempts.length, 1);
  assert.equal(attemptsB.length, 1);
}));

// Regression: two stores opened before the write, both should see the binding/attempts.
test('two stores opened before write both see bindings and attempts after commit', () => withStore(async (file) => {
  const [storeA, storeB] = await Promise.all([
    ChangeStore.open(file),
    ChangeStore.open(file),
  ]);

  const change = await storeA.create(input);

  // Both stores bind a role
  await storeA.bindRole(change.id, 'session-a', 'implementer');
  await storeB.bindRole(change.id, 'session-b', 'reviewer');

  // Both stores record attempts
  await storeA.recordAttempt(change.id, {
    attemptId: 'attempt-a',
    workerId: 'worker-a',
    status: 'running',
  });
  await storeB.recordAttempt(change.id, {
    attemptId: 'attempt-b',
    workerId: 'worker-b',
    status: 'done',
  });

  // Fresh store should see both bindings and attempts
  const storeC = await ChangeStore.open(file);
  const bindings = await storeC.listRoleBindings();
  const attempts = await storeC.listAttempts(change.id);
  assert.equal(bindings.length, 2);
  assert.ok(bindings.some((b) => b.sessionId === 'session-a' && b.role === 'implementer'));
  assert.ok(bindings.some((b) => b.sessionId === 'session-b' && b.role === 'reviewer'));
  assert.equal(attempts.length, 2);
  assert.ok(attempts.some((a) => a.attemptId === 'attempt-a'));
  assert.ok(attempts.some((a) => a.attemptId === 'attempt-b'));
}));

// Regression: long-lived reader sees rebind from another store.
test('long-lived reader sees external rebind via resolveRole', () => withStore(async (file) => {
  const [storeA, storeB] = await Promise.all([
    ChangeStore.open(file),
    ChangeStore.open(file),
  ]);

  const change = await storeA.create(input);

  // Store A binds session-a to implementer
  await storeA.bindRole(change.id, 'session-a', 'implementer');

  // Store B does an unrelated create (triggers persist that merges storeA's data)
  await storeB.create({ title: 'Other', objective: '', acceptanceCriteria: [], risk: 'normal' });

  // Store A explicitly rebinds session-a to reviewer
  await storeA.bindRole(change.id, 'session-a', 'reviewer', { rebind: true });

  // Store B should now see the rebind when it calls resolveRole
  assert.equal(await storeB.resolveRole(change.id, 'session-a'), 'reviewer');

  // Store B's listRoleBindings should also show the new role
  const bindingsB = await storeB.listRoleBindings();
  assert.equal(bindingsB.length, 1);
  assert.equal(bindingsB[0].sessionId, 'session-a');
  assert.equal(bindingsB[0].role, 'reviewer');

  // Store A should still have the correct role
  assert.equal(await storeA.resolveRole(change.id, 'session-a'), 'reviewer');
}));

// Regression: store A binds a role and records an attempt, store B does unrelated create,
// then a freshly opened store resolves the role and lists the attempt.
test('binds and attempts persist across unrelated concurrent operations', () => withStore(async (file) => {
  const [storeA, storeB] = await Promise.all([
    ChangeStore.open(file),
    ChangeStore.open(file),
  ]);

  const changeA = await storeA.create(input);
  const changeB = await storeB.create({ title: 'Other change', objective: '', acceptanceCriteria: [], risk: 'normal' });

  // Store A binds a role on its change
  await storeA.bindRole(changeA.id, 'session-a', 'implementer');

  // Store A records an attempt
  await storeA.recordAttempt(changeA.id, {
    attemptId: 'attempt-1',
    workerId: 'worker-1',
    status: 'running',
  });

  // Store B does an unrelated create (this triggers a persist that should include storeA's data)
  await storeB.bindRole(changeB.id, 'session-b', 'reviewer');

  // Fresh store should see both bindings and attempts
  const storeC = await ChangeStore.open(file);
  assert.equal(await storeC.resolveRole(changeA.id, 'session-a'), 'implementer');
  const attempts = await storeC.listAttempts(changeA.id);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].attemptId, 'attempt-1');
  const bindings = await storeC.listRoleBindings();
  assert.equal(bindings.length, 2);
}));

// Regression: rebind persists and resolves correctly after reopen.
test('rebind role persists and resolves after store reopen', () => withStore(async (file) => {
  const store = await ChangeStore.open(file);
  const change = await store.create(input);

  // Bind session-a to implementer
  await store.bindRole(change.id, 'session-a', 'implementer');
  assert.equal(await store.resolveRole(change.id, 'session-a'), 'implementer');

  // Rebind session-a to reviewer
  await store.bindRole(change.id, 'session-a', 'reviewer', { rebind: true });

  // Reopen and verify new role resolves
  const reopened = await ChangeStore.open(file);
  assert.equal(await reopened.resolveRole(change.id, 'session-a'), 'reviewer');
  const bindings = await reopened.listRoleBindings();
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].role, 'reviewer');
}));

// Regression for F4: B reads binding, A rebinds, B does unrelated create, fresh store sees A's new role.
test('unrelated create by stale reader preserves external rebind in fresh store', () => withStore(async (file) => {
  const [storeA, storeB] = await Promise.all([
    ChangeStore.open(file),
    ChangeStore.open(file),
  ]);

  const change = await storeA.create(input);

  // Store A binds session-a to implementer
  await storeA.bindRole(change.id, 'session-a', 'implementer');

  // Store B reads the binding
  assert.equal(await storeB.resolveRole(change.id, 'session-a'), 'implementer');

  // Store A rebinds session-a to reviewer
  await storeA.bindRole(change.id, 'session-a', 'reviewer', { rebind: true });

  // Store B performs an unrelated create (should not erase A's rebind)
  const otherChange = await storeB.create({ title: 'Other', objective: '', acceptanceCriteria: [], risk: 'normal' });
  await storeB.bindRole(otherChange.id, 'session-b', 'reviewer');

  // Fresh store should see A's new role, not B's stale cached value
  const storeC = await ChangeStore.open(file);
  assert.equal(await storeC.resolveRole(change.id, 'session-a'), 'reviewer');
  const bindings = await storeC.listRoleBindings();
  assert.ok(bindings.some((b) => b.changeId === change.id && b.sessionId === 'session-a' && b.role === 'reviewer'));
}));
