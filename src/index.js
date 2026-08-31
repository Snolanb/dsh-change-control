import { registerChangeTools } from './tools/change-tools.js';
import { ChangeService } from './change-control.js';
import { ChangeStore } from './storage/change-store.js';

const name = 'dsh-change-control';

/** @type {ChangeStore|null} */
let persistentStore = null;
/** @type {ChangeService|null} */
let persistentService = null;

/**
 * Initialize or get the persistent ChangeStore.
 * @param {string} [path]
 * @returns {Promise<ChangeStore>}
 */
async function getStore(path) {
  if (!persistentStore) {
    persistentStore = await ChangeStore.open(path || './changes.json');
  }
  return persistentStore;
}

/**
 * @param {any} ctx
 * @param {{storePath?: string, role?: string, state?: string}} config
 */
async function apply(ctx, config) {
  const store = await getStore(config?.storePath);
  const service = new ChangeService({
    role: config?.role || 'planner',
    state: config?.state || 'PLANNING',
    store: store,
  });
  persistentService = service;
  ctx.effect(() => {
    // Guard: tools registry must be available — fail fast, never silently fall back.
    let tools;
    try { tools = ctx.tools; } catch { tools = null; }
    if (!tools || typeof tools.register !== 'function') {
      throw new Error(
        'dsh-change-control requires a host that provides ctx.tools.register ' +
        '(from @deepseek-ai/dsh-tools). Ensure Cordis ToolRuntime is active before loading this plugin.'
      );
    }
    registerChangeTools({ tools, changeService: service, changeStore: store });
    return () => {
      // Cleanup logic - releases all owned resources
    };
  });
}

export { name, apply, getStore, ChangeService, ChangeStore };

/** @type {object} Plugin descriptor with injection requirements. */
const plugin = { name, apply, inject: ['tools'] };
export default plugin;
