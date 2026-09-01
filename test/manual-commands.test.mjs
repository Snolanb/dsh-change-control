import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { ChangeStore } from '../src/storage/change-store.js';
import { apply, name } from '../src/index.js';

const commandNames = [
  'change-new', 'change-status', 'change-plan', 'change-approve-plan',
  'change-bind', 'change-unbind', 'change-history', 'change-preflight',
];

class CommandRegistrationSeam {
  definitions = new Map();
  register(definition) {
    assert.equal(typeof definition?.handler, 'function');
    assert.match(definition.name, /^change-/);
    this.definitions.set(definition.name, definition);
    return () => this.definitions.delete(definition.name);
  }
}

async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'manual-change-'));
  try {
    const registry = new CommandRegistrationSeam();
    const ctx = new Context();
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime);
    ctx.provide('commands', registry);
    await ctx.plugin({ name, apply, inject: ['tools'] }, {
      storePath: join(dir, 'changes.json'),
      preflightPolicy: { requiredChecks: ['tests'], protectedPaths: [] },
    });
    const store = ctx.get('changeStore');
    await fn({ registry, store });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const human = { id: 'human-operator', kind: 'human' };
const invoke = (registry, name, args = {}) => registry.definitions.get(name)?.handler({
  commandId: `${name}-test`, agent: human, rawInput: JSON.stringify(args), attachments: [], signal: new AbortController().signal,
});
const resultObject = (result) => JSON.parse(result.text);

// Registration is the host seam: handlers run directly, with no model/session turn.
test('registers all eight manual Change commands at the host boundary', async () => fixture(async ({ registry }) => {
  assert.deepEqual([...registry.definitions.keys()].sort(), [...commandNames].sort());
}));

test('change-new creates a human-owned Change and change-status projects canonical state', async () => fixture(async ({ registry }) => {
  const created = await invoke(registry, 'change-new', {
    title: 'Manual release', objective: 'Ship safely', acceptanceCriteria: ['tests'], risk: 'normal',
  });
  assert.equal(created.kind, 'success');
  const change = resultObject(created);
  assert.match(change.id, /^[0-9a-f-]{36}$/i);

  const status = resultObject(await invoke(registry, 'change-status', { changeId: change.id }));
  for (const field of ['id', 'state', 'risk', 'acceptedPlan', 'bindings', 'revision', 'proof', 'preflight', 'openFindings']) {
    assert.ok(Object.hasOwn(status, field), `status must include ${field}`);
  }
}));

test('change-plan and change-approve-plan use canonical plan acceptance semantics', async () => fixture(async ({ registry, store }) => {
  const change = resultObject(await invoke(registry, 'change-new', { title: 'Plan', objective: 'Test', risk: 'low' }));
  const planned = resultObject(await invoke(registry, 'change-plan', { changeId: change.id, content: { steps: ['verify'] } }));
  assert.ok(planned.planId);
  const approved = resultObject(await invoke(registry, 'change-approve-plan', { changeId: change.id, planId: planned.planId }));
  assert.equal(approved.status, 'ACCEPTED');
  assert.equal((await store.get(change.id)).acceptedPlanId, planned.planId);
}));

test('change-bind and change-unbind mutate canonical bindings without impersonation', async () => fixture(async ({ registry, store }) => {
  const change = resultObject(await invoke(registry, 'change-new', { title: 'Bindings', objective: 'Test' }));
  const bound = resultObject(await invoke(registry, 'change-bind', { changeId: change.id, sessionId: 'worker-1', role: 'worker' }));
  assert.equal(bound.sessionId, 'worker-1');
  assert.equal(bound.role, 'worker');
  const unbound = resultObject(await invoke(registry, 'change-unbind', { changeId: change.id, sessionId: 'worker-1' }));
  assert.equal(unbound.removed, true);
  assert.deepEqual((await store.listRoleBindings()).filter((binding) => binding.changeId === change.id), []);
}));

test('change-history is chronological and change-preflight supports retry through canonical runner', async () => fixture(async ({ registry, store }) => {
  const change = resultObject(await invoke(registry, 'change-new', { title: 'Preflight', objective: 'Test', acceptanceCriteria: ['tests'], risk: 'normal' }));
  const planned = resultObject(await invoke(registry, 'change-plan', { changeId: change.id, content: { steps: ['verify'] } }));
  await invoke(registry, 'change-approve-plan', { changeId: change.id, planId: planned.planId });
  await store.transition(change.id, 'IMPLEMENTING');
  await store.recordAttempt(change.id, { attemptId: 'attempt-1', workerId: 'human-operator', revision: 'rev-1', status: 'completed' });
  await store.submitProof(change.id, { beforeRevision: 'rev-0', afterRevision: 'rev-1', criteria: [{ id: 'tests', satisfied: true }], deviations: [], workerChecks: [], controllerPreflight: [] });

  const history = resultObject(await invoke(registry, 'change-history', { changeId: change.id }));
  assert.ok(Array.isArray(history));
  assert.ok(history.every((event, i) => i === 0 || event.eventId > history[i - 1].eventId));

  const first = await invoke(registry, 'change-preflight', { changeId: change.id, currentRevision: 'rev-1', changedFiles: [], checkResults: [{ name: 'tests', passed: false, exitCode: 1 }] });
  assert.equal(first.kind, 'error');
  const retry = await invoke(registry, 'change-preflight', { changeId: change.id, currentRevision: 'rev-1', changedFiles: [], checkResults: [{ name: 'tests', passed: true, exitCode: 0 }] });
  assert.equal(retry.kind, 'success');
}));
