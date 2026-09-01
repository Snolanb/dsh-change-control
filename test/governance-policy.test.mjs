import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFilesystemPolicy } from '../src/tools/filesystem-policy.js';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools';
import { name, apply } from '../src/index.js';
import { ChangeStore } from '../src/storage/change-store.js';

async function fixture(t, policy = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-governance-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const audits = [];
  const store = {
    async listRoleBindings() { return [{ changeId: 'change-1', sessionId: 'worker-1', role: 'worker' }]; },
    async get() { return { id: 'change-1', state: 'IMPLEMENTING', risk: 'normal' }; },
    async appendAudit(event) { audits.push(event); },
  };
  const config = { policy: { enabled: true, projectId: 'project-1', owner: 'host', workspaceRoots: [root], ...policy } };
  const gate = createFilesystemPolicy(store, config);
  const execute = (name, arguments_ = {}) => gate({ name, arguments: { projectId: 'project-1', ...arguments_ }, agent: { id: 'worker-1' } }, () => ({ kind: 'allow' }));
  return { root: resolve(root), audits, execute, config };
}

/** ToolRuntime-driven fixture: governed policy at the real pre-execute boundary. */
async function rtFixture(t, policy = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-governance-rt-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'changes.json');
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  const storePath = file;
  await ctx.plugin({ name, apply, inject: ['tools'] }, { storePath, policy: { enabled: true, projectId: 'project-1', owner: 'host', workspaceRoots: [dir], ...policy } });
  const registry = ctx.get('tools');
  const store = ctx.get('changeStore');
  registry.register(defineTool({
    name: 'filesystem_write',
    description: 'test write',
    parameters: { path: { type: 'string' }, content: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => v },
    execute: async () => ({ written: true }),
  }));
  const call = (tool, args, sessionId = 's1') => registry.execute({
    callId: `${tool}-${Math.random()}`, name: tool, arguments: args,
    agent: { id: sessionId }, signal: new AbortController().signal,
  });
  return { dir, file, store, call };
}

// AC1: the host-owned policy is selected by governed project, not repository content.
test('resolves governance policy by project and requires host ownership', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.execute('filesystem_write', { path: join(f.root, 'ok.txt') }), { kind: 'allow' });
  const wrongProject = await f.execute('filesystem_write', { projectId: 'other-project', path: join(f.root, 'wrong.txt') });
  assert.equal(wrongProject.kind, 'deny');
});

// AC2 and AC6: repository input cannot remove or weaken authoritative checks.
test('repository policy cannot remove required checks or weaken host protections', async (t) => {
  const f = await fixture(t, { requiredChecks: ['tests', 'review'], repositoryPolicy: { requiredChecks: [] }, repositoryPolicySource: 'repo/.dsh-policy.json' });
  const result = await f.execute('change_submit_plan', { requiredChecks: [], repositoryPolicy: { requiredChecks: [] } });
  assert.notEqual(result.kind, 'allow', 'repository content must not remove host-required checks');
});

// AC3: all mutations must stay under configured workspace roots.
test('denies mutations outside permitted workspace roots', async (t) => {
  const f = await fixture(t);
  const denied = await f.execute('filesystem_write', { path: '/tmp/outside-governance-root.txt', content: 'x' });
  assert.equal(denied.kind, 'deny');
});

// AC4: protected paths honor configured deny/escalate policy.
test('applies configured protected-path deny policy', async (t) => {
  const f = await fixture(t, { protectedPaths: ['src/secret.js'], protectedPathPolicy: 'deny' });
  const denied = await f.execute('filesystem_write', { path: join(f.root, 'src/secret.js'), content: 'x' });
  assert.equal(denied.kind, 'deny');
});

test('applies configured protected-path escalate policy as host ask', async (t) => {
  const f = await fixture(t, { protectedPaths: ['src/secret.js'], protectedPathPolicy: 'escalate' });
  const escalated = await f.execute('filesystem_write', { path: join(f.root, 'src/secret.js'), content: 'x' });
  assert.equal(escalated.kind, 'ask');
  assert.match(escalated.reason, /escalation/);
  // Internal code is kept for auditing.
  assert.ok(f.audits.some((event) => event.type === 'ESCALATION' && event.reason === 'PROTECTED_PATH'));
});

// AC5: policy versions are attached to execution audit records and remain identifiable.
test('records governing policy version for auditable decisions', async (t) => {
  const f = await fixture(t, { version: '2025-01-01', policyVersion: 'v3' });
  await f.execute('filesystem_write', { path: '/tmp/outside-governance-root.txt', content: 'x' });
  assert.ok(f.audits.some((event) => event.policyVersion === 'v3' || event.policyVersion === '2025-01-01'));
});

// ─── Repair round 2 hardening ───────────────────────────────────────────────

// Escalate is an 'ask' at the host boundary and distinguishable from deny.
test('escalate surfaces as ask and stays distinguishable from deny through ToolRuntime', async (t) => {
  const deniedResult = await rtFixture(t, { protectedPaths: ['secret.js'], protectedPathPolicy: 'deny' });
  const askResult = await rtFixture(t, { protectedPaths: ['secret.js'], protectedPathPolicy: 'escalate' });

  const denied = await deniedResult.call('filesystem_write', { path: join(deniedResult.dir, 'secret.js'), content: 'x' }, 'unbound');
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /Protected path is denied/);

  const asked = await askResult.call('filesystem_write', { path: join(askResult.dir, 'secret.js'), content: 'x' }, 'unbound');
  assert.equal(asked.isError, true);
  // The ask decision surfaces with the escalation reason ({kind:'ask'} → host
  // approval channel; with no approval service it denies carrying that reason).
  assert.match(asked.content[0].text, /requires human escalation/);
  assert.doesNotMatch(asked.content[0].text, /Protected path is denied/);
});

// Every path-bearing argument form is constrained; command-only tools fail closed.
test('extracts path, file_path, and path lists; command-only tools are denied', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.execute('filesystem_write', { file_path: '/tmp/outside1.txt' })).code, 'OUTSIDE_WORKSPACE_ROOTS');
  assert.equal((await f.execute('filesystem_multi', { paths: [join(f.root, 'ok.txt'), '/tmp/outside2.txt'] })).code, 'OUTSIDE_WORKSPACE_ROOTS');
  assert.equal((await f.execute('filesystem_multi', { files: ['/tmp/outside3.txt'] })).code, 'OUTSIDE_WORKSPACE_ROOTS');
  const commandOnly = await f.execute('bash', { command: 'echo hi' });
  assert.equal(commandOnly.kind, 'deny');
  assert.equal(commandOnly.code, 'COMMAND_NOT_CONSTRAINABLE');
  // All-in-root multi-path is allowed.
  assert.deepEqual(await f.execute('filesystem_multi', { paths: [join(f.root, 'a.txt'), join(f.root, 'b.txt')] }), { kind: 'allow' });
});

// Governed project is host-owned; absent projectId is fine, conflicting is not;
// change tools keep working end-to-end through ToolRuntime under governance.
test('governed project is host-driven and change tools still work end-to-end', async (t) => {
  const f = await fixture(t);
  const noProject = await f.execute('filesystem_write', { path: join(f.root, 'ok.txt'), projectId: undefined });
  assert.deepEqual(noProject, { kind: 'allow' });

  const rt = await rtFixture(t);
  const change = await rt.store.create({ title: 'g', objective: 'o', acceptanceCriteria: ['a'], risk: 'normal' });
  await rt.store.bindRole(change.id, 'planner', 'planner');
  const got = await rt.call('change_get', { changeId: change.id }, 'planner');
  assert.equal(got.isError, false);
  const planned = await rt.call('change_submit_plan', { changeId: change.id, content: { steps: ['x'] } }, 'planner');
  assert.equal(planned.isError, false);
});

// Governance audit events get store-assigned integer ids, strictly increasing.
test('governance audit eventIds are integers, strictly increasing, and durable across reopen', async (t) => {
  const f = await rtFixture(t);
  await f.call('filesystem_write', { path: '/tmp/outside-governance.txt', content: 'x' }, 'unbound');
  const reopened = await ChangeStore.open(f.file);
  await reopened.appendAudit({ type: 'PING' });
  const data = JSON.parse(await readFile(f.file, 'utf8'));
  for (const event of data.audit) {
    assert.ok(Number.isInteger(event.eventId), `eventId must be an integer: ${JSON.stringify(event.eventId)}`);
  }
  for (let i = 1; i < data.audit.length; i += 1) {
    assert.ok(data.audit[i].eventId > data.audit[i - 1].eventId, 'audit eventIds must be strictly increasing');
  }
});

// Required-check weakening attempts are caught wherever they hide, normalized
// against the authoritative host list in both entry forms.
test('nested and alternate-key required-check weakening is denied; name forms normalized', async (t) => {
  const objectHost = await fixture(t, { requiredChecks: [{ name: 'tests', command: 'npm test' }, { name: 'review' }] });
  assert.equal((await objectHost.execute('change_submit_plan', { content: { config: { requiredChecks: [] } } })).code, 'REQUIRED_CHECKS_REMOVED');
  assert.equal((await objectHost.execute('change_submit_plan', { required_checks: [{ name: 'tests' }] })).code, 'REQUIRED_CHECKS_REMOVED');
  assert.deepEqual(await objectHost.execute('change_submit_plan', { requiredChecks: ['tests', 'review'] }), { kind: 'allow' });

  const stringHost = await fixture(t, { requiredChecks: ['tests', 'review'] });
  assert.deepEqual(await stringHost.execute('change_submit_plan', { requiredChecks: [{ name: 'tests' }, { name: 'review' }] }), { kind: 'allow' });
  const denied = await stringHost.execute('change_submit_plan', { requiredChecks: [{ name: 'tests' }] });
  assert.equal(denied.kind, 'deny');
  assert.match(denied.reason, /review/);
});

// Allowed governed executions and reviews carry the governing policy version;
// version transitions are audited.
test('allowed governed executions carry policyVersion and version transitions are audited', async (t) => {
  const f = await fixture(t, { policyVersion: 'v1' });
  await f.execute('filesystem_write', { path: join(f.root, 'ok.txt') });
  assert.ok(f.audits.some((event) => event.type === 'GOVERNANCE_ALLOW' && event.policyVersion === 'v1'));
  f.config.policy.policyVersion = 'v2';
  await f.execute('filesystem_write', { path: join(f.root, 'ok2.txt') });
  assert.ok(f.audits.some((event) => event.type === 'POLICY_VERSION' && event.from === 'v1' && event.to === 'v2'));
  assert.ok(f.audits.some((event) => event.type === 'GOVERNANCE_ALLOW' && event.policyVersion === 'v2'));
});

// Fail closed: a governed policy without explicit host ownership denies.
test('governed policy without host owner is denied', async (t) => {
  const f = await fixture(t, { owner: undefined });
  delete f.config.policy.owner;
  const denied = await f.execute('filesystem_write', { path: join(f.root, 'ok.txt') });
  assert.equal(denied.kind, 'deny');
  assert.equal(denied.code, 'OWNER_NOT_HOST');
});

// Symlink escapes are denied; protected entries protect their whole subtree.
test('symlink escapes are denied and protected entries protect children', async (t) => {
  const outside = await mkdtemp(join(tmpdir(), 'dsh-governance-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const f = await fixture(t, { protectedPaths: ['src'] });
  await symlink(outside, join(f.root, 'escape'), 'dir');
  const escaped = await f.execute('filesystem_write', { path: join(f.root, 'escape', 'x.txt') });
  assert.equal(escaped.kind, 'deny');
  assert.equal(escaped.code, 'OUTSIDE_WORKSPACE_ROOTS');
  const child = await f.execute('filesystem_write', { path: join(f.root, 'src', 'deep', 'file.js') });
  assert.equal(child.kind, 'deny');
  assert.equal(child.code, 'PROTECTED_PATH');
});

// Case-insensitive filesystems fold case when matching protected entries.
const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';
test('protected-path matching folds case on case-insensitive platforms', { skip: !CASE_INSENSITIVE }, async (t) => {
  const f = await fixture(t, { protectedPaths: ['src/secret.js'] });
  const denied = await f.execute('filesystem_write', { path: join(f.root, 'SRC', 'SECRET.JS') });
  assert.equal(denied.kind, 'deny');
  assert.equal(denied.code, 'PROTECTED_PATH');
});

// Protected entries work without workspace roots: absolute + relative-suffix matching.
test('protected entries match without workspace roots', async (t) => {
  const absolute = await fixture(t, { workspaceRoots: [], protectedPaths: ['/etc/dsh-protected-marker'] });
  assert.equal((await absolute.execute('filesystem_write', { path: '/etc/dsh-protected-marker' })).code, 'PROTECTED_PATH');
  const relative = await fixture(t, { workspaceRoots: [], protectedPaths: ['config/secrets.json'] });
  assert.equal((await relative.execute('filesystem_write', { path: '/tmp/anywhere/config/secrets.json' })).code, 'PROTECTED_PATH');
  assert.deepEqual(await relative.execute('filesystem_write', { path: '/tmp/anywhere/config/plain.json' }), { kind: 'allow' });
});
