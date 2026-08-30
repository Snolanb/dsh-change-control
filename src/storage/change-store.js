/**
 * Minimal file-backed JSON store for durable Change persistence + append-only audit.
 * ponytail: module-level writeLock keyed by canonical (absolute) file path coordinates
 * writers across instances; unique tmp paths prevent overlapping atomic writes from
 * unlinking each other's temp file. Each transition refreshes the target change from
 * disk before validating/mutating, so stale in-memory state is reconciled and rejected
 * transitions don't append events.
 */
// @ts-nocheck
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createChange, ChangeDomainError, TRANSITIONS } from '../domain/change.js';

const writeLocks = new Map();
/** Monotonic counter for collision-free event IDs. Seeded from disk on load. */
let eventIdSeq = 0;

/** Canonicalize file path to absolute form for consistent lock/key identity. */
function canonicalPath(file) {
  return resolve(file);
}

function acquireLock(file) {
  const key = canonicalPath(file);
  if (!writeLocks.has(key)) {
    writeLocks.set(key, { queue: [], active: null });
  }
  const lock = writeLocks.get(key);
  return new Promise((resolve) => {
    lock.queue.push(resolve);
    if (!lock.active) rotate(key);
  });
}

function rotate(key) {
  const lock = writeLocks.get(key);
  const next = lock.queue.shift();
  if (!next) { lock.active = null; return; }
  lock.active = next;
  next(() => { rotate(key); });
}

function readJson(file) {
  return readFile(file, 'utf8').then((s) => (s.trim() ? JSON.parse(s) : null));
}

function writeJson(file, data) {
  const tmp = file + '.tmp.' + Date.now() + '.' + Math.random().toString(36).slice(2);
  return writeFile(tmp, JSON.stringify(data), 'utf8')
    .then(() => rename(tmp, file))
    .catch((err) => {
      unlink(tmp).catch(() => {});
      throw err;
    });
}

/**
 * Generate a collision-free event ID, seeded from disk on load so restarts
 * don't produce IDs that collide with already-persisted events.
 */
function nextEventId() {
  return ++eventIdSeq;
}

/**
 * Reseed the event ID counter from freshly read durable disk state.
 * Must be called under the per-file write lock, right before assigning an eventId.
 */
async function reseedFromDisk(file) {
  let data;
  try {
    data = await readJson(file);
  } catch {
    return;
  }
  if (data && Array.isArray(data.audit) && data.audit.length > 0) {
    const maxId = Math.max(...data.audit.map((e) => e.eventId ?? 0));
    if (maxId > eventIdSeq) eventIdSeq = maxId;
  }
}

function rehydrate(serialized, events) {
  const c = createChange({
    title: serialized.title,
    objective: serialized.objective,
    acceptanceCriteria: serialized.acceptanceCriteria,
    risk: serialized.risk,
  });
  c.id = serialized.id;
  c.createdAt = serialized.createdAt;
  c.acceptedPlanId = serialized.acceptedPlanId;
  // If the serialized record carries an explicit domain state, use it directly
  // and skip audit replay. This avoids gaps caused by plan-lifecycle events
  // (DRAFT→PLANNED, PLANNED→READY, READY→PLANNED) that carry planId and are
  // not legal domain transitions from the domain's perspective.
  if (serialized.domainState) {
    c._setDomainState(serialized.domainState);
    if (serialized.planState) {
      c._setPlanState(serialized.planState);
    }
    const last = events[events.length - 1];
    if (last) c.updatedAt = last.ts;
    return c;
  }

  // Normal path: replay only pure domain transitions (no planId).
  for (const e of events) {
    if (e.planId != null) continue;
    if (e.from !== null) c.transitionTo(e.to);
  }
  // Apply plan-lifecycle state override.
  if (serialized.planState) {
    c._setPlanState(serialized.planState);
  }
  const last = events[events.length - 1];
  if (last) c.updatedAt = last.ts;
  return c;
}

/**
 * Return a frozen plain-object projection of a Change.
 * Strips private #state and prevents callers from mutating stored state
 * or reaching transitionTo() on the live stored object.
 */
function freezeChange(c) {
  const proj = {
    id: c.id,
    title: c.title,
    objective: c.objective,
    acceptanceCriteria: [...c.acceptanceCriteria],
    risk: c.risk,
    acceptedPlanId: c.acceptedPlanId,
    state: c.state,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
  Object.freeze(proj.acceptanceCriteria);
  Object.freeze(proj);
  return proj;
}

export class ChangeStore {
  #file;
  #changes;
  #audit;
  /** @type {import('../domain/change.js').Plan[] | null} */
  #plans = null;
  /** @type {Map<string, Array<{changeId: string, sessionId: string, role: string}>}> */
  #bindings = new Map();
  /** @type {Map<string, Array<{changeId: string, attemptId: string, workerId: string, status: string, recordedAt: string}>>} */
  #attempts = new Map();
  /** @type {Set<string>} Keys of locally mutated bindings (changeId:sessionId) */
  #dirtyBindings = new Set();

  constructor(file) {
    this.#file = canonicalPath(file);
    this.#changes = new Map();
    this.#audit = [];
  }

  static async open(file) {
    const store = new ChangeStore(file);
    await store.#load();
    return store;
  }

  async #load() {
    let data;
    try {
      data = await readJson(this.#file);
    } catch {
      return;
    }
    if (!data) return;
    // Seed event ID counter from persisted events to avoid collisions after restart
    const maxId = Math.max(...(data.audit ?? []).map((e) => e.eventId ?? 0), 0);
    if (maxId > eventIdSeq) eventIdSeq = maxId;
    const idx = new Map();
    for (const e of (Array.isArray(data.audit) ? data.audit : [])) {
      if (!idx.has(e.changeId)) idx.set(e.changeId, []);
      idx.get(e.changeId).push(e);
    }
    this.#changes = new Map(
      (data.changes ?? []).map((c) => [c.id, rehydrate(c, idx.get(c.id) ?? [])])
    );
    this.#audit = Array.isArray(data.audit) ? data.audit : [];
    // Plans are serialised inline inside change records as a "plans" array (append-only).
    if (data.plans && Array.isArray(data.plans)) {
      this.#plans = data.plans;
    }
    // Bindings: keyed by changeId.
    if (data.bindings && Array.isArray(data.bindings)) {
      for (const b of data.bindings) {
        if (!this.#bindings.has(b.changeId)) this.#bindings.set(b.changeId, []);
        this.#bindings.get(b.changeId).push(b);
      }
    }
    // Attempts: keyed by changeId.
    if (data.attempts && Array.isArray(data.attempts)) {
      for (const a of data.attempts) {
        if (!this.#attempts.has(a.changeId)) this.#attempts.set(a.changeId, []);
        this.#attempts.get(a.changeId).push(a);
      }
    }
  }

  /**
   * Refresh this store's view of a specific change from disk.
   * Only updates #changes (not #audit) so local audit mutations are preserved.
   */
  async #refreshChange(id) {
    let data;
    try {
      data = await readJson(this.#file);
    } catch {
      return;
    }
    if (!data) return;
    // Re-seed counter from latest disk state
    const maxId = Math.max(...(data.audit ?? []).map((e) => e.eventId ?? 0), 0);
    if (maxId > eventIdSeq) eventIdSeq = maxId;
    const idx = new Map();
    for (const e of (Array.isArray(data.audit) ? data.audit : [])) {
      if (!idx.has(e.changeId)) idx.set(e.changeId, []);
      idx.get(e.changeId).push(e);
    }
    const diskChanges = data.changes ?? [];
    this.#changes = new Map(
      diskChanges.map((c) => [c.id, rehydrate(c, idx.get(c.id) ?? [])])
    );
    // Reload plans from disk so plan statuses (ACCEPTED/SUPERSEDED) are current.
    if (data.plans && Array.isArray(data.plans)) {
      this.#plans = data.plans;
    }
    // Reload bindings from disk to preserve records from other instances.
    if (data.bindings && Array.isArray(data.bindings)) {
      this.#bindings = new Map();
      for (const b of data.bindings) {
        if (!this.#bindings.has(b.changeId)) this.#bindings.set(b.changeId, []);
        this.#bindings.get(b.changeId).push(b);
      }
    }
    // Reload attempts from disk to preserve records from other instances.
    if (data.attempts && Array.isArray(data.attempts)) {
      this.#attempts = new Map();
      for (const a of data.attempts) {
        if (!this.#attempts.has(a.changeId)) this.#attempts.set(a.changeId, []);
        this.#attempts.get(a.changeId).push(a);
      }
    }
    // NOTE: we do NOT replace this.#audit here — local audit entries are
    // merged in #persist() via eventId dedup, preserving uncommitted events.
    return this.#changes.get(id);
  }

  async #persist() {
    let diskData;
    try {
      diskData = await readJson(this.#file);
    } catch {
      diskData = null;
    }
    const diskChanges = diskData?.changes ?? [];
    const diskAudit = Array.isArray(diskData?.audit) ? diskData.audit : [];
    const diskEventIds = new Set(diskAudit.map((e) => e.eventId));

    // Merge: start from disk, overlay our local changes (by id).
    // Only overwrite state fields (domainState, planState) if this store
    // has local uncommitted audit events for this change — otherwise keep
    // disk values to avoid stale-writer erosion (B3).
    const mergedChanges = new Map();
    for (const c of diskChanges) mergedChanges.set(c.id, c);
    for (const [id, c] of this.#changes) {
      const diskRec = mergedChanges.get(id);
      // Check if we have local audit events for this change that aren't on disk
      const hasLocalEvents = this.#audit.some((e) => e.changeId === id && !diskEventIds.has(e.eventId));
      if (hasLocalEvents) {
        mergedChanges.set(id, {
          id: c.id,
          title: c.title,
          objective: c.objective,
          acceptanceCriteria: c.acceptanceCriteria,
          risk: c.risk,
          acceptedPlanId: c.acceptedPlanId,
          planState: c._getPlanState?.() ?? null,
          domainState: c._getDomainState?.() ?? c.state,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
        });
      } else if (diskRec) {
        // Preserve all lifecycle fields from disk; only overlay mutable scalars.
        mergedChanges.set(id, {
          ...diskRec,
          title: c.title,
          objective: c.objective,
          acceptanceCriteria: c.acceptanceCriteria,
          risk: c.risk,
          updatedAt: c.updatedAt,
        });
      }
    }

    // Merge audit: disk events + our local new events (dedup by eventId)
    const mergedAudit = [
      ...diskAudit,
      ...this.#audit.filter((e) => !diskEventIds.has(e.eventId)),
    ];

    // Merge plans: start from disk, overlay local plans only when the store
    // has local uncommitted audit events for the associated change.
    // This prevents a stale writer from restoring superseded/accepted plan
    // statuses that were updated by another instance (B3 extended).
    const diskPlans = Array.isArray(diskData?.plans) ? diskData.plans : [];
    const mergedPlans = new Map();
    for (const p of diskPlans) mergedPlans.set(p.id, p);
    if (this.#plans) {
      for (const p of this.#plans) {
        // Only overlay plans from stores that have uncommitted events
        const relatedChangeEvents = this.#audit.some((e) => e.changeId === p.changeId && !diskEventIds.has(e.eventId));
        if (relatedChangeEvents || !mergedPlans.has(p.id)) {
          mergedPlans.set(p.id, p);
        }
      }
    }

    // Merge bindings: union by (changeId, sessionId).
    // Only dirty local bindings override disk; all other bindings come from disk.
    const diskBindings = Array.isArray(diskData?.bindings) ? diskData.bindings : [];
    const mergedBindings = new Map();
    for (const b of diskBindings) mergedBindings.set(`${b.changeId}:${b.sessionId}`, b);
    for (const b of [...this.#bindings.values()].flat()) {
      const key = `${b.changeId}:${b.sessionId}`;
      // Only dirty (locally mutated) bindings override disk.
      if (this.#dirtyBindings.has(key)) {
        mergedBindings.set(key, b);
      }
    }

    // Merge attempts: union by attemptId, prefer local.
    const diskAttempts = Array.isArray(diskData?.attempts) ? diskData.attempts : [];
    const mergedAttempts = new Map();
    for (const a of diskAttempts) mergedAttempts.set(a.attemptId, a);
    for (const a of [...this.#attempts.values()].flat()) {
      if (!mergedAttempts.has(a.attemptId)) {
        mergedAttempts.set(a.attemptId, a);
      }
    }

    await writeJson(this.#file, {
      changes: [...mergedChanges.values()],
      audit: mergedAudit,
      // Plans are kept as a top-level array for direct retrieval.
      plans: [...mergedPlans.values()],
      bindings: [...mergedBindings.values()],
      attempts: [...mergedAttempts.values()],
    });
    // Clear dirty flags after successful persist.
    this.#dirtyBindings.clear();
  }

  async create(input) {
    const release = await acquireLock(this.#file);
    try {
      const change = createChange(input);
      this.#changes.set(change.id, change);
      // Reseed from disk under lock immediately before assigning eventId,
      // so concurrent process writes are visible and no collision occurs.
      await reseedFromDisk(this.#file);
      this.#audit.push({
        eventId: nextEventId(),
        changeId: change.id,
        from: null,
        to: 'DRAFT',
        ts: change.createdAt,
      });
      await this.#persist();
      return freezeChange(change);
    } finally {
      release();
    }
  }

  async get(id) {
    const release = await acquireLock(this.#file);
    try {
      const c = this.#changes.get(id);
      if (!c) throw Object.assign(new Error(`Change ${id} not found`), { code: 'NOT_FOUND' });
      return freezeChange(c);
    } finally {
      release();
    }
  }

  async transition(id, nextState) {
    const release = await acquireLock(this.#file);
    try {
      // Refresh the change entity from disk (but preserve local audit entries)
      await this.#refreshChange(id);
      const c = this.#changes.get(id);
      if (!c) throw Object.assign(new Error(`Change ${id} not found`), { code: 'NOT_FOUND' });
      const before = c.state;
      try {
        c.transitionTo(nextState);
      } catch (err) {
        if (err instanceof ChangeDomainError) throw err;
        throw err;
      }
      // Reseed from disk under lock immediately before assigning eventId
      await reseedFromDisk(this.#file);
      this.#audit.push({
        eventId: nextEventId(),
        changeId: id,
        from: before,
        to: nextState,
        ts: c.updatedAt,
      });
      await this.#persist();
      return freezeChange(c);
    } finally {
      release();
    }
  }

  async history(id) {
    const release = await acquireLock(this.#file);
    try {
      return structuredClone(this.#audit.filter((e) => e.changeId === id));
    } finally {
      release();
    }
  }

  // ─── Plan revision support ──────────────────────────────────────────────────

  /**
   * Compute a stable content digest (SHA-256 hex) for deterministic plan comparison.
   * @param {object} content
   * @returns {Promise<string>}
   */
  /**
   * Compute a stable content digest (SHA-256 hex) with deterministic key ordering.
   */
  /**
   * Recursively canonicalize an object: sort all object keys alphabetically,
   * preserve array order. Produces a deterministic JSON string for hashing.
   */
  static #canonicalize(obj) {
    if (Array.isArray(obj)) return obj.map((item) => ChangeStore.#canonicalize(item));
    if (obj !== null && typeof obj === 'object' && !(obj instanceof Date)) {
      const sorted = {};
      for (const key of Object.keys(obj).sort()) sorted[key] = ChangeStore.#canonicalize(obj[key]);
      return sorted;
    }
    return obj;
  }

  async #digest(content) {
    const bytes = new TextEncoder().encode(JSON.stringify(ChangeStore.#canonicalize(content)));
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Submit a new immutable plan revision for a change.
   * DRAFT → PLANNED or READY → PLANNED (post-acceptance revision).
   * On post-acceptance submission, the prior accepted plan is SUPERSEDED and
   * acceptedPlanId resets to null.
   */
  async submitPlan(changeId, content) {
    const release = await acquireLock(this.#file);
    try {
      await this.#refreshChange(changeId);
      const c = this.#changes.get(changeId);
      if (!c) throw Object.assign(new Error(`Change ${changeId} not found`), { code: 'NOT_FOUND' });
      // Allow submission when change is DRAFT, PLANNED, or READY.
      // PLANNED allows re-submitting a revised plan before acceptance.
      if (!['DRAFT', 'PLANNED', 'READY'].includes(c.state)) {
        throw Object.assign(
          new Error(`Cannot submit plan: change is in ${c.state}, expected DRAFT, PLANNED or READY`),
          { code: 'INVALID_STATE' }
        );
      }
      const revisions = (this.#plans ?? []).filter((p) => p.changeId === changeId).sort((a, b) => a.revision - b.revision);
      const nextRevision = revisions.length + 1;
      const digest = await this.#digest(content);
      const now = new Date().toISOString();
      const plan = {
        id: crypto.randomUUID(),
        changeId,
        revision: nextRevision,
        status: 'PLANNED',
        digest,
        content,
        createdAt: now,
        updatedAt: now,
      };
      const priorState = c.state;
      if (c.state === 'READY') {
        // Post-acceptance revision: mark prior accepted plan as SUPERSEDED, reset acceptedPlanId
        const priorAccepted = revisions.find((p) => p.status === 'ACCEPTED');
        if (priorAccepted) priorAccepted.status = 'SUPERSEDED';
        c.acceptedPlanId = null;
        plan.supersedesPlanId = priorAccepted?.id ?? null;
        // READY → PLANNED is outside the Change domain state machine; handle at store level.
        c._setPlanState('PLANNED');
        c.updatedAt = new Date().toISOString();
      } else if (c.state === 'PLANNED') {
        // Re-submitting a plan on an already-PLANNED change doesn't change state.
      } else {
        // DRAFT → PLANNED: use store-level override so it persists via planState.
        c._setPlanState('PLANNED');
      }
      // Record in audit with planId so it's discoverable after restart
      await reseedFromDisk(this.#file);
      this.#audit.push({
        eventId: nextEventId(),
        changeId,
        from: priorState,
        to: 'PLANNED',
        ts: c.updatedAt,
        planId: plan.id,
      });
      (this.#plans ??= []).push(plan);
      await this.#persist();
      return structuredClone(plan);
    } finally {
      release();
    }
  }

  /**
   * Accept a PLANNED plan: transition change READY → ACCEPTED (via PLANNED)
   * and store the acceptedPlanId.
   */
  async acceptPlan(changeId, planId, { authorized = false } = {}) {
    if (!authorized) {
      throw Object.assign(new Error('Not authorized to accept plan'), { code: 'FORBIDDEN' });
    }
    const release = await acquireLock(this.#file);
    try {
      await this.#refreshChange(changeId);
      const c = this.#changes.get(changeId);
      if (!c) throw Object.assign(new Error(`Change ${changeId} not found`), { code: 'NOT_FOUND' });
      // M2: only the current (latest) PLANNED revision may be accepted
      const revisions = (this.#plans ?? []).filter((p) => p.changeId === changeId).sort((a, b) => a.revision - b.revision);
      const currentPlan = revisions[revisions.length - 1];
      if (!currentPlan || currentPlan.status !== 'PLANNED') {
        throw Object.assign(new Error('No current PLANNED revision to accept'), { code: 'INVALID_PLAN_STATE' });
      }
      if (planId !== currentPlan.id) {
        throw Object.assign(new Error('Cannot accept a non-current plan revision'), { code: 'MISMATCH' });
      }
      if (c.state !== 'PLANNED') {
        throw Object.assign(new Error(`Change is in ${c.state}, expected PLANNED`), { code: 'INVALID_STATE' });
      }
      c.acceptedPlanId = planId;
      // PLANNED → READY is a plan-lifecycle transition; use store-level override
      // so it persists via planState on disk.
      c._setPlanState('READY');
      currentPlan.status = 'ACCEPTED';
      currentPlan.acceptedAt = new Date().toISOString();
      await reseedFromDisk(this.#file);
      this.#audit.push({
        eventId: nextEventId(),
        changeId,
        from: 'PLANNED',
        to: 'READY',
        ts: c.updatedAt,
        planId,
      });
      await this.#persist();
      return structuredClone(currentPlan);
    } finally {
      release();
    }
  }

  /**
   * Update plan content — rejected when plan is ACCEPTED (immutable).
   */
  async updatePlan(planId, content) {
    const release = await acquireLock(this.#file);
    try {
      const plan = (this.#plans ?? []).find((p) => p.id === planId);
      if (!plan) throw Object.assign(new Error(`Plan ${planId} not found`), { code: 'NOT_FOUND' });
      if (plan.status !== 'PLANNED') {
        throw Object.assign(new Error(`Cannot modify a ${plan.status} plan: only PLANNED revisions may be updated`), { code: 'PLAN_IMMUTABLE' });
      }
      const digest = await this.#digest(content);
      plan.content = content;
      plan.digest = digest;
      plan.updatedAt = new Date().toISOString();
      // Append a plan-lifecycle audit event so #persist treats this store's
      // plan write as committed (stale writers preserve disk plans).
      this.#audit.push({
        eventId: nextEventId(),
        changeId: plan.changeId,
        from: 'PLANNED',
        to: 'PLANNED',
        planId: plan.id,
        ts: plan.updatedAt,
      });
      await this.#persist();
      return structuredClone(plan);
    } finally {
      release();
    }
  }

  /**
   * List all plan revisions for a change, ordered by revision ascending.
   */
  async listPlans(changeId) {
    const release = await acquireLock(this.#file);
    try {
      const c = this.#changes.get(changeId);
      if (!c) throw Object.assign(new Error(`Change ${changeId} not found`), { code: 'NOT_FOUND' });
      const plans = (this.#plans ?? []).filter((p) => p.changeId === changeId).sort((a, b) => a.revision - b.revision);
      return structuredClone(plans);
    } finally {
      release();
    }
  }

  /**
   * Retrieve a single plan by id.
   */
  async getPlan(planId) {
    const release = await acquireLock(this.#file);
    try {
      const plan = (this.#plans ?? []).find((p) => p.id === planId);
      if (!plan) throw Object.assign(new Error(`Plan ${planId} not found`), { code: 'NOT_FOUND' });
      return structuredClone(plan);
    } finally {
      release();
    }
  }

  // ─── Session role bindings ──────────────────────────────────────────────────

  /**
   * Bind a session to a role on a Change.
   * Signature: bindRole(changeId, sessionId, role, { rebind } = {})
   * Rejected if the Change does not exist or if an existing binding for that
   * (changeId, sessionId) pair holds a different role without explicit rebind.
   */
  async bindRole(changeId, sessionId, role, opts = {}) {
    const release = await acquireLock(this.#file);
    try {
      await this.#refreshChange(changeId);
      const c = this.#changes.get(changeId);
      if (!c) {
        // Ensure file exists with empty bindings to demonstrate no partial persistence
        await this.#persist();
        throw Object.assign(new Error(`Change ${changeId} not found`), { code: 'NOT_FOUND' });
      }

      const changeBindings = this.#bindings.get(changeId) ?? [];
      const existing = changeBindings.find((b) => b.sessionId === sessionId);
      if (existing) {
        if (opts.rebind) {
          // Replace the existing binding with the new role
          const idx = changeBindings.indexOf(existing);
          changeBindings[idx] = { changeId, sessionId, role };
          this.#bindings.set(changeId, changeBindings);
          this.#dirtyBindings.add(`${changeId}:${sessionId}`);
          await this.#persist();
          return structuredClone(changeBindings[idx]);
        }
        throw Object.assign(new Error(`Session ${sessionId} is already bound to role ${existing.role} on change ${changeId}`), { code: 'ALREADY_BOUND' });
      }

      const binding = { changeId, sessionId, role };
      changeBindings.push(binding);
      this.#bindings.set(changeId, changeBindings);
      this.#dirtyBindings.add(`${changeId}:${sessionId}`);
      await this.#persist();
      return structuredClone(binding);
    } finally {
      release();
    }
  }

  /**
   * Resolve a session's binding for a role on a Change.
   * Returns the role string or throws if no binding exists.
   */
  async resolveRole(changeId, sessionId) {
    const release = await acquireLock(this.#file);
    try {
      await this.#refreshBindingsAndAttempts();
      const binding = (this.#bindings.get(changeId) ?? []).find(
        (b) => b.changeId === changeId && b.sessionId === sessionId
      );
      if (!binding) throw Object.assign(new Error(`No binding for session ${sessionId} on change ${changeId}`), { code: 'NOT_FOUND' });
      return binding.role;
    } finally {
      release();
    }
  }

  /**
   * List all role bindings for a Change.
   */
  async listRoleBindings() {
    const release = await acquireLock(this.#file);
    try {
      await this.#refreshBindingsAndAttempts();
      return structuredClone([...this.#bindings.values()].flat());
    } finally {
      release();
    }
  }

  // ─── Worker implementation attempts ─────────────────────────────────────────

  /**
   * Record an implementation attempt for a Change, independent of session identity.
   */
  async recordAttempt(changeId, { attemptId, workerId, status }) {
    const release = await acquireLock(this.#file);
    try {
      await this.#refreshChange(changeId);
      const c = this.#changes.get(changeId);
      if (!c) throw Object.assign(new Error(`Change ${changeId} not found`), { code: 'NOT_FOUND' });

      const attempt = { changeId, attemptId, workerId, status, recordedAt: new Date().toISOString() };
      const changeAttempts = this.#attempts.get(changeId) ?? [];
      changeAttempts.push(attempt);
      this.#attempts.set(changeId, changeAttempts);
      await this.#persist();
      return structuredClone(attempt);
    } finally {
      release();
    }
  }

  /**
   * List all recorded attempts for a Change.
   */
  async listAttempts(changeId) {
    const release = await acquireLock(this.#file);
    try {
      await this.#refreshBindingsAndAttempts();
      return structuredClone(this.#attempts.get(changeId) ?? []);
    } finally {
      release();
    }
  }

  /**
   * Reload bindings and attempts from disk under lock.
   * Preserves local uncommitted changes while picking up concurrent writes.
   * Bindings are synchronized by (changeId, sessionId) - replacing role on rebind.
   */
  async #refreshBindingsAndAttempts() {
    let data;
    try {
      data = await readJson(this.#file);
    } catch {
      return;
    }
    if (!data) return;
    // Reload bindings from disk, sync by (changeId, sessionId)
    if (data.bindings && Array.isArray(data.bindings)) {
      for (const b of data.bindings) {
        if (!this.#bindings.has(b.changeId)) this.#bindings.set(b.changeId, []);
        const changeBindings = this.#bindings.get(b.changeId);
        const existingIdx = changeBindings.findIndex((eb) => eb.sessionId === b.sessionId);
        if (existingIdx >= 0) {
          // Replace existing binding (handles rebind case)
          changeBindings[existingIdx] = { changeId: b.changeId, sessionId: b.sessionId, role: b.role };
        } else {
          // Add new binding
          changeBindings.push({ changeId: b.changeId, sessionId: b.sessionId, role: b.role });
        }
      }
    }
    // Reload attempts from disk
    if (data.attempts && Array.isArray(data.attempts)) {
      for (const a of data.attempts) {
        if (!this.#attempts.has(a.changeId)) this.#attempts.set(a.changeId, []);
        // Only add if not already present (preserve local adds)
        const existing = this.#attempts.get(a.changeId).find((ea) => ea.attemptId === a.attemptId && ea.workerId === a.workerId);
        if (!existing) {
          this.#attempts.get(a.changeId).push(a);
        }
      }
    }
  }
}
