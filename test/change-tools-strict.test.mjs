import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChangeStore } from '../src/storage/change-store.js';
import { ChangeService } from '../src/change-control.js';
import { registerChangeTools } from '../src/tools/change-tools.js';

test('canonical store preserves exact operation payloads, audit order, and reopen state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-change-strict-'));
  const file = join(dir, 'changes.json');
  try {
    const store = await ChangeStore.open(file);
    const change = await store.create({ title: 'strict', objective: 'exercise tools', acceptanceCriteria: ['works'] });
    const planContent = { steps: ['one', 'two'], rollback: { command: 'undo' } };
    const proofContent = { tests: [{ command: 'npm test', result: 'pass' }] };
    const reviewContent = { verdict: 'changes_requested', findings: [{ id: 'F1', fix: 'retry' }] };
    const repairContent = { fixes: [{ id: 'F1', commit: 'abc123' }] };

    const plan = await store.submitPlan(change.id, planContent);
    assert.deepEqual(plan.content, planContent);
    await store.acceptPlan(change.id, plan.id, { authorized: true });
    await store.transition(change.id, 'IMPLEMENTING');
    await store.transition(change.id, 'PROOF');
    await store.submitProof(change.id, proofContent);
    await store.transition(change.id, 'PREFLIGHT');
    await store.transition(change.id, 'REVIEW');
    await store.submitReview(change.id, reviewContent);
    await store.transition(change.id, 'REPAIR');
    await store.submitRepair(change.id, repairContent);

    const history = await store.history(change.id);
    assert.deepEqual(history.map((event) => event.to), [
      'DRAFT', 'PLANNED', 'READY', 'IMPLEMENTING', 'PROOF', 'PROOF', 'PREFLIGHT',
      'REVIEW', 'REVIEW', 'REPAIR', 'REPAIR'
    ]);
    assert.deepEqual(history.filter((event) => event.proof).at(-1).proof, proofContent);
    assert.deepEqual(history.filter((event) => event.review).at(-1).review, reviewContent);
    assert.deepEqual(history.filter((event) => event.repair).at(-1).repair, repairContent);

    const reopened = await ChangeStore.open(file);
    assert.equal((await reopened.get(change.id)).state, 'REPAIR');
    const reopenedHistory = await reopened.history(change.id);
    assert.deepEqual(reopenedHistory, history);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('registered tools execute a bound legal workflow and persist exact payloads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-change-e2e-'));
  const file = join(dir, 'changes.json');
  try {
    const store = await ChangeStore.open(file);
    const change = await store.create({ title: 'e2e', objective: 'registered tools' });
    const run = async (name, role, state, content) => {
      const session = `${role}-agent`;
      try { await store.bindRole(change.id, session, role); } catch (error) { if (error.code !== 'ALREADY_BOUND') throw error; }
      const service = new ChangeService({ role, state, store });
      const registered = [];
      registerChangeTools({ tools: { register: (tool) => registered.push(tool) }, changeService: service, changeStore: store });
      return registered.find((tool) => tool.name === name).execute({ changeId: change.id, content }, { agent: { id: session } });
    };
    const getSession = 'planner-agent';
    await store.bindRole(change.id, getSession, 'planner');
    const getRegistered = [];
    registerChangeTools({ tools: { register: (tool) => getRegistered.push(tool) }, changeService: new ChangeService({ role: 'planner', state: 'PLANNING', store }), changeStore: store });
    const returned = await getRegistered.find((tool) => tool.name === 'change_get').execute({ changeId: change.id }, { agent: { id: getSession } });
    assert.deepEqual(returned, await store.get(change.id));

    const planContent = { steps: ['registered-plan'] };
    const proofContent = { tests: [{ command: 'npm test', result: 'pass' }] };
    const reviewContent = { verdict: 'changes_requested', findings: [{ id: 'F1' }] };
    const repairContent = { fixes: [{ id: 'F1', commit: 'abc' }] };
    const plan = await run('change_submit_plan', 'planner', 'PLANNING', planContent);
    await store.acceptPlan(change.id, plan.id, { authorized: true });
    await store.transition(change.id, 'IMPLEMENTING');
    await store.transition(change.id, 'PROOF');
    await run('change_submit_proof', 'worker', 'PROOF', proofContent);
    await store.transition(change.id, 'PREFLIGHT');
    await store.transition(change.id, 'REVIEW');
    await run('change_submit_review', 'reviewer', 'REVIEW', reviewContent);
    await store.transition(change.id, 'REPAIR');
    await run('change_submit_repair', 'worker', 'REPAIR', repairContent);
    const history = await store.history(change.id);
    assert.deepEqual(history.map(({ from, to, planId, proof, review, repair }) => Object.fromEntries(Object.entries({ from, to, planId, proof, review, repair }).filter(([, value]) => value !== undefined))), [
      { from: null, to: 'DRAFT' },
      { from: 'DRAFT', to: 'PLANNED', planId: plan.id },
      { from: 'PLANNED', to: 'READY', planId: plan.id },
      { from: 'READY', to: 'IMPLEMENTING' },
      { from: 'IMPLEMENTING', to: 'PROOF' },
      { from: 'PROOF', to: 'PROOF', proof: proofContent },
      { from: 'PROOF', to: 'PREFLIGHT' },
      { from: 'PREFLIGHT', to: 'REVIEW' },
      { from: 'REVIEW', to: 'REVIEW', review: reviewContent },
      { from: 'REVIEW', to: 'REPAIR' },
      { from: 'REPAIR', to: 'REPAIR', repair: repairContent },
    ]);
    assert.deepEqual(history.filter((e) => e.planId).at(0).planId, plan.id);
    assert.deepEqual(history.filter((e) => e.proof).at(-1).proof, proofContent);
    assert.deepEqual(history.filter((e) => e.review).at(-1).review, reviewContent);
    assert.deepEqual(history.filter((e) => e.repair).at(-1).repair, repairContent);
    const reopened = await ChangeStore.open(file);
    assert.equal((await reopened.get(change.id)).state, 'REPAIR');
    assert.deepEqual(await reopened.history(change.id), history);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('registered tools reject wrong identity before writing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-change-e2e-deny-'));
  try {
    const store = await ChangeStore.open(join(dir, 'changes.json'));
    const change = await store.create({ title: 'deny' });
    await store.bindRole(change.id, 'planner-agent', 'planner');
    const service = new ChangeService({ role: 'planner', state: 'PLANNING', store });
    const registered = [];
    registerChangeTools({ tools: { register: (tool) => registered.push(tool) }, changeService: service, changeStore: store });
    const tool = registered.find((candidate) => candidate.name === 'change_submit_plan');
    const before = await store.history(change.id);
    await assert.rejects(tool.execute({ changeId: change.id, content: { denied: true } }, { agent: { id: 'other-agent' } }));
    const getTool = registered.find((candidate) => candidate.name === 'change_get');
    await assert.rejects(getTool.execute({ changeId: change.id }, { agent: { id: 'other-agent' } }));
    const mismatched = [];
    registerChangeTools({ tools: { register: (candidate) => mismatched.push(candidate) }, changeService: new ChangeService({ role: 'worker', state: 'PLANNING', store }), changeStore: store });
    await assert.rejects(mismatched.find((candidate) => candidate.name === 'change_get').execute({ changeId: change.id }, { agent: { id: 'planner-agent' } }));
    assert.deepEqual(await store.history(change.id), before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('mandatory mutation tools perform no writes for canonical identity/role/state denials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-change-denial-'));
  try {
    const store = await ChangeStore.open(join(dir, 'changes.json'));
    const change = await store.create({ title: 'denial-matrix' });
    await store.bindRole(change.id, 'agent-1', 'planner');
    const cases = [
      ['change_submit_plan', 'submitPlan', 'worker', 'PLANNING', 'planner', 'REVIEW'],
      ['change_submit_proof', 'submitProof', 'planner', 'PROOF', 'worker', 'REVIEW'],
      ['change_submit_review', 'submitReview', 'planner', 'REVIEW', 'reviewer', 'PLANNING'],
      ['change_submit_repair', 'submitRepair', 'reviewer', 'REPAIR', 'worker', 'PLANNING'],
    ];
    for (const [toolName, method, wrongRole, state, role, wrongState] of cases) {
      for (const service of [new ChangeService({ role: wrongRole, state }), new ChangeService({ role, state: wrongState }), new ChangeService({ role, state, sessionBound: false })]) {
        let writes = 0;
        const guardedStore = new Proxy(store, { get(target, key) { if (key === method) return async (...args) => { writes++; return target[key](...args); }; return target[key]; } });
        const registered = [];
        registerChangeTools({ tools: { register: (tool) => registered.push(tool) }, changeService: service, changeStore: guardedStore });
        await assert.rejects(registered.find((tool) => tool.name === toolName).execute({ changeId: change.id, content: { exact: true } }, { agent: { id: 'agent-1' } }));
        assert.equal(writes, 0, `${toolName} wrote despite canonical denial`);
      }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('runtime validation rejects malformed IDs before any store write', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-change-validation-'));
  try {
    const store = await ChangeStore.open(join(dir, 'changes.json'));
    const service = new ChangeService({ role: 'planner', state: 'PLANNING' });
    const registered = [];
    registerChangeTools({ tools: { register: (tool) => registered.push(tool) }, changeService: service, changeStore: store });
    for (const tool of registered) await assert.rejects(tool.execute({ changeId: 42, content: { exact: true } }, { agent: { id: 'agent-1' } }), (error) => error.code === 'INVALID_ARGS');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('each registered operation rejects wrong identity and role on existing records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-change-bound-'));
  try {
    const store = await ChangeStore.open(join(dir, 'changes.json'));
    const cases = [
      ['change_get', 'planner', 'PLANNING', {}], ['change_submit_plan', 'planner', 'PLANNING', { steps: ['x'] }],
      ['change_submit_proof', 'worker', 'PROOF', { tests: ['x'] }], ['change_submit_review', 'reviewer', 'REVIEW', { verdict: 'approve' }],
      ['change_submit_repair', 'worker', 'REPAIR', { fixes: ['x'] }],
    ];
    for (const [name, role, state, content] of cases) {
      const change = await store.create({ title: name }); const session = `${name}-bound`;
      await store.bindRole(change.id, session, role);
      const service = new ChangeService({ role, state, store }); const registered = [];
      registerChangeTools({ tools: { register: (tool) => registered.push(tool) }, changeService: service, changeStore: store });
      const tool = registered.find((candidate) => candidate.name === name); const beforeRecord = await store.get(change.id); const beforeAudit = await store.history(change.id);
      await assert.rejects(tool.execute({ changeId: change.id, content }, { agent: { id: 'wrong-agent' } }));
      const mismatched = new ChangeService({ role: role === 'planner' ? 'worker' : 'planner', state, store });
      const mismatchedTools = [];
      registerChangeTools({ tools: { register: (candidate) => mismatchedTools.push(candidate) }, changeService: mismatched, changeStore: store });
      await assert.rejects(mismatchedTools.find((candidate) => candidate.name === name).execute({ changeId: change.id, content }, { agent: { id: session } }), (error) => error.reason === 'SESSION_NOT_BOUND' || error.reason === 'ROLE_NOT_ALLOWED' || error.code);
      assert.deepEqual(await store.get(change.id), beforeRecord); assert.deepEqual(await store.history(change.id), beforeAudit);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
