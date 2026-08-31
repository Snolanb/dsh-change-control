import test from 'node:test';
import assert from 'node:assert/strict';

import { ChangeService, AuthorizationError } from '../src/change-control.js';

const change = { id: 'change-1', summary: 'Ship the change' };

function service(options = {}) {
  return new ChangeService({
    role: options.role,
    state: options.state,
    sessionBound: options.sessionBound ?? true,
    planAccepted: options.planAccepted ?? true,
  });
}

function capture(fn) {
  let error;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, 'expected operation to throw');
  return error;
}

function reason(error) {
  assert.ok(error instanceof AuthorizationError);
  assert.equal(typeof error.reason, 'string');
  return error.reason;
}

// AC: Planner can submit plans only where valid and cannot submit proof/reviews.
test('planner submits a plan in PLANNING', () => {
  const result = service({ role: 'planner', state: 'PLANNING' }).submitPlan(change);
  assert.deepEqual(result, change);
});

test('planner cannot submit proof or reviews', () => {
  assert.equal(reason(capture(() =>
    service({ role: 'planner', state: 'PROOF' }).submitProof(change),
  )), 'ROLE_NOT_ALLOWED');
  assert.equal(reason(capture(() =>
    service({ role: 'planner', state: 'REVIEW' }).submitReview(change),
  )), 'ROLE_NOT_ALLOWED');
});

// AC: Worker can submit proof/repair only where valid and cannot accept plans or review.
test('worker submits proof and repair in their compatible states', () => {
  assert.deepEqual(service({ role: 'worker', state: 'PROOF' }).submitProof(change), change);
  assert.deepEqual(service({ role: 'worker', state: 'REPAIR' }).submitRepair(change), change);
});

test('worker cannot accept plans or submit reviews', () => {
  assert.equal(reason(capture(() =>
    service({ role: 'worker', state: 'PLANNING' }).acceptPlan(change),
  )), 'ROLE_NOT_ALLOWED');
  assert.equal(reason(capture(() =>
    service({ role: 'worker', state: 'REVIEW' }).submitReview(change),
  )), 'ROLE_NOT_ALLOWED');
});

// AC: Reviewer can submit reviews in REVIEW and cannot perform worker mutations.
test('reviewer submits a review in REVIEW', () => {
  assert.deepEqual(service({ role: 'reviewer', state: 'REVIEW' }).submitReview(change), change);
});

test('reviewer cannot perform worker mutations', () => {
  assert.equal(reason(capture(() =>
    service({ role: 'reviewer', state: 'PROOF' }).submitProof(change),
  )), 'ROLE_NOT_ALLOWED');
  assert.equal(reason(capture(() =>
    service({ role: 'reviewer', state: 'REPAIR' }).submitRepair(change),
  )), 'ROLE_NOT_ALLOWED');
});

// AC: Correct role in incompatible state is rejected.
test('rejects a correct role when the semantic state is incompatible', () => {
  assert.equal(reason(capture(() =>
    service({ role: 'planner', state: 'REVIEW' }).submitPlan(change),
  )), 'INVALID_CHANGE_STATE');
  assert.equal(reason(capture(() =>
    service({ role: 'worker', state: 'PLANNING' }).submitProof(change),
  )), 'INVALID_CHANGE_STATE');
  assert.equal(reason(capture(() =>
    service({ role: 'reviewer', state: 'PROOF' }).submitReview(change),
  )), 'INVALID_CHANGE_STATE');
});

// AC: Authorization failures expose machine-readable structured reasons.
test('exposes structured reasons for session and plan preconditions', () => {
  const unbound = capture(() =>
    service({ role: 'planner', state: 'PLANNING', sessionBound: false }).submitPlan(change),
  );
  assert.equal(reason(unbound), 'SESSION_NOT_BOUND');
  assert.equal(unbound.details.reason, 'SESSION_NOT_BOUND');

  const unaccepted = capture(() =>
    service({ role: 'worker', state: 'PROOF', planAccepted: false }).submitProof(change),
  );
  assert.equal(reason(unaccepted), 'PLAN_NOT_ACCEPTED');
  assert.equal(unaccepted.details.reason, 'PLAN_NOT_ACCEPTED');
});

// Regression test: verify binding fails closed when no store is configured
test('verifyBinding returns false when no store is configured', async () => {
  const service = new ChangeService({
    role: 'planner',
    state: 'PLANNING',
    // No store provided
  });

  const result = await service.verifyBinding('C1', 'foreign-session');
  assert.equal(result, false, 'verifyBinding should return false when no store is configured');
});
