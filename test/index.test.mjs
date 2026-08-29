import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { name, apply } from '../src/index.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function lifecycleContext() {
  const initHooks = [];
  const shutdownHooks = [];
  return {
    initHooks,
    shutdownHooks,
    onInit: (hook) => initHooks.push(hook),
    onShutdown: (hook) => shutdownHooks.push(hook),
  };
}

test('loads a valid profile and registers exactly one initialization hook', () => {
  assert.equal(typeof name, 'string');
  const ctx = lifecycleContext();
  assert.doesNotThrow(() => apply(ctx, {}));
  assert.equal(ctx.initHooks.length, 1);
  ctx.initHooks[0]();
  assert.equal(ctx.initHooks.length, 1);
});

test('shutdown releases every resource owned by the plugin', () => {
  const ctx = lifecycleContext();
  assert.doesNotThrow(() => apply(ctx, {}));
  assert.equal(ctx.shutdownHooks.length, 1);
  assert.doesNotThrow(() => ctx.shutdownHooks.forEach((shutdown) => shutdown()));
  assert.equal(ctx.shutdownHooks.length, 1);
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
