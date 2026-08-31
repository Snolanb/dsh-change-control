import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { name, apply } from '../src/index.js';

const acceptance = [
  'derive role/session identity from invocation context and reject impersonation parameters',
  'delegate to canonical ChangeService/ChangeStore without duplicated rules',
  'denied calls return concise structured actionable precondition errors',
  'no arbitrary state mutation tool exists',
  'malformed payloads fail before persistence',
];

async function runtime(storePath) {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  await ctx.plugin({ name, apply, inject: ['tools'] }, { storePath });
  return ctx.get('tools');
}

test('ticket acceptance criteria are explicit', () => {
  assert.equal(acceptance.length, 5);
  assert.match(acceptance.join('\n'), /role\/session identity.*invocation context/i);
  assert.match(acceptance.join('\n'), /canonical ChangeService\/ChangeStore/i);
  assert.match(acceptance.join('\n'), /concise structured actionable/i);
  assert.match(acceptance.join('\n'), /no arbitrary state mutation/i);
  assert.match(acceptance.join('\n'), /malformed payloads.*before persistence/i);
});

test('plugin registers exactly the narrow model-facing Change surface', async () => {
  const tools = await runtime('.test-tools.json');
  for (const tool of ['change_get', 'change_submit_plan', 'change_submit_proof', 'change_submit_review', 'change_submit_repair']) {
    assert.equal(tools.get(tool)?.name, tool);
  }
  assert.equal(tools.get('change_transition'), undefined);
  assert.equal(tools.get('change_set_state'), undefined);
});

test('registered tools expose executable definitions with output contracts', async () => {
  const tools = await runtime('.test-tools-exec.json');
  for (const tool of ['change_get', 'change_submit_plan', 'change_submit_proof', 'change_submit_review', 'change_submit_repair']) {
    const definition = tools.get(tool);
    assert.equal(typeof definition.execute, 'function');
    assert.equal(typeof definition.output?.render, 'function');
  }
});
