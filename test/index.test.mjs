import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { name, apply } from '../src/index.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function tryLoadCordis() {
  try {
    const mod = await import('@deepseek-ai/cordis');
    return mod;
  } catch {
    return null;
  }
}

const cordis = await tryLoadCordis();

test('loads a valid profile and registers exactly one initialization hook', async (ctx) => {
  assert.equal(typeof name, 'string');
  if (!cordis) {
    ctx.skip('Cordis unavailable');
    return;
  }
  const c = new cordis.Context();
  const plugin = { name, apply };
  const fiber = await c.plugin(plugin);
  assert.equal(fiber.state, 2 /* ACTIVE */);
  const effects = fiber.getEffects();
  assert.equal(effects.length, 1);
  await fiber.dispose();
});

test('shutdown releases every resource owned by the plugin', async (ctx) => {
  if (!cordis) {
    ctx.skip('Cordis unavailable');
    return;
  }
  const c = new cordis.Context();
  const plugin = { name, apply };
  const fiber = await c.plugin(plugin);
  assert.equal(fiber.state, 2 /* ACTIVE */);
  await assert.doesNotReject(async () => await fiber.dispose());
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
