// @ts-nocheck
/**
 * Deterministic filesystem and tool policy enforcement.
 *
 * Intercepts tool execution at the pre-execute boundary to enforce:
 * - planner/reviewer roles: read-only (all non-change-tool calls denied)
 * - worker role: mutations allowed only in IMPLEMENTING or REPAIR state
 * - unbound sessions: no restriction (backward compatible)
 * - denied actions: audited without raw sensitive arguments or tool content
 */

const CHANGE_TOOL_NAMES = new Set([
  'change_get',
  'change_submit_plan',
  'change_submit_proof',
  'change_submit_review',
  'change_submit_repair',
]);

/**
 * Resolve the binding for a specific session on a specific change.
 * Returns { changeId, role, state } or null if not bound to that change.
 * Throws on storage errors (fail-closed).
 */
async function resolveBinding(store, sessionId, changeId) {
  // Fail-closed: do not swallow storage errors into "unbound" allowance.
  const bindings = await store.listRoleBindings();
  const binding = bindings.find((b) => b.sessionId === sessionId && b.changeId === changeId);
  if (!binding) return null;
  const change = await store.get(binding.changeId);
  return { changeId: binding.changeId, role: binding.role, state: change.state };
}

/**
 * Create a pre-execute policy interceptor suitable for the
 * "tools/pre-execute" waterfall on ctx.events.
 * Returns null when policy is not configured or explicitly disabled.
 */
export function createFilesystemPolicy(store, config) {
  const policyConfig = config?.policy;
  // Explicitly disabled: no interception.
  if (policyConfig?.enabled === false) return null;
  // Not configured at all: preserve backward-compatible unrestricted behavior.
  if (policyConfig == null) return null;

  /**
   * Pre-execute interceptor. Called by the ToolRuntime for every tool call.
   * Signature: (exec, next) => { kind: 'allow' } | { kind: 'deny', reason } | next()
   */
  async function policyGate(exec, next) {
    const agentId = exec?.agent?.id;
    if (!agentId) return next();

    // Determine target change from tool arguments when available.
    const requestedChangeId = exec?.arguments?.changeId ?? null;

    let binding;
    try {
      binding = await resolveBinding(store, agentId, requestedChangeId);
    } catch {
      // Fail-closed: storage errors deny the action, never fall through to unbound.
      return { kind: 'deny', reason: 'Policy evaluation failed: binding lookup error' };
    }

    // If the caller specified a changeId but has no binding for it, deny.
    if (requestedChangeId && !binding) {
      return { kind: 'deny', reason: `Session ${agentId} is not bound to change ${requestedChangeId}` };
    }

    // If no changeId was specified, the session must have exactly one binding
    // to avoid authorizing based on an unrelated Change.
    if (!requestedChangeId) {
      try {
        const allBindings = await store.listRoleBindings();
        const sessionBindings = allBindings.filter((b) => b.sessionId === agentId);
        if (sessionBindings.length > 1) {
          return { kind: 'deny', reason: `Ambiguous policy context: session ${agentId} is bound to multiple changes; tool must specify changeId` };
        }
        if (sessionBindings.length === 0) {
          // Truly unbound — allow (backward compatible).
          return next();
        }
        // Single binding: use it.
        const singleBinding = sessionBindings[0];
        binding = await resolveBinding(store, agentId, singleBinding.changeId);
      } catch {
        return { kind: 'deny', reason: 'Policy evaluation failed: binding lookup error' };
      }
    }

    if (!binding) return next();

    const { changeId, role, state } = binding;

    // Allow change-control tools through — they have their own authorization layer.
    if (CHANGE_TOOL_NAMES.has(exec.name)) return next();

    // Apply role-based restrictions at the pre-execution boundary.
    if (role === 'planner' || role === 'reviewer') {
      await auditDenial(store, changeId, exec, agentId, role, state, 'ROLE_READ_ONLY');
      return { kind: 'deny', reason: `${role} role is read-only; ${exec.name} is denied` };
    }

    if (role === 'worker') {
      if (state !== 'IMPLEMENTING' && state !== 'REPAIR') {
        await auditDenial(store, changeId, exec, agentId, role, state, 'STATE_NOT_ALLOWED');
        return { kind: 'deny', reason: `Worker is not authorized in ${state} state; only IMPLEMENTING or REPAIR allowed` };
      }
    }

    return next();
  }

  return policyGate;
}

/**
 * Audit a denied action. Records a DENIAL event with metadata only —
 * no raw sensitive arguments or tool content is included.
 */
async function auditDenial(store, changeId, exec, sessionId, role, state, reasonCode) {
  try {
    await store.appendAudit({
      eventId: Date.now() + Math.random(),
      changeId,
      type: 'DENIAL',
      role,
      state,
      toolName: exec.name,
      sessionId,
      reason: reasonCode,
      ts: new Date().toISOString(),
    });
  } catch {
    // Non-fatal: audit failures must not break tool execution flow
  }
}
