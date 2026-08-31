// @ts-nocheck
import { registerChangeTools } from './tools/change-tools.js';
import { createFilesystemPolicy } from './tools/filesystem-policy.js';

const name = 'dsh-change-control';

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
