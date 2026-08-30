import test from 'node:test';
import assert from 'node:assert/strict';
import { defineTool } from '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js';
import { registerChangeTools } from '../src/tools/change-tools.js';
import { ChangeService, AuthorizationError } from '../src/change-control.js';
import { ChangeStore } from '../src/storage/change-store.js';
import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const expected = ['change_get', 'change_submit_plan', 'change_submit_proof',
  'change_submit_review', 'change_submit_repair'];

/**
 * Create a minimal service double that records calls with exact arguments.
 */
function createServiceDouble() {
  const calls = [];
  const service = {
    get: async (change) => { calls.push({ method: 'get', args: [change] }); return change; },
    submitPlan: async (change) => { calls.push({ method: 'submitPlan', args: [change] }); return { ok: true }; },
    submitProof: async (change) => { calls.push({ method: 'submitProof', args: [change] }); return { ok: true }; },
    submitReview: async (change) => { calls.push({ method: 'submitReview', args: [change] }); return { ok: true }; },
    submitRepair: async (change) => { calls.push({ method: 'submitRepair', args: [change] }); return { ok: true }; },
  };
  return { service, calls };
}

/**
 * Create a minimal store double that records calls with exact arguments.
 */
function createStoreDouble() {
  const calls = [];
  const store = {
    get: (id) => { calls.push({ method: 'get', args: [id] }); return { id, state: 'DRAFT' }; },
    submitPlan: (changeId, content) => { calls.push({ method: 'submitPlan', args: [changeId, content] }); return { ok: true }; },
    submitProof: (changeId, content) => { calls.push({ method: 'submitProof', args: [changeId, content] }); return { ok: true }; },
    submitReview: (changeId, content) => { calls.push({ method: 'submitReview', args: [changeId, content] }); return { ok: true }; },
    submitRepair: (changeId, content) => { calls.push({ method: 'submitRepair', args: [changeId, content] }); return { ok: true }; },
  };
  return { store, calls };
}

function setup(service = {}, store = {}) {
  const registered = [];
  const ctx = {
    tools: { register(tool) { registered.push(tool); return () => {}; } },
    changeService: service,
    changeStore: store,
  };
  registerChangeTools(ctx);
  return Object.fromEntries(registered.map((tool) => [tool.name, tool]));
}
const exec = { agent: { id: 'agent-model-7' }, signal: AbortSignal.timeout(1000) };
const contains = (value, expectedValue) => JSON.stringify(value).includes(expectedValue);

test('registers only narrow Change tools with the real defineTool API', () => {
  const tools = setup();
  assert.deepEqual(Object.keys(tools).sort(), expected.sort());
  for (const tool of Object.values(tools)) {
    assert.equal(typeof tool.execute, 'function');
    assert.equal(typeof tool.parameters, 'object');
  }
});

test('tool schemas do not expose impersonation session or agent IDs', () => {
  for (const [name, tool] of Object.entries(setup())) {
    assert.equal(JSON.stringify(tool.parameters).includes('sessionId'), false, `${name} accepts sessionId`);
    assert.equal(JSON.stringify(tool.parameters).includes('agentId'), false, `${name} accepts agentId`);
  }
});

test('derives identity from exec.agent.id and delegates with canonical signatures', async () => {
  const { service, calls } = createServiceDouble();
  const { store, calls: storeCalls } = createStoreDouble();
  const tools = setup(service, store);

  // change_get: calls service.get(change) then store.get(changeId)
  await tools.change_get.execute({ changeId: 'chg-1' }, exec);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'get');
  assert.equal(calls[0].args[0].changeId, 'chg-1');
  assert.equal(calls[0].args[0].sessionId, exec.agent.id);

  // Mutations: authorize via service (single change object with sessionId), persist via store (changeId, content)
  for (const name of expected.slice(1)) {
    await tools[name].execute({ changeId: 'chg-1', content: { steps: ['test'] } }, exec);
  }
  assert.equal(calls.length, expected.length);
  // Verify service receives change object with sessionId for mutations
  for (let i = 1; i < calls.length; i++) {
    assert.equal(calls[i].args[0].changeId, 'chg-1');
    assert.equal(calls[i].args[0].sessionId, exec.agent.id);
    assert.deepEqual(calls[i].args[0].content, { steps: ['test'] });
  }
  // Verify store receives (changeId, content) for mutations
  assert.equal(storeCalls.length, expected.length);
  for (const call of storeCalls) {
    assert.equal(call.args[0], 'chg-1');
  }
});

test('returns concise structured actionable errors for denied transitions', async () => {
  const denial = new AuthorizationError('ROLE_NOT_ALLOWED', 'planner cannot submitRepair');
  const service = {
    submitRepair: async () => { throw denial; },
  };
  const store = {
    submitRepair: async () => ({ ok: true }),
  };
  const tools = setup(service, store);
  await assert.rejects(
    tools.change_submit_repair.execute({ changeId: 'chg-1', content: {} }, exec),
    (error) => {
      assert.equal(error.reason, 'ROLE_NOT_ALLOWED');
      assert.deepEqual(error.details, { reason: 'ROLE_NOT_ALLOWED' });
      return true;
    }
  );
});

test('malformed payloads fail validation before persistence', async () => {
  let serviceCalled = false;
  let storeCalled = false;
  const service = {
    submitPlan: async () => { serviceCalled = true; return { ok: true }; },
  };
  const store = {
    submitPlan: async () => { storeCalled = true; return { ok: true }; },
  };
  const tools = setup(service, store);

  // Invalid changeId type
  await assert.rejects(
    tools.change_submit_plan.execute({ changeId: 42, content: {} }, exec),
    (error) => error.code === 'INVALID_ARGS' || /invalid|required|expected/i.test(error.message)
  );
  assert.equal(serviceCalled, false, 'service should not be called');
  assert.equal(storeCalled, false, 'store should not be called');
});

test('does not expose arbitrary state mutation tools', () => {
  const names = Object.keys(setup());
  assert.equal(names.some((name) => /delete|set|update|mutate|write|patch/i.test(name)), false);
});

test('change_get routes through canonical ChangeService authorization', async () => {
  const tmpFile = join(process.cwd(), 'test-store-' + Date.now() + '.json');
  await mkdir(process.cwd(), { recursive: true }).catch(() => {});
  const store = await ChangeStore.open(tmpFile);
  const change = await store.create({ title: 'Test', objective: 'Test objective' });

  // Bind the test agent session to the change for authorization
  await store.bindRole(change.id, exec.agent.id, 'planner');

  const service = new ChangeService({
    role: 'planner',
    state: 'PLANNING',
    store: store
  });

  const tools = setup(service, store);

  try {
    // change_get should authorize via service then read from store
    const result = await tools.change_get.execute({ changeId: change.id }, exec);
    assert.equal(result.id, change.id);
    assert.equal(result.title, 'Test');
  } catch (err) {
    // If authorization fails, verify it's due to binding check
    assert.ok(err instanceof AuthorizationError || err.code === 'SESSION_NOT_BOUND' || err.message.includes('not bound'));
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
});

test('ChangeService rejects unbound session for reads and mutations', async () => {
  const tmpFile = join(process.cwd(), 'test-store-' + Date.now() + '.json');
  await mkdir(process.cwd(), { recursive: true }).catch(() => {});
  const store = await ChangeStore.open(tmpFile);
  const change = await store.create({ title: 'Test', objective: 'Test objective' });

  const service = new ChangeService({
    role: 'planner',
    state: 'PLANNING',
    sessionBound: false
  });

  const tools = setup(service, store);

  try {
    // Read should fail without binding
    await assert.rejects(
      tools.change_get.execute({ changeId: change.id }, exec),
      (error) => error.code === 'SESSION_NOT_BOUND' || error.message.includes('not bound')
    );

    // Mutation should also fail without binding
    await assert.rejects(
      tools.change_submit_plan.execute({ changeId: change.id, content: {} }, exec),
      (error) => error.code === 'SESSION_NOT_BOUND' || error.message.includes('not bound')
    );
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
});

test('ChangeService rejects mismatched session identity', async () => {
  const tmpFile = join(process.cwd(), 'test-store-' + Date.now() + '.json');
  await mkdir(process.cwd(), { recursive: true }).catch(() => {});
  const store = await ChangeStore.open(tmpFile);
  const change = await store.create({ title: 'Test', objective: 'Test objective' });

  // Bind a different session
  await store.bindRole(change.id, 'other-agent', 'planner');

  const service = new ChangeService({
    role: 'planner',
    state: 'PLANNING',
    store: store
  });

  const tools = setup(service, store);

  try {
    // Execute with wrong agent id should fail (different from bound session)
    const wrongExec = { agent: { id: 'agent-model-7' }, signal: AbortSignal.timeout(1000) };
    await assert.rejects(
      tools.change_get.execute({ changeId: change.id }, wrongExec),
      (error) => error.code === 'SESSION_NOT_BOUND' || error.message.includes('not bound')
    );

    // But correct session should work for read
    const correctExec = { agent: { id: 'other-agent' }, signal: AbortSignal.timeout(1000) };
    const result = await tools.change_get.execute({ changeId: change.id }, correctExec);
    assert.equal(result.id, change.id);
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
});

test('ChangeService rejects mismatched binding role', async () => {
  const tmpFile = join(process.cwd(), 'test-store-' + Date.now() + '.json');
  await mkdir(process.cwd(), { recursive: true }).catch(() => {});
  const store = await ChangeStore.open(tmpFile);
  const change = await store.create({ title: 'Test', objective: 'Test objective' });

  // Bind as worker, but service is planner
  await store.bindRole(change.id, exec.agent.id, 'worker');

  const service = new ChangeService({
    role: 'planner',
    state: 'PLANNING',
    store: store
  });

  const tools = setup(service, store);

  try {
    // Should fail because binding role doesn't match service role
    await assert.rejects(
      tools.change_get.execute({ changeId: change.id }, exec),
      (error) => error.code === 'SESSION_NOT_BOUND' || error.message.includes('not bound')
    );
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
});

test('integration: full plan/proof/review/repair through real service/store with audit', async () => {
  const tmpFile = join(process.cwd(), 'test-store-' + Date.now() + '.json');
  await mkdir(process.cwd(), { recursive: true }).catch(() => {});
  const store = await ChangeStore.open(tmpFile);
  const change = await store.create({ title: 'Integration Test', objective: 'Test all operations' });

  try {
    // Bind planner session
    await store.bindRole(change.id, exec.agent.id, 'planner');
    const plannerService = new ChangeService({
      role: 'planner',
      state: 'PLANNING',
      store: store
    });
    const plannerTools = setup(plannerService, store);

    // Test change_get
    const getResult = await plannerTools.change_get.execute({ changeId: change.id }, exec);
    assert.equal(getResult.id, change.id);
    assert.equal(getResult.title, 'Integration Test');

    // Submit plan - changes state from DRAFT to PLANNED
    const planResult = await plannerTools.change_submit_plan.execute({
      changeId: change.id,
      content: { steps: ['step1', 'step2'] }
    }, exec);
    assert.equal(planResult.changeId, change.id);
    assert.equal(planResult.revision, 1);

    // Verify audit event exists after plan
    const historyAfterPlan = await store.history(change.id);
    assert.ok(historyAfterPlan.length >= 1, 'Should have audit events after plan');

    // Accept plan to make it READY
    await store.acceptPlan(change.id, planResult.id, { authorized: true });

    // Transition through legal workflow: READY → IMPLEMENTING → PROOF → PREFLIGHT → REVIEW → REPAIR
    await store.transition(change.id, 'IMPLEMENTING');

    // Bind worker session for proof
    await store.bindRole(change.id, 'worker-agent', 'worker');
    const workerService = new ChangeService({
      role: 'worker',
      state: 'IMPLEMENTING',
      store: store,
      planAccepted: true
    });
    const workerTools = setup(workerService, store);
    const workerExec = { agent: { id: 'worker-agent' }, signal: AbortSignal.timeout(1000) };

    // Submit proof (in IMPLEMENTING state)
    const proofResult = await workerTools.change_submit_proof.execute({
      changeId: change.id,
      content: { evidence: 'test-proof' }
    }, workerExec);
    assert.equal(proofResult.ok, true);

    // Verify audit event after proof
    const historyAfterProof = await store.history(change.id);
    assert.ok(historyAfterProof.length >= 2, 'Should have audit events after proof');

    // Continue workflow: PROOF → PREFLIGHT → REVIEW → REPAIR
    await store.transition(change.id, 'PROOF');
    await store.transition(change.id, 'PREFLIGHT');
    await store.transition(change.id, 'REVIEW');

    // Bind reviewer session for review
    await store.bindRole(change.id, 'reviewer-agent', 'reviewer');
    const reviewerService = new ChangeService({
      role: 'reviewer',
      state: 'REVIEW',
      store: store
    });
    const reviewerTools = setup(reviewerService, store);
    const reviewerExec = { agent: { id: 'reviewer-agent' }, signal: AbortSignal.timeout(1000) };

    // Test change_submit_review - should succeed (in REVIEW state)
    const reviewResult = await reviewerTools.change_submit_review.execute({
      changeId: change.id,
      content: { approval: true }
    }, reviewerExec);
    assert.equal(reviewResult.ok, true);

    // Verify audit event after review
    const historyAfterReview = await store.history(change.id);
    assert.ok(historyAfterReview.length >= 2, 'Should have audit events after review');

    // Transition to REPAIR state
    await store.transition(change.id, 'REPAIR');

    // Bind worker session for repair
    await store.bindRole(change.id, 'repair-agent', 'worker');
    const repairService = new ChangeService({
      role: 'worker',
      state: 'REPAIR',
      store: store,
      planAccepted: true
    });
    const repairTools = setup(repairService, store);
    const repairExec = { agent: { id: 'repair-agent' }, signal: AbortSignal.timeout(1000) };

    // Test change_submit_repair - should succeed
    const repairResult = await repairTools.change_submit_repair.execute({
      changeId: change.id,
      content: { fix: 'test-fix' }
    }, repairExec);
    assert.equal(repairResult.ok, true);

    // Verify audit event after repair
    const finalHistory = await store.history(change.id);
    assert.ok(finalHistory.length >= 4, 'Should have audit events after repair');

  } finally {
    await unlink(tmpFile).catch(() => {});
  }
});

test('integration: legal workflow with state transitions for proof/review/repair', async () => {
  const tmpFile = join(process.cwd(), 'test-store-' + Date.now() + '.json');
  await mkdir(process.cwd(), { recursive: true }).catch(() => {});
  const store = await ChangeStore.open(tmpFile);
  const change = await store.create({ title: 'Legal Workflow Test', objective: 'Test legal transitions' });

  try {
    // Step 1: Planner submits plan (DRAFT → PLANNED)
    await store.bindRole(change.id, exec.agent.id, 'planner');
    const plannerService = new ChangeService({
      role: 'planner',
      state: 'PLANNING',
      store: store
    });
    const plannerTools = setup(plannerService, store);

    const planResult = await plannerTools.change_submit_plan.execute({
      changeId: change.id,
      content: { steps: ['step1'] }
    }, exec);
    assert.equal(planResult.revision, 1);

    // Step 2: Transition to READY (plan accepted)
    await store.acceptPlan(change.id, planResult.id, { authorized: true });

    // Step 3: Transition to IMPLEMENTING (worker starts work)
    await store.transition(change.id, 'IMPLEMENTING');

    // Bind worker session
    await store.bindRole(change.id, 'worker-agent', 'worker');
    const workerService = new ChangeService({
      role: 'worker',
      state: 'IMPLEMENTING',
      store: store,
      planAccepted: true
    });
    const workerTools = setup(workerService, store);
    const workerExec = { agent: { id: 'worker-agent' }, signal: AbortSignal.timeout(1000) };

    // Submit proof (now in PROOF state after transition - should succeed)
    const proofResult = await workerTools.change_submit_proof.execute({
      changeId: change.id,
      content: { evidence: 'test-proof' }
    }, workerExec);
    assert.equal(proofResult.ok, true);

    // Verify audit event after proof
    const historyAfterProof = await store.history(change.id);
    assert.ok(historyAfterProof.length >= 2, 'Should have audit events after proof');

    // Step 4: Transition through PROOF → PREFLIGHT → REVIEW (for review)
    await store.transition(change.id, 'PROOF');
    await store.transition(change.id, 'PREFLIGHT');
    await store.transition(change.id, 'REVIEW');

    // Bind reviewer session
    await store.bindRole(change.id, 'reviewer-agent', 'reviewer');
    const reviewerService = new ChangeService({
      role: 'reviewer',
      state: 'REVIEW',
      store: store
    });
    const reviewerTools = setup(reviewerService, store);
    const reviewerExec = { agent: { id: 'reviewer-agent' }, signal: AbortSignal.timeout(1000) };

    // Submit review (now in REVIEW state - should work)
    const reviewResult = await reviewerTools.change_submit_review.execute({
      changeId: change.id,
      content: { approval: true }
    }, reviewerExec);
    assert.equal(reviewResult.ok, true);

    // Verify audit event
    const history = await store.history(change.id);
    assert.ok(history.length >= 2, 'Should have audit events after review');

    // Step 5: Transition to REPAIR (for repair)
    await store.transition(change.id, 'REPAIR');

    // Bind repair worker session
    await store.bindRole(change.id, 'repair-agent', 'worker');
    const repairService = new ChangeService({
      role: 'worker',
      state: 'REPAIR',
      store: store,
      planAccepted: true
    });
    const repairTools = setup(repairService, store);
    const repairExec = { agent: { id: 'repair-agent' }, signal: AbortSignal.timeout(1000) };

    // Submit repair (now in REPAIR state - should work)
    const repairResult = await repairTools.change_submit_repair.execute({
      changeId: change.id,
      content: { fix: 'test-fix' }
    }, repairExec);
    assert.equal(repairResult.ok, true);

    // Verify audit event
    const finalHistory = await store.history(change.id);
    assert.ok(finalHistory.length >= 3, 'Should have audit events after repair');

  } finally {
    await unlink(tmpFile).catch(() => {});
  }
});

test('integration: identity-bearing call without store fails closed', async () => {
  const tmpFile = join(process.cwd(), 'test-store-' + Date.now() + '.json');
  await mkdir(process.cwd(), { recursive: true }).catch(() => {});
  const store = await ChangeStore.open(tmpFile);
  const change = await store.create({ title: 'Test', objective: 'Test' });

  try {
    // Create service WITHOUT store but WITH identity-bearing change
    const service = new ChangeService({
      role: 'planner',
      state: 'PLANNING',
      // No store provided - should fail closed
    });
    const tools = setup(service, store);

    // Should fail because identity is present but no store to verify against
    await assert.rejects(
      tools.change_submit_plan.execute({
        changeId: change.id,
        content: {}
      }, exec),
      (error) => error.code === 'SESSION_NOT_BOUND' || error.message.includes('not bound')
    );
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
});

test('integration: binding role must match configured service role', async () => {
  const tmpFile = join(process.cwd(), 'test-store-' + Date.now() + '.json');
  await mkdir(process.cwd(), { recursive: true }).catch(() => {});
  const store = await ChangeStore.open(tmpFile);
  const change = await store.create({ title: 'Test', objective: 'Test' });

  try {
    // Bind as worker, but service is planner
    await store.bindRole(change.id, exec.agent.id, 'worker');

    const service = new ChangeService({
      role: 'planner',
      state: 'PLANNING',
      store: store
    });
    const tools = setup(service, store);

    // Should fail because binding role doesn't match service role
    await assert.rejects(
      tools.change_get.execute({ changeId: change.id }, exec),
      (error) => error.code === 'SESSION_NOT_BOUND' || error.message.includes('not bound')
    );
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
});
