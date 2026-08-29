import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Context } from '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js';
import { name, apply } from '../src/index.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('loads a valid profile and registers exactly one initialization hook', async () => {
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
  const ctx = new Context();
  const plugin = { name, apply };
  const fiber = await ctx.plugin(plugin);
  assert.equal(fiber.state, 2 /* ACTIVE */);
  // dispose runs effect cleanup; must not throw and must not leave handles
  assert.doesNotThrow(async () => await fiber.dispose());
});

test('does not depend on an orchestration plugin', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const dependencies = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
  assert.equal(Object.hasOwn(dependencies, 'orchestration-plugin'), false);
});

test('package smoke test is runnable through the declared test command', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.scripts?.test, 'node --test test/*.test.mjs');
});
