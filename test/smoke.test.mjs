import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

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
