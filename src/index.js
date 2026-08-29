const name = 'dsh-change-control';

/**
 * @param {any} ctx
 * @param {unknown} config
 */
function apply(ctx, config) {
  ctx.effect(() => {
    // Initialization logic runs exactly once per context
    return () => {
      // Cleanup logic - releases all owned resources
    };
  });
}

export { name, apply };
