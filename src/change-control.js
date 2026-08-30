/**
 * Canonical role-and-state authorization service for semantic Change operations.
 * Wraps role + semantic state to gate plan submission, acceptance, proof, repair,
 * and review. Returns structured machine-readable denial reasons.
 * Enforces session binding to changes via ChangeStore for all operations.
 */

// ─── Error type ───────────────────────────────────────────────────────────────

/**
 * Typed authorization failure with a machine-readable reason.
 */
export class AuthorizationError extends Error {
  /**
   * @param {string} reason
   * @param {string} message
   */
  constructor(reason, message) {
    super(message);
    this.name = 'AuthorizationError';
    /** @type {string} */
    this.reason = reason;
    /** @type {object} */
    this.details = { reason };
  }
}

// ─── Role / state / action matrix ─────────────────────────────────────────────
// Semantic states used by the authorization layer (not the domain state machine).
// Each entry: [action, allowedRoles, requiredSemanticStates, extraPrecondition?]

/** @type {ReadonlyArray<{action: string, roles: readonly string[], states: readonly string[], planRequired?: boolean}>} */
const ACTIONS = Object.freeze([
  { action: 'submitPlan',    roles: ['planner'],     states: ['PLANNING'],      planRequired: false },
  { action: 'acceptPlan',    roles: ['reviewer'],    states: ['PLANNING'],      planRequired: false },
  { action: 'submitProof',   roles: ['worker'],      states: ['IMPLEMENTING', 'PROOF'], planRequired: true  },
  { action: 'submitRepair',  roles: ['worker'],      states: ['REPAIR'],        planRequired: true  },
  { action: 'submitReview',  roles: ['reviewer'],    states: ['REVIEW'],        planRequired: false },
]);

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Minimal authorization service with binding-aware identity enforcement.
 * @param {object} ctx
 * @param {string} ctx.role       'planner' | 'worker' | 'reviewer'
 * @param {string} ctx.state      Current semantic state
 * @param {boolean} [ctx.sessionBound=true]
 * @param {boolean} [ctx.planAccepted=true]
 * @param {object} [ctx.store]    ChangeStore for binding verification
 */
export class ChangeService {
  /** @type {string} */
  #role;
  /** @type {string} */
  #state;
  /** @type {boolean} */
  #sessionBound;
  /** @type {boolean} */
  #planAccepted;
  /** @type {object|null} */
  #store;

  /** @param {{role: string, state: string, sessionBound?: boolean, planAccepted?: boolean, store?: object|null}} ctx */
  constructor({ role, state, sessionBound = true, planAccepted = true, store = null }) {
    this.#role = role;
    this.#state = state;
    this.#sessionBound = sessionBound;
    this.#planAccepted = planAccepted;
    this.#store = store;
  }

  /**
   * Get the configured role.
   * @returns {string}
   */
  getRole() {
    return this.#role;
  }

  /**
   * Verify session binding to change via store, including role match.
   * Fails closed when identity is supplied but no binding-capable store exists.
   * @param {string} changeId
   * @param {string} sessionId
   * @returns {Promise<boolean>}
   */
  async #verifyBinding(changeId, sessionId) {
    /** @type {any} */
    const store = this.#store;
    // Fail closed: if identity is present but no store to verify against, reject
    if (!store || typeof store.resolveRole !== 'function') {
      return false;
    }
    try {
      /** @type {string|null} */
      const bindingRole = await store.resolveRole(changeId, sessionId);
      // Check that the persisted binding role matches our configured role
      if (bindingRole !== this.#role) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delegate to the canonical role/state checker with identity verification.
   * @param {string} action
   * @param {object} change
   * @returns {Promise<object>}
   */
  async #authorize(action, change) {
    /** @type {{changeId?: string, sessionId?: string}} */
    const c = change ?? {};
    const changeId = c.changeId;
    const sessionId = c.sessionId;

    // Verify session binding before any authorization check
    // If identity is supplied, must verify via store (fail closed if no store)
    if (changeId && sessionId) {
      const isBound = await this.#verifyBinding(changeId, sessionId);
      if (!isBound) {
        throw new AuthorizationError('SESSION_NOT_BOUND', 'Session is not bound to this change');
      }
    } else if (this.#sessionBound) {
      // Standalone mode: allow if sessionBound is true (no identity provided)
    } else {
      throw new AuthorizationError('SESSION_NOT_BOUND', 'Session is not bound to this change');
    }

    const def = ACTIONS.find((a) => a.action === action);
    if (!def) throw new Error(`Unknown action: ${action}`);
    if (def.planRequired && !this.#planAccepted) {
      throw new AuthorizationError('PLAN_NOT_ACCEPTED', 'Plan must be accepted before this operation');
    }
    if (!def.roles.includes(this.#role)) {
      throw new AuthorizationError('ROLE_NOT_ALLOWED', `${this.#role} cannot ${action}`);
    }
    if (!def.states.includes(this.#state)) {
      throw new AuthorizationError('INVALID_CHANGE_STATE', `${this.#role} cannot ${action} in ${this.#state}`);
    }
    return change ?? {};
  }

  /**
   * Read/get authorization - verifies binding and returns change for reading.
   * @param {object} change
   * @returns {Promise<object>}
   */
  async get(change) {
    /** @type {{changeId?: string, sessionId?: string}} */
    const c = change ?? {};
    const changeId = c.changeId;
    const sessionId = c.sessionId;

    // Verify session binding for reads
    // If identity is supplied, must verify via store (fail closed if no store)
    if (changeId && sessionId) {
      const isBound = await this.#verifyBinding(changeId, sessionId);
      if (!isBound) {
        throw new AuthorizationError('SESSION_NOT_BOUND', 'Session is not bound to this change');
      }
    } else if (this.#sessionBound) {
      // Standalone mode: allow if sessionBound is true (no identity provided)
    } else {
      throw new AuthorizationError('SESSION_NOT_BOUND', 'Session is not bound to this change');
    }

    return change ?? {};
  }

  /** @param {object} change */
  async submitPlan(change)      { return this.#authorize('submitPlan', change); }
  /** @param {object} change */
  async acceptPlan(change)      { return this.#authorize('acceptPlan', change); }
  /** @param {object} change */
  async submitProof(change)     { return this.#authorize('submitProof', change); }
  /** @param {object} change */
  async submitRepair(change)    { return this.#authorize('submitRepair', change); }
  /** @param {object} change */
  async submitReview(change)    { return this.#authorize('submitReview', change); }
}
