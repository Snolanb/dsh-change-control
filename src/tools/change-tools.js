// @ts-nocheck
import { defineTool } from '@deepseek-ai/dsh-tools';
import { ChangeService, AuthorizationError } from '../change-control.js';
import { ChangeStore } from '../storage/change-store.js';
import { TRANSITIONS, ChangeDomainError } from '../domain/change.js';

/**
 * @typedef {object} Identity
 * @property {string} sessionId
 * @property {string} [role]
 */

/**
 * Validate changeId is a valid UUID.
 * Must be called BEFORE deriveIdentity so payload validation precedes store access.
 * @param {string} changeId
 */
function validateChangeId(changeId) {
  if (!changeId || typeof changeId !== 'string') {
    throw Object.assign(new Error('changeId is required and must be a string'), { code: 'INVALID_CHANGE_ID' });
  }
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(changeId)) {
    throw Object.assign(new Error('changeId must be a valid UUID'), { code: 'INVALID_CHANGE_ID' });
  }
}

/**
 * Extract caller identity from execution context and verify binding.
 * Identity comes from exec.agent.id, not from args (which would allow impersonation).
 * @param {object} args
 * @param {object} exec
 * @param {object} store
 * @returns {Promise<Identity>}
 */
async function deriveIdentity(args, exec, store) {
  const sessionId = /** @type {string} */ (exec?.agent?.id);
  const role = /** @type {string|undefined} */ (args.role);

  if (!sessionId) {
    throw new AuthorizationError('IDENTITY_MISSING', 'Session identity must be derived from invocation context');
  }

  // Reject impersonation attempts - if args contains sessionId/role, they should match context
  if (args.sessionId && /** @type {string} */ (args.sessionId) !== sessionId) {
    throw new AuthorizationError('SESSION_IMPERSONATION', 'Session impersonation is not allowed');
  }

  // Verify session binding to change via canonical store path
  const bindingRole = await store.resolveRole(args.changeId, sessionId).catch(() => null);
  if (!bindingRole) {
    throw new AuthorizationError('SESSION_NOT_BOUND', 'Session is not bound to this change');
  }

  return { sessionId, role: bindingRole };
}

/**
 * Wrap a store.transition call, converting domain errors to structured tool errors.
 * Catches actual ChangeDomainError and extracts from/to fields.
 * @param {object} store
 * @param {string} changeId
 * @param {string} nextState
 * @returns {Promise<object>}
 */
async function transitionWithStructure(store, changeId, nextState) {
  try {
    return await store.transition(changeId, nextState);
  } catch (err) {
    // Catch ChangeDomainError directly (has from/to fields)
    if (err instanceof ChangeDomainError) {
      const change = await store.get(changeId);
      const allowed = TRANSITIONS[change.state] ?? [];
      throw Object.assign(new Error(err.message), {
        code: 'ILLEGAL_TRANSITION',
        current: err.from ?? change.state,
        attempted: nextState,
        allowed,
      });
    }
    // Also catch by message pattern for backwards compatibility
    if (err.message?.includes('Cannot transition from')) {
      const change = await store.get(changeId);
      const allowed = TRANSITIONS[change.state] ?? [];
      throw Object.assign(new Error(err.message), {
        code: 'ILLEGAL_TRANSITION',
        current: change.state,
        attempted: nextState,
        allowed,
      });
    }
    throw err;
  }
}

/**
 * Map domain state to authorization state for ChangeService.
 * Single source of truth aligned with canonical ACTIONS matrix.
 * @param {string} domainState
 * @returns {string}
 */
function toAuthState(domainState) {
  // DRAFT and PLANNED are pre-plan states; both map to PLANNING
  if (domainState === 'DRAFT' || domainState === 'PLANNED') return 'PLANNING';
  // IMPLEMENTING is when proof is submitted
  if (domainState === 'IMPLEMENTING') return 'PROOF';
  // PREFLIGHT is when review is submitted
  if (domainState === 'PREFLIGHT') return 'REVIEW';
  // REVIEW is when repair is submitted
  if (domainState === 'REVIEW') return 'REPAIR';
  return domainState;
}

/**
 * Check if a plan is accepted for this change.
 * @param {object} store
 * @param {string} changeId
 * @returns {Promise<boolean>}
 */
async function isPlanAccepted(store, changeId) {
  const change = await store.get(changeId);
  return !!change.acceptedPlanId;
}

/**
 * Factory to create tools with a bound store
 * @param {object} store
 * @returns {Array<any>}
 */
export function createChangeTools(store) {
  /**
   * Create change_get tool
   */
  const changeGetTool = defineTool({
    name: 'change_get',
    description: 'Get a Change record by ID. Returns current state and metadata.',
    parameters: {
      changeId: { type: 'string' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => value,
    },
    execute: async (args, exec) => {
      validateChangeId(args.changeId);
      const { sessionId, role } = await deriveIdentity(args, exec, store);

      const change = await store.get(args.changeId);
      return { id: change.id, state: change.state, title: change.title };
    },
  });

  /**
   * Create change_submit_plan tool
   */
  const changeSubmitPlanTool = defineTool({
    name: 'change_submit_plan',
    description: 'Submit a plan for a Change. Requires planner role on DRAFT/PLANNED change.',
    parameters: {
      changeId: { type: 'string' },
      content: { type: 'object', additionalProperties: true },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => value,
    },
    execute: async (args, exec) => {
      validateChangeId(args.changeId);
      if (!args.content || typeof args.content !== 'object') {
        throw Object.assign(new Error('content is required and must be an object'), { code: 'INVALID_CONTENT' });
      }
      const { sessionId, role } = await deriveIdentity(args, exec, store);

      const change = await store.get(args.changeId);
      const service = new ChangeService({ role, state: toAuthState(change.state), sessionBound: true });
      try {
        service.submitPlan({ changeId: args.changeId });
      } catch (err) {
        if (err instanceof AuthorizationError) {
          throw Object.assign(new Error(err.message), { code: err.reason, details: err.details });
        }
        throw err;
      }

      const plan = await store.submitPlan(args.changeId, args.content);
      return { planId: plan.id, status: plan.status };
    },
  });

  /**
   * Create change_submit_proof tool
   * V1: Requires accepted plan (planAccepted from store)
   */
  const changeSubmitProofTool = defineTool({
    name: 'change_submit_proof',
    description: 'Submit proof of implementation. Requires worker role on IMPLEMENTING change with accepted plan.',
    parameters: {
      changeId: { type: 'string' },
      proof: { type: 'string' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => value,
    },
    execute: async (args, exec) => {
      validateChangeId(args.changeId);
      if (!args.proof || typeof args.proof !== 'string') {
        throw Object.assign(new Error('proof is required and must be a string'), { code: 'INVALID_PROOF' });
      }
      const { sessionId, role } = await deriveIdentity(args, exec, store);

      const change = await store.get(args.changeId);

      // V1: Check plan is accepted before allowing proof
      const planAccepted = await isPlanAccepted(store, args.changeId);
      if (!planAccepted) {
        throw new AuthorizationError('PLAN_NOT_ACCEPTED', 'Plan must be accepted before submitting proof');
      }

      const service = new ChangeService({
        role,
        state: toAuthState(change.state),
        sessionBound: true,
        planAccepted: planAccepted,
      });
      try {
        service.submitProof({ changeId: args.changeId });
      } catch (err) {
        if (err instanceof AuthorizationError) {
          throw Object.assign(new Error(err.message), { code: err.reason, details: err.details });
        }
        throw err;
      }

      // V2: Use structured transition
      await transitionWithStructure(store, args.changeId, 'PREFLIGHT');
      return { success: true };
    },
  });

  /**
   * Create change_submit_review tool
   */
  const changeSubmitReviewTool = defineTool({
    name: 'change_submit_review',
    description: 'Submit a review for a Change. Requires reviewer role on PREFLIGHT change.',
    parameters: {
      changeId: { type: 'string' },
      review: { type: 'string' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => value,
    },
    execute: async (args, exec) => {
      validateChangeId(args.changeId);
      if (!args.review || typeof args.review !== 'string') {
        throw Object.assign(new Error('review is required and must be a string'), { code: 'INVALID_REVIEW' });
      }
      const { sessionId, role } = await deriveIdentity(args, exec, store);

      const change = await store.get(args.changeId);
      const service = new ChangeService({ role, state: toAuthState(change.state), sessionBound: true });
      try {
        service.submitReview({ changeId: args.changeId });
      } catch (err) {
        if (err instanceof AuthorizationError) {
          throw Object.assign(new Error(err.message), { code: err.reason, details: err.details });
        }
        throw err;
      }

      await transitionWithStructure(store, args.changeId, 'REVIEW');
      return { success: true };
    },
  });

  /**
   * Create change_submit_repair tool
   * V1: Requires accepted plan
   * V5: Transitions to REPAIR (not PREFLIGHT directly)
   */
  const changeSubmitRepairTool = defineTool({
    name: 'change_submit_repair',
    description: 'Submit a repair after review. Requires worker role on REVIEW change with accepted plan.',
    parameters: {
      changeId: { type: 'string' },
      repair: { type: 'string' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => value,
    },
    execute: async (args, exec) => {
      validateChangeId(args.changeId);
      if (!args.repair || typeof args.repair !== 'string') {
        throw Object.assign(new Error('repair is required and must be a string'), { code: 'INVALID_REPAIR' });
      }
      const { sessionId, role } = await deriveIdentity(args, exec, store);

      const change = await store.get(args.changeId);

      // V1: Check plan is accepted before allowing repair
      const planAccepted = await isPlanAccepted(store, args.changeId);
      if (!planAccepted) {
        throw new AuthorizationError('PLAN_NOT_ACCEPTED', 'Plan must be accepted before submitting repair');
      }

      const service = new ChangeService({
        role,
        state: toAuthState(change.state),
        sessionBound: true,
        planAccepted: planAccepted,
      });
      try {
        service.submitRepair({ changeId: args.changeId });
      } catch (err) {
        if (err instanceof AuthorizationError) {
          throw Object.assign(new Error(err.message), { code: err.reason, details: err.details });
        }
        throw err;
      }

      // V5: Transition to REPAIR (host controls REPAIR→PREFLIGHT return)
      await transitionWithStructure(store, args.changeId, 'REPAIR');
      return { success: true };
    },
  });

  return [
    changeGetTool,
    changeSubmitPlanTool,
    changeSubmitProofTool,
    changeSubmitReviewTool,
    changeSubmitRepairTool,
  ];
}

/**
 * Register all Change tools with the host
 * @param {object} ctx
 * @param {object} config
 * @param {string} [config.storePath]
 * @returns {Promise<Array<any>>}
 */
export async function registerChangeTools(ctx, config) {
  const storePath = config?.storePath || '.changes.json';
  const store = await ChangeStore.open(storePath);

  // Provide store via context using Cordis provide API
  ctx.provide('changeStore', store);

  const tools = createChangeTools(store);
  const toolsRegistry = ctx.tools;
  if (!toolsRegistry || typeof toolsRegistry.register !== 'function') {
    throw new Error('tools.register not available');
  }

  for (const tool of tools) {
    toolsRegistry.register(tool);
  }

  return tools;
}
