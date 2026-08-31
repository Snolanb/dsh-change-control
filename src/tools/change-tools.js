// @ts-nocheck
import { defineTool } from '@deepseek-ai/dsh-tools';
import { ChangeService, AuthorizationError } from '../change-control.js';
import { ChangeStore } from '../storage/change-store.js';
import { TRANSITIONS } from '../domain/change.js';

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
 * @param {object} store
 * @param {string} changeId
 * @param {string} nextState
 * @returns {Promise<object>}
 */
async function transitionWithStructure(store, changeId, nextState) {
  try {
    return await store.transition(changeId, nextState);
  } catch (err) {
    if (err.code === 'ILLEGAL_TRANSITION' || err.message?.includes('not legal')) {
      // Get current state and allowed next states
      const change = await store.get(changeId);
      const allowed = TRANSITIONS[change.state] ?? [];
      throw Object.assign(new Error(`Cannot transition from ${change.state} to ${nextState}`), {
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
 * Single source of truth for state translation.
 * @param {string} domainState
 * @returns {string}
 */
function toAuthState(domainState) {
  if (domainState === 'DRAFT' || domainState === 'PLANNED') return 'PLANNING';
  if (domainState === 'IMPLEMENTING') return 'PROOF';
  if (domainState === 'PREFLIGHT') return 'REVIEW';
  if (domainState === 'REVIEW') return 'REPAIR';
  return domainState;
}

/**
 * Define the tool contract: auth state, next state, arg key, and description for each operation.
 * Single source of truth aligned with canonical TRANSITIONS.
 * @type {ReadonlyArray<{name: string, action: string, argKey: string, argType: string, authRoles: string[], authStates: string[], nextState: string, description: string}>}
 */
const TOOL_CONTRACT = Object.freeze([
  { name: 'change_submit_plan',    action: 'submitPlan',    argKey: 'content',  argType: 'object', authRoles: ['planner'],   authStates: ['DRAFT', 'PLANNED'], nextState: 'PLANNED',  description: 'Submit a plan for a Change. Requires planner role on DRAFT/PLANNED change.' },
  { name: 'change_submit_proof',   action: 'submitProof',   argKey: 'proof',    argType: 'string',  authRoles: ['worker'],    authStates: ['IMPLEMENTING'],    nextState: 'PREFLIGHT', description: 'Submit proof of implementation. Requires worker role on IMPLEMENTING change.' },
  { name: 'change_submit_review',  action: 'submitReview',  argKey: 'review',   argType: 'string',  authRoles: ['reviewer'],  authStates: ['PREFLIGHT'],       nextState: 'REVIEW',   description: 'Submit a review for a Change. Requires reviewer role on PREFLIGHT change.' },
  { name: 'change_submit_repair',  action: 'submitRepair',  argKey: 'repair',   argType: 'string',  authRoles: ['worker'],    authStates: ['REVIEW'],          nextState: 'PREFLIGHT',description: 'Submit a repair after review. Requires worker role on REVIEW change.' },
]);

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
   * Create submit tools from TOOL_CONTRACT
   */
  const submitTools = TOOL_CONTRACT.map(({ name, action, argKey, argType, authRoles, authStates, nextState, description }) => {
    return defineTool({
      name,
      description,
      parameters: {
        changeId: { type: 'string' },
        [argKey]: { type: argType, ...(argType === 'object' ? { additionalProperties: true } : {}) },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => value,
      },
      execute: async (args, exec) => {
        validateChangeId(args.changeId);

        // Validate payload exists
        if (!args[argKey]) {
          throw Object.assign(new Error(`${argKey} is required`), { code: `INVALID_${argKey.toUpperCase()}` });
        }

        const { sessionId, role } = await deriveIdentity(args, exec, store);
        const change = await store.get(args.changeId);

        // Authorize using canonical auth states (aligned with TRANSITIONS)
        if (!authStates.includes(change.state)) {
          throw new AuthorizationError('INVALID_CHANGE_STATE',
            `${role} cannot ${action} in ${change.state}`);
        }
        if (!authRoles.includes(role)) {
          throw new AuthorizationError('ROLE_NOT_ALLOWED',
            `${role} cannot ${action}`);
        }

        // Perform the operation via ChangeService
        const service = new ChangeService({ role, state: toAuthState(change.state), sessionBound: true });
        try {
          service[action]({ changeId: args.changeId });
        } catch (err) {
          if (err instanceof AuthorizationError) {
            throw Object.assign(new Error(err.message), { code: err.reason, details: err.details });
          }
          throw err;
        }

        // Delegate to store for the actual operation
        let result;
        if (action === 'submitPlan') {
          result = await store.submitPlan(args.changeId, args[argKey]);
          return { planId: result.id, status: result.status };
        }

        // For proof/review/repair, transition to the next state
        await transitionWithStructure(store, args.changeId, nextState);
        return { success: true };
      },
    });
  });

  return [changeGetTool, ...submitTools];
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
