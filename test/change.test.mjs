import test from 'node:test';
import assert from 'node:assert/strict';
import { createChange, ChangeDomainError } from '../src/domain/change.js';

const input = {
  title: 'Rotate API key',
  objective: 'Rotate the production API key safely',
  acceptanceCriteria: ['Old key is revoked after the new key works'],
  risk: 'normal',
};

const makeChange = () => createChange(input);

const transition = (change, state) => change.transitionTo(state);

test('creates a draft change with a unique id and required fields', () => {
  const first = makeChange();
  const second = makeChange();
  assert.equal(first.state, 'DRAFT');
  assert.equal(typeof first.id, 'string');
  assert.notEqual(first.id, second.id);
  assert.equal(first.title, input.title);
  assert.equal(first.objective, input.objective);
  assert.deepEqual(first.acceptanceCriteria, input.acceptanceCriteria);
  assert.equal(first.risk, input.risk);
  assert.equal(typeof first.createdAt, 'string');
  assert.equal(typeof first.updatedAt, 'string');
});

test('allows the legal workflow and repair transitions', () => {
  const change = makeChange();
  for (const state of ['PLANNED', 'READY', 'IMPLEMENTING', 'PREFLIGHT', 'REVIEW']) {
    transition(change, state);
    assert.equal(change.state, state);
  }
  transition(change, 'REPAIR');
  assert.equal(change.state, 'REPAIR');
  transition(change, 'PREFLIGHT');
  assert.equal(change.state, 'PREFLIGHT');
  transition(change, 'REVIEW');
  transition(change, 'APPROVED');
  assert.equal(change.state, 'APPROVED');
});

test('rejects an undefined transition with a typed error and no mutation', () => {
  const change = makeChange();
  const before = { ...structuredClone(change), state: change.state };
  assert.throws(() => transition(change, 'APPROVED'), ChangeDomainError);
  assert.deepEqual({ ...structuredClone(change), state: change.state }, before);
});

test('does not expose an arbitrary public state setter', () => {
  const change = makeChange();
  assert.equal(typeof change.setState, 'undefined');
  assert.throws(() => { change.state = 'PREFLIGHT'; }, TypeError);
  assert.equal(change.state, 'DRAFT');
});
