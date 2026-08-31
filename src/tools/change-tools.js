// @ts-nocheck
/**
 * Narrow DSH Change tools registration.
 * Derives identity from exec.agent.id, rejects impersonation, validates before persistence,
 * delegates to canonical ChangeService (authorization) and ChangeStore (persistence).
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { AuthorizationError } from '../change-control.js';

/**
 * Map tool names to canonical service/store method names.
 */
const HANDLER_MAP = Object.freeze({
  change_get: 'get',
  change_submit_plan: 'submitPlan',
  change_submit_proof: 'submitProof',
  change_submit_review: 'submitReview',
  change_submit_repair: 'submitRepair',
});

const TOOL_NAMES = Object.freeze(Object.keys(HANDLER_MAP));

/**
 * Validate payload fields.
 * @param {object} params
 * @returns {void}
 * @throws {Error} with code INVALID_ARGS on failure
 */
function validatePayload(params) {
  if (typeof params.changeId !== 'string' || params.changeId.trim() === '') {
    const err = new Error('changeId is required and must be a non-empty string');
    err.code = 'INVALID_ARGS';
    throw err;
  }
}

/**
 * Register narrow semantic Change tools via defineTool and ctx.tools.register.
 * Delegates authorization to canonical ChangeService and persistence to canonical ChangeStore.
 * @param {object} ctx - Cordis context with changeService and changeStore
 * @returns {void}
 */
export function registerChangeTools(ctx) {
  // Guard: only register when tools registry is available.
  // Use a try/catch around direct property access to handle Cordis proxy
  // behavior when 'tools' is not injected into the context.
  let tools;
  try { tools = ctx.tools; } catch { tools = null; }
  if (!tools || typeof tools.register !== 'function') return;

  for (const name of TOOL_NAMES) {
    const handler = HANDLER_MAP[name];
    const tool = defineTool({
      name,
      description: `Perform ${handler} operation on a change`,
      parameters: {
        changeId: { type: 'string', description: 'The change identifier', required: true },
        content: { type: 'json', description: 'Operation-specific payload' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => JSON.stringify(value),
      },
      execute: async (params, exec) => {
        // Derive identity from exec.agent.id — enforce, never accept from payload
        const sessionId = exec.agent?.id;
        if (!sessionId) {
          const err = new Error('agent.id is required for identity');
          err.code = 'INVALID_ARGS';
          throw err;
        }

        // Validate payload before persistence/service invocation
        validatePayload(params);

        // Delegate to canonical services
        const service = ctx.changeService;
        const store = ctx.changeStore;

        // Build canonical change object with identity binding for authorization
        const change = {
          changeId: params.changeId,
          sessionId,
          content: params.content,
        };

        if (handler === 'get') {
          // change_get: authorize via canonical ChangeService, then read from store
          if (!service || typeof service.get !== 'function') {
            const err = new Error('changeService.get not available');
            err.code = 'INVALID_ARGS';
            throw err;
          }
          if (!store || typeof store.get !== 'function') {
            const err = new Error('changeStore.get not available');
            err.code = 'INVALID_ARGS';
            throw err;
          }
          // Authorization check via canonical ChangeService
          await service.get(change);
          // Verify session binding — fail closed when identity present but no binding store
          if (sessionId && service.verifyBinding) {
            const bound = await service.verifyBinding(params.changeId, sessionId);
            if (!bound) {
              throw new AuthorizationError('SESSION_NOT_BOUND', 'Session is not bound to this change');
            }
          }
          // Read from canonical store
          return await store.get(params.changeId);
        }

        // Mutation operations: authorize via ChangeService, persist via ChangeStore
        if (!service || typeof service[handler] !== 'function') {
          throw new AuthorizationError('INVALID_ARGS', `Service method ${handler} not available`);
        }
        if (!store || typeof store[handler] !== 'function') {
          throw new AuthorizationError('INVALID_ARGS', `Store method ${handler} not available`);
        }

        // Authorization check via canonical ChangeService
        await service[handler](change);
        // Verify session binding for mutations
        if (sessionId && service.verifyBinding) {
          const bound = await service.verifyBinding(params.changeId, sessionId);
          if (!bound) {
            throw new AuthorizationError('SESSION_NOT_BOUND', 'Session is not bound to this change');
          }
        }

        // Persistence via canonical ChangeStore (takes changeId, content)
        const result = await store[handler](params.changeId, params.content);
        return result;
      },
    });
    tools.register(tool);
  }
}
