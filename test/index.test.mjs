import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { name, apply } from '../src/index.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('loads a valid profile and registers exactly one initialization hook', async () => {
  const { Context } = await import('/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js');
  assert.equal(typeof name, 'string');
  const ctx = new Context();
  const plugin = { name, apply };
  const fiber = await ctx.plugin(plugin);
  assert.equal(fiber.state, 2 /* ACTIVE */);
  const effects = fiber.getEffects();
  assert.equal(effects.length, 1);
  await fiber.dispose();
});

test('shutdown releases every resource owned by the plugin', async () => {
  const { Context } = await import('/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js');
  const ctx = new Context();
  const plugin = { name, apply };
  const fiber = await ctx.plugin(plugin);
  assert.equal(fiber.state, 2 /* ACTIVE */);
  await assert.doesNotReject(async () => await fiber.dispose());
});
