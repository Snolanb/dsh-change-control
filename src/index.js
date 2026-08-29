const name = 'dsh-change-control';

function apply(ctx, config) {
  ctx.onInit(() => {
    // Initialization logic runs exactly once per context
  });

  ctx.onShutdown(() => {
    // Cleanup logic - releases all owned resources
  });
}

export { name, apply };
