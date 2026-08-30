/**
 * Canonical role-and-state authorization service for semantic Change operations.
 * Wraps role + semantic state to gate plan submission, acceptance, proof, repair,
 * and review. Returns structured machine-readable denial reasons.
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
  { action: 'submitProof',   roles: ['worker'],      states: ['PROOF'],         planRequired: true  },
  { action: 'submitRepair',  roles: ['worker'],      states: ['REPAIR'],        planRequired: true  },
  { action: 'submitReview',  roles: ['reviewer'],    states: ['REVIEW'],        planRequired: false },
]);

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Minimal authorization service.
 * @param {object} ctx
 * @param {string} ctx.role       'planner' | 'worker' | 'reviewer'
 * @param {string} ctx.state      Current semantic state
 * @param {boolean} [ctx.sessionBound=true]
 * @param {boolean} [ctx.planAccepted=true]
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

  /** @param {{role: string, state: string, sessionBound?: boolean, planAccepted?: boolean}} ctx */
  constructor({ role, state, sessionBound = true, planAccepted = true }) {
    this.#role = role;
    this.#state = state;
    this.#sessionBound = sessionBound;
    this.#planAccepted = planAccepted;
  }

  /**
   * Delegate to the canonical role/state checker.
   * @param {string} action
   * @param {object} [change]
   * @returns {object}
   */
  #authorize(action, change) {
    if (!this.#sessionBound) {
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

  /** @param {object} change */
  submitPlan(change)      { return this.#authorize('submitPlan', change); }
  /** @param {object} change */
  acceptPlan(change)      { return this.#authorize('acceptPlan', change); }
  /** @param {object} change */
  submitProof(change)     { return this.#authorize('submitProof', change); }
  /** @param {object} change */
  submitRepair(change)    { return this.#authorize('submitRepair', change); }
  /** @param {object} change */
  submitReview(change)    { return this.#authorize('submitReview', change); }
}
