import { Context } from '@deepseek-ai/cordis';
import type { Fiber } from '@deepseek-ai/cordis';

export const name = 'dsh-change-control';

export function apply(ctx: Context): void {
  ctx.effect(() => {
    // Initialization logic runs exactly once per context
    return () => {
      // Cleanup logic - releases all owned resources
    };
  });
}
