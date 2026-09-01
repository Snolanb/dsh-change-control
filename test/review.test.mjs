import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChangeStore } from '../src/storage/change-store.js';
import { ChangeService, AuthorizationError } from '../src/change-control.js';

const input = {
  title: 'Rotate API key',
  objective: 'Rotate the production API key safely',
  acceptanceCriteria: ['Old key is revoked after the new key works'],
  risk: 'normal',
};

async function withReviewStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-review-'));
  try {
    const store = await ChangeStore.open(join(dir, 'changes.json'));
    const change = await store.create(input);
    for (const state of ['PLANNED', 'READY', 'IMPLEMENTING', 'PREFLIGHT', 'REVIEW']) {
      await store.transition(change.id, state);
    }
    // Record an implementation attempt with revision so reviews can be bound
    await store.recordAttempt(change.id, { attemptId: 'impl-1', workerId: 'worker-1', revision: 'impl-1', status: 'completed' });
    return await fn(store, change);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const pass = (revision = 'impl-1') => ({
  verdict: 'pass',
  revision,
  findings: [],
});

const finding = (severity = 'important') => ({
  severity,
  category: 'security',
  location: 'src/key-rotation.js:12',
  problem: 'Old key remains active',
  requiredOutcome: 'Revoke old key before approval',
});

// AC1: REVIEW submission requires reviewer role and an independent binding.
test('requires an independently bound reviewer to submit in REVIEW', () => withReviewStore(async (store, change) => {
  await store.bindRole(change.id, 'worker-session', 'worker');
  const before = await store.get(change.id);
  await assert.rejects(
    store.submitReview(change.id, pass(), { sessionId: 'worker-session' }),
    (error) => error.code === 'ROLE_NOT_ALLOWED' || error.code === 'REVIEWER_REQUIRED',
  );
  assert.deepEqual(await store.get(change.id), before);

  await store.bindRole(change.id, 'reviewer-session', 'reviewer');
  const result = await store.submitReview(change.id, pass(), { sessionId: 'reviewer-session' });
  assert.equal(result.state, 'APPROVED');
}));

// AC2: A passing review with no blocking findings approves the Change.
test('passing review with no blocking findings moves Change to APPROVED', () => withReviewStore(async (store, change) => {
  await store.bindRole(change.id, 'reviewer-session', 'reviewer');
  const result = await store.submitReview(change.id, pass(), { sessionId: 'reviewer-session' });
  assert.equal(result.state, 'APPROVED');
  assert.equal((await store.get(change.id)).state, 'APPROVED');
}));

// AC3: A failing review with a blocking finding moves the Change to REPAIR.
test('failing review with a blocking finding moves Change to REPAIR', () => withReviewStore(async (store, change) => {
  await store.bindRole(change.id, 'reviewer-session', 'reviewer');
  const result = await store.submitReview(change.id, {
    ...pass(),
    verdict: 'fail',
    findings: [finding('critical')],
  }, { sessionId: 'reviewer-session' });
  assert.equal(result.state, 'REPAIR');
  assert.equal((await store.get(change.id)).state, 'REPAIR');
}));

// AC4: Accepted findings receive unique immutable stable IDs.
test('assigns unique immutable IDs to accepted findings and persists them', () => withReviewStore(async (store, change) => {
  await store.bindRole(change.id, 'reviewer-session', 'reviewer');
  const result = await store.submitReview(change.id, {
    ...pass(),
    verdict: 'fail',
    findings: [
      { ...finding(), problem: 'Missing test' },
      { ...finding(), problem: 'Missing proof' },
    ],
  }, { sessionId: 'reviewer-session' });
  assert.equal(result.findings.length, 2);
  assert.match(result.findings[0].id, /^finding-/);
  assert.notEqual(result.findings[0].id, result.findings[1].id);
  const id = result.findings[0].id;
  assert.equal((await store.getReview(change.id)).findings[0].id, id);
  assert.throws(() => { result.findings[0].id = 'tampered'; }, TypeError);
  assert.equal((await store.getReview(change.id)).findings[0].id, id);
}));

// AC5: Important/critical findings require concrete required outcomes.
test('validates finding severity, category, location, problem, and requiredOutcome', () => withReviewStore(async (store, change) => {
  await store.bindRole(change.id, 'reviewer-session', 'reviewer');
  for (const field of ['category', 'location', 'problem', 'requiredOutcome']) {
    const invalid = finding('important');
    delete invalid[field];
    const before = await store.get(change.id);
    await assert.rejects(store.submitReview(change.id, {
      ...pass(),
      verdict: 'fail',
      findings: [invalid],
    }, { sessionId: 'reviewer-session' }), (error) => error.code === 'INVALID_REVIEW');
    assert.deepEqual(await store.get(change.id), before);
  }
  for (const severity of ['important', 'critical']) {
    const invalid = finding(severity);
    invalid.requiredOutcome = '';
    await assert.rejects(store.submitReview(change.id, {
      ...pass(), verdict: 'fail', findings: [invalid],
    }, { sessionId: 'reviewer-session' }), (error) => error.code === 'INVALID_REVIEW');
  }
  // Whitespace-only values should also be rejected
  for (const field of ['severity', 'category', 'location', 'problem', 'requiredOutcome']) {
    const invalid = finding('important');
    invalid[field] = '   ';
    await assert.rejects(store.submitReview(change.id, {
      ...pass(), verdict: 'fail', findings: [invalid],
    }, { sessionId: 'reviewer-session' }), (error) => error.code === 'INVALID_REVIEW');
  }
  // Whitespace-only revision should also be rejected
  await assert.rejects(store.submitReview(change.id, {
    ...pass('   '), verdict: 'fail', findings: [finding('important')],
  }, { sessionId: 'reviewer-session' }), (error) => error.code === 'INVALID_REVIEW');
}));

// AC6: Reviewer authorization cannot mutate implementation.
test('reviewer cannot mutate implementation operations', () => {
  const reviewer = new ChangeService({ role: 'reviewer', state: 'REVIEW' });
  const change = Object.freeze({ id: 'change-1', implementation: Object.freeze({ revision: 'impl-1' }) });
  assert.throws(() => reviewer.submitProof(change), AuthorizationError);
  assert.throws(() => reviewer.submitRepair(change), AuthorizationError);
  assert.deepEqual(change, { id: 'change-1', implementation: { revision: 'impl-1' } });
});

// AC7: Review records implementation revision and becomes stale after implementation changes.
test('records revision and marks review stale after implementation changes', () => withReviewStore(async (store, change) => {
  await store.bindRole(change.id, 'reviewer-session', 'reviewer');
  await store.submitReview(change.id, pass('impl-1'), { sessionId: 'reviewer-session' });
  assert.equal((await store.getReview(change.id)).revision, 'impl-1');

  await store.recordAttempt(change.id, { attemptId: 'impl-2', workerId: 'worker-1', revision: 'impl-2', status: 'completed' });
  const review = await store.getReview(change.id);
  assert.equal(review.stale, true);
}));

// Additional repair-round-2 tests

test('fail+minor-only findings routes to REPAIR', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-review-'));
  try {
    const store = await ChangeStore.open(join(dir, 'changes.json'));
    const change = await store.create(input);
    for (const state of ['PLANNED', 'READY', 'IMPLEMENTING', 'PREFLIGHT', 'REVIEW']) {
      await store.transition(change.id, state);
    }
    await store.recordAttempt(change.id, { attemptId: 'impl-1', workerId: 'worker-1', revision: 'impl-1', status: 'completed' });
    await store.bindRole(change.id, 'reviewer-session', 'reviewer');
    const result = await store.submitReview(change.id, {
      verdict: 'fail',
      revision: 'impl-1',
      findings: [{ severity: 'minor', category: 'style', location: 'file.js:1', problem: 'Style issue', requiredOutcome: 'Fix style' }],
    }, { sessionId: 'reviewer-session' });
    assert.equal(result.state, 'REPAIR');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fail+empty findings is rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-review-'));
  try {
    const store = await ChangeStore.open(join(dir, 'changes.json'));
    const change = await store.create(input);
    for (const state of ['PLANNED', 'READY', 'IMPLEMENTING', 'PREFLIGHT', 'REVIEW']) {
      await store.transition(change.id, state);
    }
    await store.recordAttempt(change.id, { attemptId: 'impl-1', workerId: 'worker-1', revision: 'impl-1', status: 'completed' });
    await store.bindRole(change.id, 'reviewer-session', 'reviewer');
    await assert.rejects(
      store.submitReview(change.id, { verdict: 'fail', revision: 'impl-1', findings: [] }, { sessionId: 'reviewer-session' }),
      (error) => error.code === 'INVALID_REVIEW'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pass+critical findings is rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-review-'));
  try {
    const store = await ChangeStore.open(join(dir, 'changes.json'));
    const change = await store.create(input);
    for (const state of ['PLANNED', 'READY', 'IMPLEMENTING', 'PREFLIGHT', 'REVIEW']) {
      await store.transition(change.id, state);
    }
    await store.recordAttempt(change.id, { attemptId: 'impl-1', workerId: 'worker-1', revision: 'impl-1', status: 'completed' });
    await store.bindRole(change.id, 'reviewer-session', 'reviewer');
    await assert.rejects(
      store.submitReview(change.id, {
        verdict: 'pass',
        revision: 'impl-1',
        findings: [finding('critical')],
      }, { sessionId: 'reviewer-session' }),
      (error) => error.code === 'INVALID_REVIEW'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('round-1 findings survive round-2', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-review-'));
  try {
    const store = await ChangeStore.open(join(dir, 'changes.json'));
    const change = await store.create(input);
    for (const state of ['PLANNED', 'READY', 'IMPLEMENTING', 'PREFLIGHT', 'REVIEW']) {
      await store.transition(change.id, state);
    }
    await store.recordAttempt(change.id, { attemptId: 'impl-1', workerId: 'worker-1', revision: 'impl-1', status: 'completed' });
    await store.bindRole(change.id, 'reviewer-session', 'reviewer');

    // Round 1: fail with critical finding
    const r1 = await store.submitReview(change.id, {
      verdict: 'fail',
      revision: 'impl-1',
      findings: [finding('critical')],
    }, { sessionId: 'reviewer-session' });
    assert.equal(r1.state, 'REPAIR');
    const r1FindingId = r1.findings[0].id;

    // Transition through repair cycle
    await store.recordAttempt(change.id, { attemptId: 'impl-2', workerId: 'worker-1', revision: 'impl-2', status: 'completed' });
    await store.transition(change.id, 'PREFLIGHT');
    await store.transition(change.id, 'REVIEW');

    // Round 2: pass
    const r2 = await store.submitReview(change.id, pass('impl-2'), { sessionId: 'reviewer-session' });
    assert.equal(r2.state, 'APPROVED');

    // List reviews should show both rounds
    const reviews = await store.listReviews(change.id);
    assert.equal(reviews.length, 2);
    assert.equal(reviews[0].findings[0].id, r1FindingId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('self-review is rejected when reviewer has recorded attempts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-review-'));
  try {
    const store = await ChangeStore.open(join(dir, 'changes.json'));
    const change = await store.create(input);
    for (const state of ['PLANNED', 'READY', 'IMPLEMENTING', 'PREFLIGHT', 'REVIEW']) {
      await store.transition(change.id, state);
    }
    // Record an attempt as worker-session
    await store.recordAttempt(change.id, { attemptId: 'impl-1', workerId: 'worker-session', revision: 'impl-1', status: 'completed' });
    // Bind same session as reviewer
    await store.bindRole(change.id, 'worker-session', 'reviewer');
    // Try to submit review - should be rejected
    await assert.rejects(
      store.submitReview(change.id, pass(), { sessionId: 'worker-session' }),
      (error) => error.code === 'REVIEWER_NOT_INDEPENDENT'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stale revision is rejected at submit time', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-review-'));
  try {
    const store = await ChangeStore.open(join(dir, 'changes.json'));
    const change = await store.create(input);
    for (const state of ['PLANNED', 'READY', 'IMPLEMENTING', 'PREFLIGHT', 'REVIEW']) {
      await store.transition(change.id, state);
    }
    await store.bindRole(change.id, 'reviewer-session', 'reviewer');
    // Record attempt with impl-2
    await store.recordAttempt(change.id, { attemptId: 'impl-2', workerId: 'worker-1', revision: 'impl-2', status: 'completed' });
    // Try to submit review with stale revision impl-1
    await assert.rejects(
      store.submitReview(change.id, pass('impl-1'), { sessionId: 'reviewer-session' }),
      (error) => error.code === 'STALE_REVISION'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cross-instance review visibility', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-review-'));
  try {
    const file = join(dir, 'changes.json');
    // Instance A creates and submits review
    const storeA = await ChangeStore.open(file);
    const change = await storeA.create(input);
    for (const state of ['PLANNED', 'READY', 'IMPLEMENTING', 'PREFLIGHT', 'REVIEW']) {
      await storeA.transition(change.id, state);
    }
    await storeA.recordAttempt(change.id, { attemptId: 'impl-1', workerId: 'worker-1', revision: 'impl-1', status: 'completed' });
    await storeA.bindRole(change.id, 'reviewer-session', 'reviewer');
    await storeA.submitReview(change.id, pass(), { sessionId: 'reviewer-session' });

    // Instance B (opened after A) should see the review
    const storeB = await ChangeStore.open(file);
    const review = await storeB.getReview(change.id);
    assert.equal(review.verdict, 'pass');
    assert.equal(review.revision, 'impl-1');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
