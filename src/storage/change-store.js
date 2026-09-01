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
  /** @type {Map<string, Array<{findingId: string, status: string, claim: string, recordedAt: string}>>} changeId -> repair claims (append-only) */
  #repairClaims = new Map();
  /** @type {Map<string, object>} changeId -> repair proof (last submitted) */
  #repairProofs = new Map();
  /** @type {Map<string, Array<{id: string, sessionId: string, verdict: string, revision: string, findings: Array<object>, submittedAt: string, stale: boolean}>>} changeId -> review records (append-only) */
  #reviews = new Map();
  /** @type {Set<string>} Keys of locally mutated reviews (changeId) */
  #dirtyReviews = new Set();
  /** @type {Set<string>} Keys of locally mutated bindings (changeId:sessionId) */
  #dirtyBindings = new Set();
  /** @type {Set<string>} Keys of locally mutated repair claims (changeId) */
  #dirtyRepairClaims = new Set();
  /** @type {{requiredChecks: Array<string|object>, protectedPaths: string[]} | null} */
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
    // Reviews: keyed by changeId, stored as append-only array.
    if (data.reviews && typeof data.reviews === 'object') {
      for (const [changeId, reviews] of Object.entries(data.reviews)) {
        if (Array.isArray(reviews)) {
          this.#reviews.set(changeId, reviews);
        }
      }
    }
    // Repair claims: keyed by changeId, stored as append-only array.
    if (data.repairClaims && typeof data.repairClaims === 'object') {
      for (const [changeId, claims] of Object.entries(data.repairClaims)) {
        if (Array.isArray(claims)) {
          this.#repairClaims.set(changeId, claims);
        }
      }
    }
    // Repair proofs: keyed by changeId.
    if (data.repairProofs && typeof data.repairProofs === 'object') {
      for (const [changeId, proof] of Object.entries(data.repairProofs)) {
        this.#repairProofs.set(changeId, proof);
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
    // Reload reviews from disk to preserve records from other instances.
    if (data.reviews && typeof data.reviews === 'object') {
      this.#reviews = new Map();
      for (const [changeId, reviews] of Object.entries(data.reviews)) {
        if (Array.isArray(reviews)) {
          this.#reviews.set(changeId, reviews);
        }
      }
    }
    // Reload repair claims from disk to preserve records from other instances.
    if (data.repairClaims && typeof data.repairClaims === 'object') {
      for (const [changeId, claims] of Object.entries(data.repairClaims)) {
        if (Array.isArray(claims)) {
          this.#repairClaims.set(changeId, claims);
        }
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

    // Merge reviews: append-only per changeId, dirty local reviews overlay disk.
    const diskReviews = diskData?.reviews && typeof diskData.reviews === 'object' ? diskData.reviews : {};
    const mergedReviews = { ...diskReviews };
    for (const [changeId, reviews] of this.#reviews) {
      // Only dirty (locally mutated) reviews override disk.
      if (this.#dirtyReviews.has(changeId)) {
        mergedReviews[changeId] = reviews;
      }
    }

    // Merge repair claims: append-only per changeId, dirty guard mirrors #dirtyReviews
    const diskRepairClaims = diskData?.repairClaims && typeof diskData.repairClaims === 'object' ? diskData.repairClaims : {};
    const mergedRepairClaims = { ...diskRepairClaims };
    for (const [changeId, claims] of this.#repairClaims) {
      if (this.#dirtyRepairClaims.has(changeId)) {
        mergedRepairClaims[changeId] = claims;
      }
    }

    // Merge repair proofs: union by changeId, prefer local.
    const diskRepairProofs = diskData?.repairProofs && typeof diskData.repairProofs === 'object' ? diskData.repairProofs : {};
    const mergedRepairProofs = { ...diskRepairProofs };
    for (const [changeId, proof] of this.#repairProofs) {
      mergedRepairProofs[changeId] = proof;
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
      reviews: mergedReviews,
      repairClaims: mergedRepairClaims,
      repairProofs: mergedRepairProofs,
    });
    // Clear dirty flags after successful persist.
    this.#dirtyBindings.clear();
    this.#dirtyReviews.clear();
    this.#dirtyRepairClaims.clear();
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
  async recordAttempt(changeId, { attemptId, workerId, status, revision } = {}) {
    const release = await acquireLock(this.#file);
    try {
      await this.#refreshChange(changeId);
      const c = this.#changes.get(changeId);
      if (!c) throw Object.assign(new Error(`Change ${changeId} not found`), { code: 'NOT_FOUND' });

      const attempt = { changeId, attemptId, workerId, status, recordedAt: new Date().toISOString(), revision: revision || null };
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
      .map((entry) => {
        const name = typeof entry === 'string' ? entry : entry.name;
        const defaultCheck = typeof entry === 'object' && entry.command ? { ...entry, passed: false, exitCode: 1 } : { name, passed: false, exitCode: 1 };
        const result = (checkResults ?? []).find((r) => r.name === name);
        return result ?? defaultCheck;
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

  // ─── Review submission ────────────────────────────────────────────────────

  /**
   * Submit a review for a Change. Requires reviewer role binding.
   * Validates findings: important/critical require requiredOutcome.
   * Assigns unique immutable IDs to accepted findings.
   * Transitions change based on verdict AND blocking severity.
   */
  async submitReview(changeId, review, opts = {}) {
    const release = await acquireLock(this.#file);
    try {
      await this.#refreshChange(changeId);
      const c = this.#changes.get(changeId);
      if (!c) throw Object.assign(new Error(`Change ${changeId} not found`), { code: 'NOT_FOUND' });

      // Validate change is in REVIEW state
      if (c.state !== 'REVIEW') {
        throw Object.assign(new Error(`Cannot submit review: change is in ${c.state}, expected REVIEW`), { code: 'INVALID_STATE' });
      }

      // Validate reviewer session ID from opts
      const sessionId = opts.sessionId;
      if (!sessionId || typeof sessionId !== 'string') {
        throw Object.assign(new Error('sessionId is required'), { code: 'INVALID_REVIEW' });
      }

      // Validate reviewer role binding
      const bindingRole = (this.#bindings.get(changeId) ?? []).find((b) => b.sessionId === sessionId)?.role;
      if (!bindingRole) {
        throw Object.assign(new Error(`No binding found for session ${sessionId}`), { code: 'SESSION_NOT_BOUND' });
      }
      if (bindingRole !== 'reviewer') {
        throw Object.assign(new Error(`Session ${sessionId} has role ${bindingRole}, expected reviewer`), { code: 'ROLE_NOT_ALLOWED' });
      }

      // Reject if reviewer session appears as workerId in any recorded attempt (self-review)
      const attempts = this.#attempts.get(changeId) ?? [];
      if (attempts.some((a) => a.workerId === sessionId)) {
        throw Object.assign(new Error(`Session ${sessionId} has recorded implementation attempts on this change`), { code: 'REVIEWER_NOT_INDEPENDENT' });
      }

      // Validate review structure
      if (!review || typeof review !== 'object') {
        throw Object.assign(new Error('Review is required'), { code: 'INVALID_REVIEW' });
      }
      if (!review.verdict || typeof review.verdict !== 'string') {
        throw Object.assign(new Error('verdict is required'), { code: 'INVALID_REVIEW' });
      }
      if (review.verdict !== 'pass' && review.verdict !== 'fail') {
        throw Object.assign(new Error('verdict must be "pass" or "fail"'), { code: 'INVALID_REVIEW' });
      }
      // Require non-empty string revision (trim check)
      if (!review.revision || typeof review.revision !== 'string' || String(review.revision).trim() === '') {
        throw Object.assign(new Error('revision is required and must be a non-empty string'), { code: 'INVALID_REVIEW' });
      }

      // Reject stale review: review.revision must match current implementation revision
      const currentRevision = attempts.length > 0
        ? attempts[attempts.length - 1].revision || null
        : null;
      // Require at least one recorded attempt with a revision
      if (!currentRevision) {
        throw Object.assign(new Error('No recorded implementation attempt with revision'), { code: 'STALE_REVISION' });
      }
      if (review.revision !== currentRevision) {
        throw Object.assign(new Error(`Stale review: revision ${review.revision} does not match current implementation revision ${currentRevision}`), { code: 'STALE_REVISION' });
      }

      if (!Array.isArray(review.findings)) {
        throw Object.assign(new Error('findings must be an array'), { code: 'INVALID_REVIEW' });
      }

      // Reject fail verdict with empty findings (nothing for repairer to act on)
      if (review.verdict === 'fail' && review.findings.length === 0) {
        throw Object.assign(new Error('fail verdict requires at least one finding'), { code: 'INVALID_REVIEW' });
      }

      // Validate findings: all fields required, whitespace-only rejected
      for (const finding of review.findings) {
        if (!finding || typeof finding !== 'object') {
          throw Object.assign(new Error('Each finding must be an object'), { code: 'INVALID_FINDING' });
        }
        if (!finding.severity || String(finding.severity).trim() === '') {
          throw Object.assign(new Error('severity is required'), { code: 'INVALID_REVIEW' });
        }
        if (!['info', 'minor', 'important', 'critical'].includes(finding.severity)) {
          throw Object.assign(new Error(`Invalid severity: ${finding.severity}`), { code: 'INVALID_FINDING' });
        }
        if (!finding.category || String(finding.category).trim() === '') {
          throw Object.assign(new Error('category is required'), { code: 'INVALID_REVIEW' });
        }
        if (!finding.location || String(finding.location).trim() === '') {
          throw Object.assign(new Error('location is required'), { code: 'INVALID_REVIEW' });
        }
        if (!finding.problem || String(finding.problem).trim() === '') {
          throw Object.assign(new Error('problem is required'), { code: 'INVALID_REVIEW' });
        }
        if (!finding.requiredOutcome || String(finding.requiredOutcome).trim() === '') {
          throw Object.assign(new Error('requiredOutcome is required'), { code: 'INVALID_REVIEW' });
        }
      }

      // Assign unique immutable IDs to findings and freeze
      const now = new Date().toISOString();
      const acceptedFindings = Object.freeze(
        review.findings.map((f, idx) => {
          const id = `finding-${Date.now()}-${idx}-${crypto.randomUUID().slice(0, 8)}`;
          return Object.freeze({
            id,
            severity: f.severity,
            category: f.category,
            location: f.location,
            problem: f.problem,
            requiredOutcome: f.requiredOutcome,
          });
        })
      );

      // Compute hasBlocking once from acceptedFindings
      const hasBlocking = acceptedFindings.some((f) => f.severity === 'important' || f.severity === 'critical');

      // Derive state from verdict AND blocking severity
      let newState;
      if (review.verdict === 'pass') {
        if (hasBlocking) {
          throw Object.assign(new Error('pass verdict with blocking findings is invalid'), { code: 'INVALID_REVIEW' });
        }
        newState = 'APPROVED';
      } else {
        // fail verdict: always route to REPAIR
        newState = 'REPAIR';
      }

      // Build and freeze review record
      const reviewRecord = Object.freeze({
        id: crypto.randomUUID(),
        sessionId,
        verdict: review.verdict,
        revision: review.revision,
        findings: acceptedFindings,
        submittedAt: now,
        stale: false,
      });

      // Append review to append-only array
      const changeReviews = this.#reviews.get(changeId) ?? [];
      changeReviews.push(reviewRecord);
      this.#reviews.set(changeId, changeReviews);
      this.#dirtyReviews.add(changeId);

      // Transition the change
      const before = c.state;
      c.transitionTo(newState);

      await reseedFromDisk(this.#file);
      this.#audit.push({
        eventId: nextEventId(),
        changeId,
        from: before,
        to: newState,
        ts: c.updatedAt,
      });

      await this.#persist();

      return Object.freeze({
        ...reviewRecord,
        state: newState,
      });
    } finally {
      release();
    }
  }

  /**
   * Retrieve the persisted (latest) review for a Change.
   * Returns stale=true when current implementation revision differs from review.revision.
   */
  async getReview(changeId) {
    const release = await acquireLock(this.#file);
    try {
      await this.#refreshChange(changeId);
      const c = this.#changes.get(changeId);
      if (!c) throw Object.assign(new Error(`Change ${changeId} not found`), { code: 'NOT_FOUND' });
      const reviews = this.#reviews.get(changeId);
      if (!reviews || reviews.length === 0) throw Object.assign(new Error(`No review found for change ${changeId}`), { code: 'NOT_FOUND' });

      // Get latest review
      const latest = reviews[reviews.length - 1];
      const result = structuredClone(latest);

      // Check staleness: compare review.revision with current implementation revision
      const attempts = this.#attempts.get(changeId) ?? [];
      const currentRevision = attempts.length > 0 ? (attempts[attempts.length - 1].revision || null) : null;
      if (currentRevision && latest.revision && currentRevision !== latest.revision) {
        result.stale = true;
      }

      return result;
    } finally {
      release();
    }
  }

  /**
   * List all review records for a Change, ordered by submission time.
   */
  async listReviews(changeId) {
    const release = await acquireLock(this.#file);
    try {
      await this.#refreshChange(changeId);
      const c = this.#changes.get(changeId);
      if (!c) throw Object.assign(new Error(`Change ${changeId} not found`), { code: 'NOT_FOUND' });
      const reviews = this.#reviews.get(changeId) ?? [];
      return structuredClone(reviews);
    } finally {
      release();
    }
  }

  // ─── Repair Cycle Support ───────────────────────────────────────────────────

  /**
   * Get repair context for a change in REPAIR state.
   * Returns unresolved findings, repair claims, and related state.
   */
  async getRepairContext(changeId) {
    const release = await acquireLock(this.#file);
    try {
      await this.#refreshChange(changeId);
      const c = this.#changes.get(changeId);
      if (!c) throw Object.assign(new Error(`Change ${changeId} not found`), { code: 'NOT_FOUND' });

      // Get all reviews to find original findings
      const reviews = this.#reviews.get(changeId) ?? [];
      const allFindings = reviews.flatMap((r) => r.findings ?? []);

      // Get repair claims
      const claims = this.#repairClaims.get(changeId) ?? [];

      // Unresolved findings: filter to blocking severities
      // (fixing records a claim but does not close the reviewer finding)
      const unresolvedFindings = allFindings.filter((f) => f.severity === 'important' || f.severity === 'critical');

      // Get current revision from attempts
      const attempts = this.#attempts.get(changeId) ?? [];
      const revision = attempts.length > 0 ? (attempts[attempts.length - 1].revision || null) : null;

      // Get repair proof if available (prefer canonical #proofs, fallback to #repairProofs)
      const repairProof = this.#proofs.get(changeId) ?? this.#repairProofs.get(changeId) ?? null;

      // Get preflight state
      const preflightResults = this.#preflightResults.get(changeId);
      const preflight = preflightResults
        ? { state: c.state, controllerResults: preflightResults }
        : { state: c.state };

      return {
        state: c.state,
        unresolvedFindings: structuredClone(unresolvedFindings),
        repairClaims: structuredClone(claims),
        originalFindings: structuredClone(allFindings),
        revision,
        proof: repairProof ? structuredClone(repairProof) : null,
        preflight,
      };
    } finally {
      release();
    }
  }

  /**
   * Submit a repair after review. Validates finding IDs, records claims, requires proof.
   * @param {string} changeId
   * @param {object} repair
   * @param {Array<{findingId: string, status: string, claim: string}>} repair.findings
   * @param {object} repair.proof
   * @param {{workerId: string}} [opts]
   * @returns {{state: string}}
   */
  async submitRepair(changeId, repair, opts = {}) {
    const release = await acquireLock(this.#file);
    try {
      await this.#refreshChange(changeId);
      const c = this.#changes.get(changeId);
      if (!c) throw Object.assign(new Error(`Change ${changeId} not found`), { code: 'NOT_FOUND' });

      if (c.state !== 'REPAIR') {
        throw Object.assign(new Error(`Cannot submit repair: change is in ${c.state}, expected REPAIR`), { code: 'INVALID_STATE' });
      }

      // Validate repair structure
      if (!repair || typeof repair !== 'object') {
        throw Object.assign(new Error('Repair is required'), { code: 'INVALID_REPAIR' });
      }
      // findings and proof are required for repair-cycle ACs
      if (!Array.isArray(repair.findings)) {
        throw Object.assign(new Error('findings is required and must be an array'), { code: 'INVALID_REPAIR' });
      }
      if (!repair.proof || typeof repair.proof !== 'object') {
        throw Object.assign(new Error('proof is required'), { code: 'INVALID_REPAIR' });
      }

      // Validate proof structure - require beforeRevision and afterRevision (mandatory)
      if (!repair.proof.beforeRevision || typeof repair.proof.beforeRevision !== 'string') {
        throw Object.assign(new Error('proof.beforeRevision is required'), { code: 'INVALID_PROOF' });
      }
      if (!repair.proof.afterRevision || typeof repair.proof.afterRevision !== 'string') {
        throw Object.assign(new Error('proof.afterRevision is required'), { code: 'INVALID_PROOF' });
      }

      // Get all reviews to validate finding IDs
      const reviews = this.#reviews.get(changeId) ?? [];
      const allReviewFindings = reviews.flatMap((r) => r.findings ?? []);
      const knownFindingIds = new Set(allReviewFindings.map((f) => f.id));

      // Filter to unresolved blocking findings
      const blockingFindings = allReviewFindings.filter((f) => f.severity === 'important' || f.severity === 'critical');
      const existingClaims = this.#repairClaims.get(changeId) ?? [];
      const claimedBlockingIds = new Set(existingClaims.filter((cl) => cl.status === 'fixed').map((cl) => cl.findingId));
      const unresolvedBlocking = blockingFindings.filter((f) => !claimedBlockingIds.has(f.id));

      // Require every unresolved blocking finding to have a claim
      if (unresolvedBlocking.length > 0 && repair.findings.length === 0) {
        throw Object.assign(new Error('Cannot submit empty findings while blocking findings are unresolved'), { code: 'INVALID_REPAIR' });
      }

      const unresolvedBlockingIds = new Set(unresolvedBlocking.map((f) => f.id));
      const submittedFindingIds = new Set(repair.findings.map((f) => f.findingId));
      const missingClaims = [...unresolvedBlockingIds].filter((id) => !submittedFindingIds.has(id));
      if (missingClaims.length > 0) {
        throw Object.assign(new Error(`Missing claims for blocking findings: ${missingClaims.join(', ')}`), { code: 'INVALID_REPAIR' });
      }

      // Validate each finding reference
      for (const findingRef of repair.findings) {
        if (!findingRef.findingId || typeof findingRef.findingId !== 'string') {
          throw Object.assign(new Error('Each finding ref must have a string findingId'), { code: 'INVALID_REPAIR' });
        }
        if (!knownFindingIds.has(findingRef.findingId)) {
          throw Object.assign(new Error(`Unknown finding ID: ${findingRef.findingId}`), { code: 'UNKNOWN_FINDING' });
        }
        if (!findingRef.status || typeof findingRef.status !== 'string') {
          throw Object.assign(new Error('Each finding ref must have a status'), { code: 'INVALID_REPAIR' });
        }
        if (!['fixed', 'acknowledged'].includes(findingRef.status)) {
          throw Object.assign(new Error(`Invalid finding status: ${findingRef.status}. Use 'fixed' or 'acknowledged'.`), { code: 'INVALID_REPAIR' });
        }
        // For blocking findings (important/critical), only 'fixed' is allowed
        const finding = allReviewFindings.find((f) => f.id === findingRef.findingId);
        if (finding && (finding.severity === 'important' || finding.severity === 'critical') && findingRef.status === 'acknowledged') {
          throw Object.assign(new Error(`Blocking findings (${finding.severity}) must be 'fixed', not 'acknowledged'`), { code: 'INVALID_REPAIR' });
        }
      }

      // Enforce proof newness: reject if proof equals currently stored proof
      const existingProof = this.#proofs.get(changeId);
      if (existingProof) {
        const existingJson = JSON.stringify(existingProof);
        const newJson = JSON.stringify(repair.proof);
        if (existingJson === newJson) {
          throw Object.assign(new Error('Proof must be new - cannot submit identical proof'), { code: 'STALE_PROOF' });
        }
      }

      // Require proof.beforeRevision to match reviewed revision and afterRevision to differ
      const attempts = this.#attempts.get(changeId) ?? [];
      const currentRevision = attempts.length > 0 ? (attempts[attempts.length - 1].revision || null) : null;
      if (currentRevision && repair.proof.beforeRevision !== currentRevision) {
        throw Object.assign(new Error(`proof.beforeRevision (${repair.proof.beforeRevision}) must match current revision (${currentRevision})`), { code: 'INVALID_PROOF' });
      }
      if (repair.proof.afterRevision === repair.proof.beforeRevision) {
        throw Object.assign(new Error('proof.afterRevision must differ from proof.beforeRevision'), { code: 'INVALID_PROOF' });
      }

      // ALL VALIDATION COMPLETE - now perform mutations atomically

      // Record repair claims
      const now = new Date().toISOString();
      const claims = repair.findings.map((f) => ({
        findingId: f.findingId,
        status: f.status,
        claim: f.claim || '',
        recordedAt: now,
      }));

      const changeClaims = this.#repairClaims.get(changeId) ?? [];
      const newClaims = [...changeClaims, ...claims];
      this.#repairClaims.set(changeId, newClaims);
      this.#dirtyRepairClaims.add(changeId);

      // Route proof through canonical proof store so getProof/runPreflight see it
      this.#proofs.set(changeId, structuredClone(repair.proof));
      // Also store in repair proofs for backward compatibility
      this.#repairProofs.set(changeId, structuredClone(repair.proof));

      // Transition to PREFLIGHT
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

      await this.#persist();

      return { state: c.state };
    } finally {
      release();
    }
  }
}
