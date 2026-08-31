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
  /** @type {Map<string, object>} changeId -> proof bundle */
  #proofs = new Map();
  /** @type {Map<string, Array>} changeId -> controller preflight results */
  #preflightResults = new Map();
  /** @type {Set<string>} Keys of locally mutated bindings (changeId:sessionId) */
  #dirtyBindings = new Set();
  /** @type {{requiredChecks: string[], protectedPaths: string[]} | null} */
  #preflightPolicy = null;

  constructor(file, { preflightPolicy } = {}) {
    this.#file = canonicalPath(file);
    this.#changes = new Map();
    this.#audit = [];
    if (preflightPolicy) {
      this.#preflightPolicy = {
        requiredChecks: Array.isArray(preflightPolicy.requiredChecks) ? preflightPolicy.requiredChecks : [],
        protectedPaths: Array.isArray(preflightPolicy.protectedPaths) ? preflightPolicy.protectedPaths : [],
      };
    }
  }

  static async open(file, options = {}) {
    const store = new ChangeStore(file, options);
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
    this.#changes = new Map();
    for (const c of data.changes ?? []) {
      const ch = rehydrate(c, idx.get(c.id) ?? []);
      if (c.requiredChecks) ch._requiredChecks = c.requiredChecks;
      if (c.controllerPreflightResults) ch._controllerPreflightResults = c.controllerPreflightResults;
      this.#changes.set(c.id, ch);
    }
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
    // Proofs: keyed by changeId.
    if (data.proofs && typeof data.proofs === 'object') {
      for (const [changeId, proof] of Object.entries(data.proofs)) {
        this.#proofs.set(changeId, proof);
      }
    }
    // Preflight results: keyed by changeId.
    if (data.preflightResults && typeof data.preflightResults === 'object') {
      for (const [changeId, results] of Object.entries(data.preflightResults)) {
        this.#preflightResults.set(changeId, results);
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
    // Reload proofs from disk to preserve records from other instances.
    if (data.proofs && typeof data.proofs === 'object') {
      this.#proofs = new Map();
      for (const [changeId, proof] of Object.entries(data.proofs)) {
        this.#proofs.set(changeId, proof);
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
          requiredChecks: c._requiredChecks ?? null,
          controllerPreflightResults: c._controllerPreflightResults ?? null,
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
          requiredChecks: c._requiredChecks ?? diskRec.requiredChecks ?? null,
          controllerPreflightResults: c._controllerPreflightResults ?? diskRec.controllerPreflightResults ?? null,
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

    // Merge proofs: union by changeId, prefer local.
    const diskProofs = diskData?.proofs && typeof diskData.proofs === 'object' ? diskData.proofs : {};
    const mergedProofs = { ...diskProofs };
    for (const [changeId, proof] of this.#proofs) {
      mergedProofs[changeId] = proof;
    }

    // Merge preflight results: union by changeId, prefer local.
    const diskPreflightResults = diskData?.preflightResults && typeof diskData.preflightResults === 'object' ? diskData.preflightResults : {};
    const mergedPreflightResults = { ...diskPreflightResults };
    for (const [changeId, results] of this.#preflightResults) {
      mergedPreflightResults[changeId] = results;
    }

    await writeJson(this.#file, {
      changes: [...mergedChanges.values().filter((c) => c)],
      preflightResults: mergedPreflightResults,
      audit: mergedAudit,
      // Plans are kept as a top-level array for direct retrieval.
      plans: [...mergedPlans.values()],
      bindings: [...mergedBindings.values()],
      attempts: [...mergedAttempts.values()],
      proofs: mergedProofs,
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
   * Append a free-form audit event to this store's audit log.
   * Used by external policy subsystems (e.g. filesystem policy) to record
   * denials and other out-of-band events without mutating change state.
   */
  async appendAudit(event) {
    const release = await acquireLock(this.#file);
    try {
      await reseedFromDisk(this.#file);
      this.#audit.push(event);
      await this.#persist();
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

  /**
   * Reload proofs from disk under lock.
   * Preserves local uncommitted proofs while picking up concurrent writes.
   */
  async #refreshProofs() {
    let data;
    try {
      data = await readJson(this.#file);
    } catch {
      return;
    }
    if (!data) return;
    // Reload proofs from disk, sync by changeId (prefer local for uncommitted)
    if (data.proofs && typeof data.proofs === 'object') {
      for (const [changeId, proof] of Object.entries(data.proofs)) {
        if (!this.#proofs.has(changeId)) {
          this.#proofs.set(changeId, proof);
        }
      }
    }
  }

  // ─── Proof Bundle ───────────────────────────────────────────────────────────

  /**
   * Validate and persist a Proof Bundle for a Change in IMPLEMENTING state.
   * Transitions the change to PREFLIGHT on success.
   * @param {string} changeId
   * @param {object} proof
   * @param {string} proof.beforeRevision
   * @param {string} proof.afterRevision
   * @param {Array<{id: string, satisfied: boolean}>} proof.criteria
   * @param {Array} [proof.deviations]
   * @param {Array} proof.workerChecks
   * @param {Array} proof.controllerPreflight
   * @returns {{state: string, proof: object}}
   */
  async submitProof(changeId, proof) {
    const release = await acquireLock(this.#file);
    try {
      await this.#refreshChange(changeId);
      const c = this.#changes.get(changeId);
      if (!c) throw Object.assign(new Error(`Change ${changeId} not found`), { code: 'NOT_FOUND' });
      if (c.state !== 'IMPLEMENTING') {
        throw Object.assign(new Error(`Cannot submit proof: change is in ${c.state}, expected IMPLEMENTING`), { code: 'INVALID_STATE' });
      }

      // ── Validate proof structure ──────────────────────────────────────
      if (!proof || typeof proof !== 'object') {
        throw Object.assign(new Error('Proof is required'), { code: 'INVALID_PROOF' });
      }
      if (!proof.beforeRevision || typeof proof.beforeRevision !== 'string') {
        throw Object.assign(new Error('beforeRevision is required'), { code: 'INVALID_PROOF' });
      }
      if (!proof.afterRevision || typeof proof.afterRevision !== 'string') {
        throw Object.assign(new Error('afterRevision is required'), { code: 'INVALID_PROOF' });
      }
      if (!Array.isArray(proof.criteria)) {
        throw Object.assign(new Error('criteria is required and must be an array'), { code: 'INVALID_PROOF' });
      }
      if (proof.deviations === undefined || proof.deviations === null) {
        throw Object.assign(new Error('deviations is required'), { code: 'INVALID_PROOF' });
      }
      if (!Array.isArray(proof.deviations)) {
        throw Object.assign(new Error('deviations must be an array'), { code: 'INVALID_PROOF' });
      }
      if (!Array.isArray(proof.workerChecks)) {
        throw Object.assign(new Error('workerChecks is required'), { code: 'INVALID_PROOF' });
      }
      if (!Array.isArray(proof.controllerPreflight)) {
        throw Object.assign(new Error('controllerPreflight is required'), { code: 'INVALID_PROOF' });
      }

      // Build the set of accepted criterion IDs from the change
      const acceptedIds = new Set(c.acceptanceCriteria);

      // Validate each criterion entry: must be an object with string id and boolean satisfied
      for (const crit of proof.criteria) {
        if (!crit || typeof crit !== 'object') {
          throw Object.assign(new Error('Each criterion must be an object'), { code: 'INVALID_PROOF' });
        }
        if (typeof crit.id !== 'string') {
          throw Object.assign(new Error('Criterion id must be a string'), { code: 'INVALID_PROOF' });
        }
        if (typeof crit.satisfied !== 'boolean') {
          throw Object.assign(new Error(`Criterion satisfied must be a boolean for id: ${crit.id}`), { code: 'INVALID_PROOF' });
        }
      }

      // Check for unknown criterion IDs
      for (const crit of proof.criteria) {
        if (!acceptedIds.has(crit.id)) {
          throw Object.assign(new Error(`Unknown criterion ID: ${crit.id}`), { code: 'UNKNOWN_CRITERION' });
        }
      }

      // Check for duplicate criterion IDs
      const seenIds = new Set();
      for (const crit of proof.criteria) {
        if (seenIds.has(crit.id)) {
          throw Object.assign(new Error(`Duplicate criterion ID: ${crit.id}`), { code: 'DUPLICATE_CRITERION' });
        }
        seenIds.add(crit.id);
      }

      // Check that all accepted criteria are covered exactly once
      for (const id of acceptedIds) {
        if (!seenIds.has(id)) {
          throw Object.assign(new Error(`Missing criterion: ${id}`), { code: 'MISSING_CRITERION' });
        }
      }

      // All validations passed — transition state and persist proof
      const before = c.state;
      c.transitionTo('PREFLIGHT');

      await reseedFromDisk(this.#file);
      this.#audit.push({
        eventId: nextEventId(),
        changeId,
        from: before,
        to: 'PREFLIGHT',
        ts: c.updatedAt,
      });

      // Store proof
      this.#proofs.set(changeId, structuredClone(proof));
      await this.#persist();

      return { state: c.state, proof: structuredClone(proof) };
    } finally {
      release();
    }
  }

  /**
   * Retrieve the persisted Proof Bundle for a Change.
   * @param {string} changeId
   * @returns {object}
   */
  async getProof(changeId) {
    const release = await acquireLock(this.#file);
    try {
      await this.#refreshProofs();
      const proof = this.#proofs.get(changeId);
      if (!proof) throw Object.assign(new Error(`No proof found for change ${changeId}`), { code: 'NOT_FOUND' });
      return structuredClone(proof);
    } finally {
      release();
    }
  }

  // ─── Required Checks Configuration ────────────────────────────────────────

  /**
   * Host-owned required-checks configuration for a change.
   * Workers cannot modify this via ordinary writes.
   * @param {string} changeId
   * @param {Array<{name: string, command?: string, env?: object, cwd?: string}>} checks
   * @param {{workerId?: string}} [opts]
   */
  async setRequiredChecks(changeId, checks, opts = {}) {
    const release = await acquireLock(this.#file);
    try {
      await this.#refreshChange(changeId);
      const c = this.#changes.get(changeId);
      if (!c) throw Object.assign(new Error(`Change ${changeId} not found`), { code: 'NOT_FOUND' });
      // Guard: only host (no workerId) may write required-checks config.
      if (opts.workerId) {
        throw Object.assign(new Error('Worker-facing writes cannot alter host-required check configuration'), { code: 'FORBIDDEN' });
      }
      // Store requiredChecks alongside the change record.
      if (!c._requiredChecks) c._requiredChecks = [];
      c._requiredChecks = structuredClone(checks);
      await this.#persist();
      return structuredClone(c._requiredChecks);
    } finally {
      release();
    }
  }

  /**
   * Retrieve required-checks configuration for a change.
   * @param {string} changeId
   * @returns {Array<object>|null}
   */
  async getRequiredChecks(changeId) {
    const release = await acquireLock(this.#file);
    try {
      await this.#refreshChange(changeId);
      const c = this.#changes.get(changeId);
      if (!c) throw Object.assign(new Error(`Change ${changeId} not found`), { code: 'NOT_FOUND' });
      return c._requiredChecks ? structuredClone(c._requiredChecks) : null;
    } finally {
      release();
    }
  }

  /**
   * Invalidate stored proof when workspace revision drifts.
   * @param {string} changeId
   */
  async invalidateProof(changeId) {
    const release = await acquireLock(this.#file);
    try {
      await this.#refreshChange(changeId);
      const c = this.#changes.get(changeId);
      if (!c) throw Object.assign(new Error(`Change ${changeId} not found`), { code: 'NOT_FOUND' });
      // Tombstone the proof so #persist cannot merge the older disk value back.
      // A null entry remains durable and makes getProof report NOT_FOUND after reopen.
      this.#proofs.set(changeId, null);
      await this.#persist();
    } finally {
      release();
    }
  }

  /**
   * Run preflight verification using the configured preflight policy.
   * Host-owned entry point that delegates to PreflightRunner logic.
   * @param {string} changeId
   * @param {object} params
   * @param {string} params.currentRevision
   * @param {string[]} params.changedFiles
   * @param {Array} params.checkResults
   * @returns {Promise<{allowed: boolean, results: object[], state: string}>}
   */
  async runPreflight(changeId, { currentRevision, changedFiles, checkResults } = {}) {
    const policy = this.#preflightPolicy;
    if (!policy || !policy.requiredChecks || policy.requiredChecks.length === 0) {
      throw Object.assign(new Error('No preflight policy configured for this store'), { code: 'NO_POLICY' });
    }

    // 1. Load the change and verify it is in PREFLIGHT.
    const change = await this.get(changeId);
    if (change.state !== 'PREFLIGHT') {
      throw Object.assign(
        new Error(`Change ${changeId} is in ${change.state}, expected PREFLIGHT`),
        { code: 'INVALID_STATE', changeId }
      );
    }

    // 2. Load the proof bundle — mandatory for preflight to succeed.
    let proof;
    try {
      proof = await this.getProof(changeId);
    } catch (err) {
      if (err.code === 'NOT_FOUND') {
        throw Object.assign(new Error(`No proof bundle found for change ${changeId}`), { code: 'NO_PROOF', changeId });
      }
      throw err;
    }

    // 3. Staleness check: workspace revision must match proof.afterRevision.
    if (proof.afterRevision !== currentRevision) {
      throw Object.assign(
        new Error(`Proof stale: afterRevision=${proof.afterRevision}, currentRevision=${currentRevision}`),
        { code: 'STALE_PROOF', changeId, afterRevision: proof.afterRevision, currentRevision }
      );
    }

    // 4. Protected-path check.
    const violation = (changedFiles ?? []).find((f) => (policy.protectedPaths ?? []).includes(f));
    if (violation) {
      throw Object.assign(
        new Error(`Protected path changed: ${violation}`),
        { code: 'PROTECTED_PATH_CHANGED', changeId, protectedPath: violation }
      );
    }

    // 5. Required-checks filtering using host-owned requiredChecks.
    const filtered = (policy.requiredChecks ?? [])
      .map((name) => {
        const result = (checkResults ?? []).find((r) => r.name === name);
        return result ?? { name, passed: false, exitCode: 1 };
      });

    // 6. Any failure blocks REVIEW.
    const failed = filtered.filter((r) => !r.passed);
    if (failed.length > 0) {
      throw Object.assign(
        new Error(`Required checks failed: ${failed.map((r) => r.name).join(', ')}`),
        { code: 'REQUIRED_CHECK_FAILURE', changeId, failedChecks: failed }
      );
    }

    // 7. Persist controller results separately from proof.workerChecks.
    const persistedResults = filtered.map((r) => ({
      name: r.name,
      passed: r.passed,
      exitCode: r.exitCode ?? 0,
      output: r.output ?? null,
    }));

    this.#preflightResults.set(changeId, persistedResults);
    await this.#persist();

    // 8. Transition PREFLIGHT → REVIEW via store transition method.
    await this.transition(changeId, 'REVIEW');

    return {
      allowed: true,
      state: 'REVIEW',
      preflight: { controllerResults: persistedResults, status: 'PASSED' },
    };
  }

  /**
   * Get preflight status for a change.
   * @param {string} changeId
   * @returns {Promise<object|null>}
   */
  async getPreflight(changeId) {
    const change = await this.get(changeId);
    if (change.state !== 'REVIEW' && change.state !== 'PREFLIGHT') {
      return null;
    }
    const results = this.#preflightResults.get(changeId);
    if (!results) return null;
    return {
      allowed: true,
      state: change.state,
      controllerResults: results,
    };
  }

  /**
   * Internal-only: store preflight results for a change.
   * @internal
   */
  async _setPreflightResults(changeId, results) {
    this.#preflightResults.set(changeId, results);
    await this.#persist();
  }

  /**
   * Internal-only: get preflight results for a change.
   * @internal
   */
  async _getPreflightResults(changeId) {
    const results = this.#preflightResults.get(changeId);
    return results ? structuredClone(results) : null;
  }

  /**
   * Internal-only: persist current in-memory state to disk.
   * Used by PreflightRunner to commit controller results without going through a public mutation method.
   * @internal
   */
  async _persist() {
    await this.#persist();
  }
}
