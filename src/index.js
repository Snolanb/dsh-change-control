import { registerChangeTools } from './tools/change-tools.js';

const name = 'dsh-change-control';

/**
 * @param {any} ctx
 * @param {unknown} config
 */
function apply(ctx, config) {
  ctx.effect(() => {
    registerChangeTools(ctx);
    return () => {
      // Cleanup logic - releases all owned resources
    };
  });
}

export { name, apply };
