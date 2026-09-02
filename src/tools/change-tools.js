// @ts-nocheck
import { defineTool } from '@deepseek-ai/dsh-tools';
import { ChangeService, AuthorizationError } from '../change-control.js';
import { ChangeStore } from '../storage/change-store.js';
import { TRANSITIONS, ChangeDomainError, RISK_LEVELS } from '../domain/change.js';

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
 * Single source of truth: DRAFT/PLANNED→PLANNING, IMPLEMENTING→PROOF, PREFLIGHT→REVIEW, REVIEW→REVIEW, REPAIR→REPAIR, APPROVED→APPROVED.
 */
function toAuthState(domainState) {
  const map = { DRAFT: 'PLANNING', PLANNED: 'PLANNING', IMPLEMENTING: 'PROOF', PREFLIGHT: 'REVIEW', REVIEW: 'REVIEW', REPAIR: 'REPAIR', APPROVED: 'APPROVED' };
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
        const result = { id: change.id, state: change.state, title: change.title };
        // Expose unresolved findings when in REPAIR or REVIEW state
        if (change.state === 'REPAIR' || change.state === 'REVIEW') {
          try {
            const context = await store.getRepairContext(args.changeId);
            result.unresolvedFindings = context.unresolvedFindings;
            result.repairClaims = context.repairClaims;
            result.originalFindings = context.originalFindings;
            result.proof = context.proof;
            result.revision = context.revision;
            result.preflight = context.preflight;
          } catch {
            // If getRepairContext fails, proceed without repair context
          }
        }
        return result;
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
        let proofObj;
        try {
          proofObj = JSON.parse(args.proof);
        } catch {
          // Preserve the legacy transition-only contract for plain strings; no
          // proof is persisted, so preflight cannot treat arbitrary text as proof.
          await transitionWithStructure(store, args.changeId, 'PREFLIGHT');
          return { success: true };
        }
        if (!proofObj || typeof proofObj !== 'object' || Array.isArray(proofObj)) {
          throw Object.assign(new Error('proof must be a JSON object'), { code: 'INVALID_PROOF' });
        }
        await store.submitProof(args.changeId, proofObj);
        return { success: true };
      },
    }),
    defineTool({
      name: 'change_submit_review',
      description: 'Submit a review for a Change. Requires reviewer role on REVIEW change with matching revision.',
      parameters: { changeId: { type: 'string' }, review: { type: 'object', additionalProperties: true } },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => v },
      execute: async (args, exec) => {
        validateChangeId(args.changeId);
        if (!args.review || typeof args.review !== 'object') {
          throw Object.assign(new Error('review is required and must be an object'), { code: 'INVALID_REVIEW' });
        }
        const { sessionId, role } = await deriveIdentity(args, exec, store);
        const change = await store.get(args.changeId);

        const service = new ChangeService({ role, state: toAuthState(change.state), sessionBound: true });
        try { service.submitReview(); } catch (err) {
          if (err instanceof AuthorizationError) throw Object.assign(new Error(err.message), { code: err.reason });
          throw err;
        }
        // Forward structured review to store
        const result = await store.submitReview(args.changeId, args.review, { sessionId });
        return result;
      },
    }),
    defineTool({
      name: 'change_submit_repair',
      description: 'Submit a repair after review. Requires worker role on REPAIR change with accepted plan.',
      parameters: {
        changeId: { type: 'string' },
        repair: { type: 'object', additionalProperties: true },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => v },
      execute: async (args, exec) => {
        validateChangeId(args.changeId);
        // Reject non-object repair
        if (!args.repair || typeof args.repair !== 'object') {
          throw Object.assign(new Error('repair is required and must be an object'), { code: 'INVALID_REPAIR' });
        }
        const { sessionId, role } = await deriveIdentity(args, exec, store);
        const change = await store.get(args.changeId);
        // V1: Derive planAccepted from persisted store state
        const planAccepted = !!change.acceptedPlanId;
        // For repair tool, we need to check authorization against REPAIR state
        // since the change may have just been transitioned to REPAIR by submitReview
        const service = new ChangeService({ role, state: 'REPAIR', sessionBound: true, planAccepted });
        try { service.submitRepair(); } catch (err) {
          if (err instanceof AuthorizationError) throw Object.assign(new Error(err.message), { code: err.reason });
          throw err;
        }
        // Only allow repair from REPAIR state (transitioned by structured review)
        // REVIEW→REPAIR is owned by change_submit_review, not change_submit_repair
        if (change.state !== 'REPAIR') {
          throw Object.assign(new Error(`Cannot submit repair: change is in ${change.state}, expected REPAIR`), { code: 'INVALID_STATE' });
        }
        // Strip unknown underscore-prefixed keys from repair before passing to store
        const { _legacy, ...cleanRepair } = args.repair;
        const result = await store.submitRepair(args.changeId, cleanRepair, { workerId: sessionId });
        return { success: true, state: result.state };
      },
    }),
  ];
  return tools;
}

export async function registerChangeTools(ctx, config) {
  const storePath = config?.storePath || '.changes.json';
  // Preflight policy honors the established config.policy contract first;
  // the top-level preflightPolicy key is retained for legacy wiring.
  const preflightPolicy = config?.policy?.preflightPolicy ?? config?.preflightPolicy;
  const store = await ChangeStore.open(storePath, { preflightPolicy });
  ctx.provide('changeStore', store);
  const tools = createChangeTools(store);
  const registry = ctx.tools;
  if (!registry?.register) throw new Error('tools.register not available');
  for (const tool of tools) registry.register(tool);
  return store;
}

// ─── Host-side manual Change commands (/change-*) ────────────────────────────
// Registered at the host command boundary (ctx.commands) for human operators.
// They bypass the model-facing tool layer but delegate all persistence,
// transitions, plan lifecycle, bindings, proof, and preflight to the canonical
// ChangeStore methods above. Authorization derives from the invocation
// context (the invoking host agent), never from payload fields.

/** Canonical role vocabulary — mirrors the roles in change-control.js ACTIONS. */
const CANONICAL_ROLES = Object.freeze(['planner', 'worker', 'reviewer']);

function parseCommandArgs(invocation) {
  const raw = invocation?.rawInput;
  let args;
  if (raw == null || raw === '') {
    args = {};
  } else {
    try {
      args = JSON.parse(raw);
    } catch {
      throw Object.assign(new Error('Invalid arguments: expected a JSON object, e.g. {"changeId":"..."}'), { code: 'INVALID_ARGS' });
    }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw Object.assign(new Error('Invalid arguments: expected a JSON object, e.g. {"changeId":"..."}'), { code: 'INVALID_ARGS' });
  }
  return args;
}

/**
 * Derive the host actor from the invocation context. A payload sessionId that
 * disagrees with the invoking identity is impersonation, except for commands
 * declared with `sessionKeyAllowed` where sessionId is the *target* session.
 */
function deriveHostActor(invocation, args, sessionKeyAllowed) {
  const id = invocation?.agent?.id;
  if (typeof id !== 'string' || id.trim() === '') {
    throw new AuthorizationError('IDENTITY_MISSING', 'Host identity must be derived from invocation context');
  }
  if (!sessionKeyAllowed && args.sessionId !== undefined && args.sessionId !== id) {
    throw new AuthorizationError('SESSION_IMPERSONATION', 'Payload sessionId does not match invoking host identity');
  }
  return id;
}

function requireStringArg(args, key) {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw Object.assign(new Error(`${key} is required and must be a non-empty string`), { code: 'INVALID_ARGS' });
  }
  return value;
}

function defineHostCommand(name, description, hint, run, { sessionKeyAllowed = false } = {}) {
  return {
    name,
    description,
    input: { hint: `${hint} (JSON object)` },
    handler: async (invocation) => {
      try {
        const args = parseCommandArgs(invocation);
        const actor = deriveHostActor(invocation, args, sessionKeyAllowed);
        const value = await run(args, actor);
        return { kind: 'success', text: JSON.stringify(value) };
      } catch (err) {
        return { kind: 'error', text: err?.message ?? String(err) };
      }
    },
  };
}

/** Canonical status projection: state, risk, accepted plan, bindings, revision, proof, preflight, open findings. */
async function changeStatusProjection(store, changeId) {
  const change = await store.get(changeId);
  const bindings = (await store.listRoleBindings()).filter((b) => b.changeId === changeId);
  const attempts = await store.listAttempts(changeId);
  const revision = attempts.length > 0 ? attempts[attempts.length - 1].revision ?? null : null;
  const proof = await store.getProof(changeId).catch(() => null);
  const preflight = await store.getPreflight(changeId).catch(() => null);
  const acceptedPlan = change.acceptedPlanId ? await store.getPlan(change.acceptedPlanId).catch(() => null) : null;
  let openFindings = [];
  try {
    // Canonical projection: whatever getRepairContext reports, no command-layer filtering.
    openFindings = (await store.getRepairContext(changeId)).unresolvedFindings;
  } catch { /* no reviews yet */ }
  return {
    id: change.id,
    title: change.title,
    objective: change.objective,
    state: change.state,
    risk: change.risk,
    acceptedPlan,
    bindings,
    revision,
    proof,
    preflight,
    openFindings,
  };
}

/**
 * Register the eight manual Change commands on a host command registry.
 * Returns the registry-supplied disposers so the caller can release them on teardown.
 * @param {{register: (definition: object) => unknown}} registry ctx.commands
 * @param {import('../storage/change-store.js').ChangeStore} store
 */
export function registerChangeCommands(registry, store) {
  if (!registry || typeof registry.register !== 'function') {
    throw new Error('commands.register not available');
  }
  const definitions = [
    defineHostCommand('change-new', 'Create a Change without an LLM', '{"title":"...","objective":"...","acceptanceCriteria":[],"risk":"low|normal|high"}',
      async (args) => {
        if (args.risk !== undefined && !RISK_LEVELS.includes(args.risk)) {
          throw Object.assign(new Error(`Invalid risk: ${args.risk}; expected one of ${RISK_LEVELS.join(', ')}`), { code: 'INVALID_RISK' });
        }
        const change = await store.create({
          title: requireStringArg(args, 'title'),
          objective: requireStringArg(args, 'objective'),
          acceptanceCriteria: Array.isArray(args.acceptanceCriteria) ? args.acceptanceCriteria : [],
        });
        // Effective risk goes through the canonical host risk API so audit,
        // downgrade protection, and gate invalidation all apply.
        return args.risk !== undefined ? store.setRisk(change.id, args.risk) : change;
      }),
    defineHostCommand('change-status', 'Show canonical Change status projection', '{"changeId":"..."}',
      async (args) => changeStatusProjection(store, requireStringArg(args, 'changeId'))),
    defineHostCommand('change-plan', 'Submit a plan revision for a Change', '{"changeId":"...","content":{}}',
      async (args) => {
        if (!args.content || typeof args.content !== 'object' || Array.isArray(args.content)) {
          throw Object.assign(new Error('content is required and must be an object'), { code: 'INVALID_CONTENT' });
        }
        const plan = await store.submitPlan(requireStringArg(args, 'changeId'), args.content);
        return { planId: plan.id, status: plan.status };
      }),
    defineHostCommand('change-approve-plan', 'Accept the current PLANNED plan revision', '{"changeId":"...","planId":"..."}',
      async (args, actor) => store.acceptPlan(requireStringArg(args, 'changeId'), requireStringArg(args, 'planId'), { authorized: true, actor })),
    defineHostCommand('change-bind', 'Bind a session to a role on a Change', '{"changeId":"...","sessionId":"...","role":"planner|worker|reviewer"}',
      async (args) => {
        const role = requireStringArg(args, 'role');
        if (!CANONICAL_ROLES.includes(role)) {
          throw Object.assign(new Error(`Invalid role: ${role}; expected one of ${CANONICAL_ROLES.join(', ')}`), { code: 'INVALID_ROLE' });
        }
        return store.bindRole(requireStringArg(args, 'changeId'), requireStringArg(args, 'sessionId'), role);
      }, { sessionKeyAllowed: true }),
    defineHostCommand('change-unbind', 'Remove a session role binding from a Change', '{"changeId":"...","sessionId":"..."}',
      async (args, actor) => store.unbindRole(requireStringArg(args, 'changeId'), requireStringArg(args, 'sessionId'), { actor }),
      { sessionKeyAllowed: true }),
    defineHostCommand('change-history', 'Show the chronological audit history for a Change', '{"changeId":"..."}',
      async (args) => store.history(requireStringArg(args, 'changeId'))),
    defineHostCommand('change-preflight', 'Run or retry canonical preflight for a Change', '{"changeId":"...","currentRevision":"...","changedFiles":[],"checkResults":[]}',
      async (args) => store.runPreflight(requireStringArg(args, 'changeId'), {
        currentRevision: args.currentRevision,
        changedFiles: args.changedFiles,
        checkResults: args.checkResults,
      })),
  ];
  return definitions.map((definition) => registry.register(definition));
}
