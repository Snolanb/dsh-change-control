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
import { createChange, ChangeDomainError } from '../domain/change.js';

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
  // Replay only domain-transition events (skip plan-lifecycle events which have planId).
  for (const e of events) {
    if (e.planId != null) continue;
    if (e.from !== null) c.transitionTo(e.to);
  }
  // Apply any plan-lifecycle state override persisted on the change record.
  if (serialized.planState) {
    c._setPlanState(serialized.planState);
  }
  const last = events.filter((e) => e.planId == null)[events.filter((e) => e.planId == null).length - 1];
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

    // Merge: start from disk, overlay our local changes (by id)
    const mergedChanges = new Map();
    for (const c of diskChanges) mergedChanges.set(c.id, c);
    for (const [id, c] of this.#changes) {
      mergedChanges.set(id, {
        id: c.id,
        title: c.title,
        objective: c.objective,
        acceptanceCriteria: c.acceptanceCriteria,
        risk: c.risk,
        acceptedPlanId: c.acceptedPlanId,
        planState: c._getPlanState?.() ?? null,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      });
    }

    // Merge audit: disk events + our local new events (dedup by eventId)
    const diskEventIds = new Set(diskAudit.map((e) => e.eventId));
    const mergedAudit = [
      ...diskAudit,
      ...this.#audit.filter((e) => !diskEventIds.has(e.eventId)),
    ];

    await writeJson(this.#file, {
      changes: [...mergedChanges.values()],
      audit: mergedAudit,
      // Plans are kept as a top-level array for direct retrieval.
      plans: this.#plans,
    });
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
  async #digest(content) {
    const bytes = new TextEncoder().encode(JSON.stringify(content));
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
      // Allow submission when change is DRAFT, PLANNED, or READY
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
        // DRAFT → PLANNED is a plan-lifecycle transition; persist via planState override
        // so rehydration restores the correct state without replaying plan audit events.
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
      return plan;
    } finally {
      release();
    }
  }

  /**
   * Accept a PLANNED plan: transition change READY → ACCEPTED (via PLANNED)
   * and store the acceptedPlanId.
   */
  async acceptPlan(changeId, planId, { authorized = true } = {}) {
    if (!authorized) {
      throw Object.assign(new Error('Not authorized to accept plan'), { code: 'FORBIDDEN' });
    }
    const release = await acquireLock(this.#file);
    try {
      await this.#refreshChange(changeId);
      const c = this.#changes.get(changeId);
      if (!c) throw Object.assign(new Error(`Change ${changeId} not found`), { code: 'NOT_FOUND' });
      const plan = (this.#plans ?? []).find((p) => p.id === planId);
      if (!plan) throw Object.assign(new Error(`Plan ${planId} not found`), { code: 'NOT_FOUND' });
      if (plan.changeId !== changeId) throw Object.assign(new Error('Plan does not belong to this change'), { code: 'MISMATCH' });
      if (plan.status !== 'PLANNED') throw Object.assign(new Error(`Cannot accept plan in ${plan.status} state`), { code: 'INVALID_PLAN_STATE' });
      // PLANNED → READY (already PLANNED), then store acceptedPlanId
      c.acceptedPlanId = plan.id;
      // Transition change READY ← PLANNED is already handled by submitPlan which set it to PLANNED.
      // We now transition PLANNED → READY directly via the domain machine (already in PLANNED)
      // and then mark accepted. The store level just sets acceptedPlanId and updates change state.
      if (c.state !== 'PLANNED') {
        throw Object.assign(new Error(`Change is in ${c.state}, expected PLANNED`), { code: 'INVALID_STATE' });
      }
      // PLANNED → READY is a plan-lifecycle transition; use store-level override
      // so it persists via planState on disk.
      c._setPlanState('READY');
      plan.status = 'ACCEPTED';
      plan.acceptedAt = new Date().toISOString();
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
      return { ...plan };
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
      if (plan.status === 'ACCEPTED') {
        throw Object.assign(new Error('Cannot modify an accepted plan: plan content is immutable'), { code: 'PLAN_IMMUTABLE' });
      }
      // Replace the non-accepted plan content
      const existingRevisions = (this.#plans ?? []).filter((p) => p.changeId === plan.changeId && p.revision === plan.revision);
      // Find and update in-place
      const idx = (this.#plans ?? []).findIndex((p) => p.id === planId);
      if (idx !== -1) {
        const digest = await this.#digest(content);
        plan.content = content;
        plan.digest = digest;
        plan.updatedAt = new Date().toISOString();
        await this.#persist();
      }
      return { ...plan };
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
}
