/**
 * Change domain model and deterministic semantic state machine.
 *
 * @fileoverview Canonical centralized transition rules for Change lifecycle.
 * No storage, tools, commands, policy, UI, or GitHub integration.
 */

/**
 * Typed error for invalid state transitions.
 */
export class ChangeDomainError extends Error {
  /**
   * @param {string} message
   * @param {string} from
   * @param {string} to
   */
  constructor(message, from, to) {
    super(message);
    this.name = 'ChangeDomainError';
    /** @type {string} */
    this.from = from;
    /** @type {string} */
    this.to = to;
  }
}

/**
 * Deep-freeze helper for nested arrays.
 * @param {Record<string, any>} obj
 * @returns {Record<string, any>}
 */
function deepFreeze(obj) {
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return obj;
}

/**
 * Canonical immutable transition ruleset.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const TRANSITIONS = deepFreeze({
  DRAFT: ['PLANNED'],
  PLANNED: ['READY'],
  READY: ['IMPLEMENTING'],
  IMPLEMENTING: ['PREFLIGHT'],
  PREFLIGHT: ['REVIEW'],
  REVIEW: ['REPAIR', 'APPROVED'],
  REPAIR: ['PREFLIGHT'],
  APPROVED: [],
});

/**
 * Create a new Change with unique ID and DRAFT state.
 * @param {object} params
 * @param {string} params.title
 * @param {string} [params.objective='']
 * @param {string[]} [params.acceptanceCriteria=[]]
 * @param {'low'|'normal'|'high'} [params.risk='normal']
 * @returns {Change}
 */
export function createChange({ title, objective = '', acceptanceCriteria = [], risk = 'normal' }) {
  return new Change({ title, objective, acceptanceCriteria, risk });
}

/**
 * A Change domain entity with deterministic state machine.
 */
export class Change {
  #state = 'DRAFT';

  // ponytail: plan-lifecycle transitions (READY→PLANNED) live outside the domain
  // state machine; store them here so the domain stays clean and tests can't
  // reach an arbitrary public setter.
  /** @type {Map<Change, string>} */
  #planStateOverride = new Map();

  /**
   * @param {object} params
   * @param {string} params.title
   * @param {string} [params.objective]
   * @param {string[]} [params.acceptanceCriteria]
   * @param {'low'|'normal'|'high'} [params.risk]
   */
  constructor({ title, objective = '', acceptanceCriteria = [], risk = 'normal' }) {
    /** @type {string} */
    this.id = crypto.randomUUID();
    /** @type {string} */
    this.title = title;
    /** @type {string} */
    this.objective = objective;
    /** @type {string[]} */
    this.acceptanceCriteria = acceptanceCriteria;
    /** @type {'low'|'normal'|'high'} */
    this.risk = risk;
    /** @type {string|null} */
    this.acceptedPlanId = null;
    /** @type {string} */
    this.createdAt = new Date().toISOString();
    /** @type {string} */
    this.updatedAt = new Date().toISOString();
  }

  /**
   * Current state (read-only getter).
   * Returns any plan-lifecycle override first, then falls back to the domain state.
   * @returns {string}
   */
  get state() {
    return this.#planStateOverride.get(this) ?? this.#state;
  }

  /**
   * Internal: store-only state override for plan lifecycle transitions.
   * @param {string} nextState
   */
  _setPlanState(nextState) {
    this.#planStateOverride.set(this, nextState);
    this.updatedAt = new Date().toISOString();
  }

  /**
   * Internal: read the plan state override (returns undefined if none).
   * @returns {string | undefined}
   */
  _getPlanState() {
    return this.#planStateOverride.get(this);
  }

  /**
   * Perform a semantic state transition.
   * @param {string} nextState
   * @returns {Change} this
   */
  transitionTo(nextState) {
    const allowed = TRANSITIONS[this.#state];
    if (!allowed || !allowed.includes(nextState)) {
      throw new ChangeDomainError(
        `Cannot transition from ${this.#state} to ${nextState}`,
        this.#state,
        nextState
      );
    }
    // Only mutate state after successful validation
    this.#state = nextState;
    this.updatedAt = new Date().toISOString();
    return this;
  }


}
