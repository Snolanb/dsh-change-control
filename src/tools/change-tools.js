// @ts-nocheck
import { defineTool } from '@deepseek-ai/dsh-tools';
import { ChangeService, AuthorizationError } from '../change-control.js';
import { ChangeStore } from '../storage/change-store.js';
import { TRANSITIONS, ChangeDomainError } from '../domain/change.js';

/**
 * Validate changeId is a valid UUID before any store access.
 */
function validateChangeId(changeId) {
  if (!changeId || typeof changeId !== 'string') {
    throw Object.assign(new Error('changeId is required and must be a string'), { code: 'INVALID_CHANGE_ID' });
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(changeId)) {
    throw Object.assign(new Error('changeId must be a valid UUID'), { code: 'INVALID_CHANGE_ID' });
  }
}

/**
 * Extract caller identity from exec context. Reject impersonation.
 */
async function deriveIdentity(args, exec, store) {
  const sessionId = exec?.agent?.id;
  if (!sessionId) {
    throw new AuthorizationError('IDENTITY_MISSING', 'Session identity must be derived from invocation context');
  }
  if (args.sessionId && args.sessionId !== sessionId) {
    throw new AuthorizationError('SESSION_IMPERSONATION', 'Session impersonation is not allowed');
  }
  const bindingRole = await store.resolveRole(args.changeId, sessionId).catch(() => null);
  if (!bindingRole) {
    throw new AuthorizationError('SESSION_NOT_BOUND', 'Session is not bound to this change');
  }
  return { sessionId, role: bindingRole };
}

/**
 * Wrap store.transition, converting domain errors to structured tool errors.
 */
async function transitionWithStructure(store, changeId, nextState) {
  try {
    return await store.transition(changeId, nextState);
  } catch (err) {
    if (err instanceof ChangeDomainError || err.message?.includes('Cannot transition')) {
      const change = await store.get(changeId);
      const allowed = TRANSITIONS[change.state] ?? [];
      throw Object.assign(new Error(err.message), {
        code: 'ILLEGAL_TRANSITION',
        current: err.from ?? change.state,
        attempted: nextState,
        allowed,
      });
    }
    throw err;
  }
}

/**
 * Map domain state to ChangeService auth state.
 * Single source of truth: DRAFT/PLANNED→PLANNING, IMPLEMENTING→PROOF, PREFLIGHT→REVIEW, REVIEW→REPAIR.
 */
function toAuthState(domainState) {
  const map = { DRAFT: 'PLANNING', PLANNED: 'PLANNING', IMPLEMENTING: 'PROOF', PREFLIGHT: 'REVIEW', REVIEW: 'REPAIR' };
  return map[domainState] ?? domainState;
}

/**
 * Create all five Change tools. Tool layer delegates auth/transitions to canonical ChangeService/domain.
 */
export function createChangeTools(store) {
  const tools = [
    defineTool({
      name: 'change_get',
      description: 'Get a Change record by ID.',
      parameters: { changeId: { type: 'string' } },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => v },
      execute: async (args, exec) => {
        validateChangeId(args.changeId);
        const { sessionId } = await deriveIdentity(args, exec, store);
        const change = await store.get(args.changeId);
        return { id: change.id, state: change.state, title: change.title };
      },
    }),
    defineTool({
      name: 'change_submit_plan',
      description: 'Submit a plan for a Change. Requires planner role on DRAFT/PLANNED change.',
      parameters: { changeId: { type: 'string' }, content: { type: 'object', additionalProperties: true } },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => v },
      execute: async (args, exec) => {
        validateChangeId(args.changeId);
        if (!args.content || typeof args.content !== 'object') {
          throw Object.assign(new Error('content is required and must be an object'), { code: 'INVALID_CONTENT' });
        }
        const { sessionId, role } = await deriveIdentity(args, exec, store);
        const change = await store.get(args.changeId);
        const service = new ChangeService({ role, state: toAuthState(change.state), sessionBound: true });
        try { service.submitPlan(); } catch (err) {
          if (err instanceof AuthorizationError) throw Object.assign(new Error(err.message), { code: err.reason });
          throw err;
        }
        const plan = await store.submitPlan(args.changeId, args.content);
        return { planId: plan.id, status: plan.status };
      },
    }),
    defineTool({
      name: 'change_submit_proof',
      description: 'Submit proof of implementation. Requires worker role on IMPLEMENTING change with accepted plan.',
      parameters: { changeId: { type: 'string' }, proof: { type: 'string' } },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => v },
      execute: async (args, exec) => {
        validateChangeId(args.changeId);
        if (!args.proof || typeof args.proof !== 'string') {
          throw Object.assign(new Error('proof is required and must be a string'), { code: 'INVALID_PROOF' });
        }
        const { sessionId, role } = await deriveIdentity(args, exec, store);
        const change = await store.get(args.changeId);
        // V1: Derive planAccepted from persisted store state
        const planAccepted = !!change.acceptedPlanId;
        const service = new ChangeService({ role, state: toAuthState(change.state), sessionBound: true, planAccepted });
        try { service.submitProof(); } catch (err) {
          if (err instanceof AuthorizationError) throw Object.assign(new Error(err.message), { code: err.reason });
          throw err;
        }
        await transitionWithStructure(store, args.changeId, 'PREFLIGHT');
        return { success: true };
      },
    }),
    defineTool({
      name: 'change_submit_review',
      description: 'Submit a review for a Change. Requires reviewer role on PREFLIGHT change.',
      parameters: { changeId: { type: 'string' }, review: { type: 'string' } },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => v },
      execute: async (args, exec) => {
        validateChangeId(args.changeId);
        if (!args.review || typeof args.review !== 'string') {
          throw Object.assign(new Error('review is required and must be a string'), { code: 'INVALID_REVIEW' });
        }
        const { sessionId, role } = await deriveIdentity(args, exec, store);
        const change = await store.get(args.changeId);
        const service = new ChangeService({ role, state: toAuthState(change.state), sessionBound: true });
        try { service.submitReview(); } catch (err) {
          if (err instanceof AuthorizationError) throw Object.assign(new Error(err.message), { code: err.reason });
          throw err;
        }
        await transitionWithStructure(store, args.changeId, 'REVIEW');
        return { success: true };
      },
    }),
    defineTool({
      name: 'change_submit_repair',
      description: 'Submit a repair after review. Requires worker role on REVIEW change with accepted plan.',
      parameters: { changeId: { type: 'string' }, repair: { type: 'string' } },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => v },
      execute: async (args, exec) => {
        validateChangeId(args.changeId);
        if (!args.repair || typeof args.repair !== 'string') {
          throw Object.assign(new Error('repair is required and must be a string'), { code: 'INVALID_REPAIR' });
        }
        const { sessionId, role } = await deriveIdentity(args, exec, store);
        const change = await store.get(args.changeId);
        // V1: Derive planAccepted from persisted store state
        const planAccepted = !!change.acceptedPlanId;
        const service = new ChangeService({ role, state: toAuthState(change.state), sessionBound: true, planAccepted });
        try { service.submitRepair(); } catch (err) {
          if (err instanceof AuthorizationError) throw Object.assign(new Error(err.message), { code: err.reason });
          throw err;
        }
        // V5: Transition to REPAIR (host controls REPAIR→PREFLIGHT return)
        await transitionWithStructure(store, args.changeId, 'REPAIR');
        return { success: true };
      },
    }),
  ];
  return tools;
}

export async function registerChangeTools(ctx, config) {
  const storePath = config?.storePath || '.changes.json';
  const store = await ChangeStore.open(storePath);
  ctx.provide('changeStore', store);
  const tools = createChangeTools(store);
  const registry = ctx.tools;
  if (!registry?.register) throw new Error('tools.register not available');
  for (const tool of tools) registry.register(tool);
  return store;
}
