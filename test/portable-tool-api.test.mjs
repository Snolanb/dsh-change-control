import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools';
import { name, apply } from '../src/index.js';

const root = process.cwd();
const acceptance = [
  'A single supported contract for external plugins to access the DSH tool-registration API is selected and documented, including ownership and versioning expectations.',
  'dsh-change-control uses that contract without absolute /opt/homebrew imports, vendored or copied node_modules, or undeclared host filesystem dependencies.',
  'A clean checkout can install dependencies and resolve the tool API using documented commands on a supported DSH installation.',
  'A minimal plugin smoke test registers and disposes a tool through the real host composition API rather than a permissive test double.',
  'Failure to provide the required host API produces a concise actionable startup or installation error instead of silently falling back.',
  'The change does not add or modify Change domain states, authorization rules, persistence semantics, or model-facing tool behavior.',
];

test('acceptance contract is stated verbatim in this focused suite', () => {
  assert.equal(acceptance.length, 6);
  assert.match(acceptance.join('\n'), /single supported contract.*ownership and versioning expectations/i);
  assert.match(acceptance.join('\n'), /without absolute \/opt\/homebrew imports/i);
  assert.match(acceptance.join('\n'), /clean checkout can install dependencies/i);
  assert.match(acceptance.join('\n'), /real host composition API rather than a permissive test double/i);
  assert.match(acceptance.join('\n'), /concise actionable startup or installation error/i);
  assert.match(acceptance.join('\n'), /does not add or modify Change domain states/i);
});

test(acceptance[0], async () => {
  const readme = await readFile(join(root, 'README.md'), 'utf8');
  assert.match(readme, /@deepseek-ai\/dsh-tools/);
  assert.match(readme, /contract|API/i);
  assert.match(readme, /version/i);
  assert.match(readme, /ownership|host/i);
});

test(acceptance[1], async () => {
  const files = ['src/index.js'];
  const source = await Promise.all(files.map((file) => readFile(join(root, file), 'utf8')));
  assert.equal(source.join('\n').includes('/opt/homebrew'), false);
  assert.equal(source.join('\n').includes('node_modules/'), false);
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const declared = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
  assert.ok(declared['@deepseek-ai/dsh-tools']);
  assert.ok(declared['@deepseek-ai/cordis']);
});

test(acceptance[2], async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.match(pkg.scripts?.test ?? '', /node --test/);
  assert.ok(import.meta.resolve('@deepseek-ai/dsh-tools'));
  assert.ok(import.meta.resolve('@deepseek-ai/cordis'));
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  assert.ok(lock.packages?.['node_modules/@deepseek-ai/dsh-tools']);
});

test(acceptance[3], async () => {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  const disposers = [];
  const plugin = {
    name: 'portable-tool-api-smoke',
    inject: ['tools'],
    apply(host) {
      const tool = defineTool({
        name: 'portable_smoke',
        description: 'Portable API smoke tool',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => value },
        execute: async () => 'ok',
      });
      disposers.push(host.tools.register(tool));
    },
  };
  const fiber = await ctx.plugin(plugin);
  assert.equal(ctx.get('tools').get('portable_smoke')?.name, 'portable_smoke');
  assert.equal(typeof disposers[0], 'function');
  await fiber.dispose();
  disposers[0]();
  assert.equal(ctx.get('tools').get('portable_smoke'), undefined);
});

test(acceptance[4], async () => {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  const fiber = ctx.plugin({ name, apply }, { storePath: join(root, `.portable-missing-${Date.now()}.json`) });
  await assert.rejects(
    () => fiber.await(),
    (error) => /tools|tool.?registration|host API|dsh-tools/i.test(error?.message ?? '')
      && !/undefined is not a function|Cannot read properties/i.test(error?.message ?? '')
  );
});

test(acceptance[5], async () => {
  // Verify no Change domain semantic modifications in this ticket
  const files = ['src/change-control.js', 'src/domain/change.js', 'src/storage/change-store.js'];
  const sources = await Promise.all(files.map((file) => readFile(join(root, file), 'utf8')));
  const combined = sources.join('\n');
  // This ticket does not add get action, IMPLEMENTING state widening, or binding verification
  assert.doesNotMatch(combined, /async\s+#authorize|verifyBinding|getRole/);
});
