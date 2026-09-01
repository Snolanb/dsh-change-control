// @ts-nocheck
import { registerChangeTools } from './tools/change-tools.js';
import { createFilesystemPolicy } from './tools/filesystem-policy.js';
import { RISK_LEVELS } from './domain/change.js';

const name = 'dsh-change-control';

/**
 * Validate and normalize the host-owned riskProfiles configuration.
 * Canonical keys are the lowercase risk levels; each level declares its
 * requiredChecks as an array of strings or {name, control?} objects.
 * Malformed configuration fails fast at wiring time.
 */
function validateRiskProfiles(policy) {
  const profiles = policy?.riskProfiles;
  if (profiles == null) return;
  if (typeof profiles !== 'object' || Array.isArray(profiles)) {
    throw new Error('policy.riskProfiles must be an object keyed by low/normal/high');
  }
  const normalized = {};
  for (const [key, profile] of Object.entries(profiles)) {
    const level = key.toLowerCase();
    if (!RISK_LEVELS.includes(level)) {
      throw new Error(`policy.riskProfiles has unknown risk level key: ${key}`);
    }
    if (profile == null || typeof profile !== 'object' || !Array.isArray(profile.requiredChecks)) {
      throw new Error(`policy.riskProfiles.${key} must declare a requiredChecks array (use [] for an explicit empty set)`);
    }
    for (const entry of profile.requiredChecks) {
      const ok = typeof entry === 'string'
        || (entry && typeof entry === 'object' && typeof entry.name === 'string');
      if (!ok) {
        throw new Error(`policy.riskProfiles.${key}.requiredChecks entries must be strings or {name, control?} objects`);
      }
    }
    normalized[level] = { ...profile, requiredChecks: [...profile.requiredChecks] };
  }
  policy.riskProfiles = normalized;
}

/**
 * @param {any} ctx
 * @param {unknown} config
 */
async function apply(ctx, config) {
  // Guard: tools registry must be available — fail fast, never silently fall back.
  let tools;
  try { tools = ctx.tools; } catch { tools = null; }
  if (!tools || typeof tools.register !== 'function') {
    throw new Error(
      'dsh-change-control requires a host that provides ctx.tools.register ' +
      '(from @deepseek-ai/dsh-tools). Ensure Cordis ToolRuntime is active before loading this plugin.'
    );
  }

  // Validate host-owned risk profile configuration before wiring anything.
  if (config && typeof config === 'object' && config.policy) {
    validateRiskProfiles(config.policy);
  }

  // Initialize ChangeStore from config and register the narrow model-facing Change tools
  const store = await registerChangeTools(ctx, config);

  // Wire up the filesystem/tool policy pre-execute interceptor.
  // The policy reads the store's role bindings and change states to gate
  // tool execution at the real DSH interception boundary.
  const policyGate = createFilesystemPolicy(store, config);
  if (policyGate) {
    ctx.events.on('tools/pre-execute', policyGate);
  }

  ctx.effect(() => {
    // Initialization logic runs exactly once per context
    return () => {
      // Cleanup logic - releases all owned resources
    };
  });
}

export { name, apply };

/** @type {object} Plugin descriptor with injection requirements. */
const plugin = { name, apply, inject: ['tools'] };
export default plugin;
