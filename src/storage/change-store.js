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
  for (const e of events) {
    if (e.from !== null) c.transitionTo(e.to);
  }
  const last = events[events.length - 1];
  if (last) c.updatedAt = last.ts;
  return c;
}

export class ChangeStore {
  #file;
  #changes;
  #audit;

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
    const idx = new Map();
    for (const e of (Array.isArray(data.audit) ? data.audit : [])) {
      if (!idx.has(e.changeId)) idx.set(e.changeId, []);
      idx.get(e.changeId).push(e);
    }
    this.#changes = new Map(
      (data.changes ?? []).map((c) => [c.id, rehydrate(c, idx.get(c.id) ?? [])])
    );
    this.#audit = Array.isArray(data.audit) ? data.audit : [];
  }

  /**
   * Refresh this store's view of a specific change from disk and merge back.
   * Called before transition to detect stale in-memory state.
   */
  async #refreshChange(id) {
    let data;
    try {
      data = await readJson(this.#file);
    } catch {
      return;
    }
    if (!data) return;
    const idx = new Map();
    for (const e of (Array.isArray(data.audit) ? data.audit : [])) {
      if (!idx.has(e.changeId)) idx.set(e.changeId, []);
      idx.get(e.changeId).push(e);
    }
    const diskChanges = data.changes ?? [];
    const diskAudit = Array.isArray(data.audit) ? data.audit : [];

    // Rebuild our entire state from disk to ensure consistency
    this.#changes = new Map(
      diskChanges.map((c) => [c.id, rehydrate(c, idx.get(c.id) ?? [])])
    );
    this.#audit = diskAudit;

    return this.#changes.get(id);
  }

  /**
   * Read current disk state, merge in any local mutations, and persist.
   * The write lock ensures this is atomic per file.
   */
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
    for (const [id, c] of this.#changes) mergedChanges.set(id, {
      id: c.id,
      title: c.title,
      objective: c.objective,
      acceptanceCriteria: c.acceptanceCriteria,
      risk: c.risk,
      acceptedPlanId: c.acceptedPlanId,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    });

    // Merge audit: disk events + our local new events (dedup by ts+changeId+to)
    const diskEventIds = new Set(diskAudit.map((e) => e.ts + e.changeId + e.to));
    const mergedAudit = [
      ...diskAudit,
      ...this.#audit.filter((e) => !diskEventIds.has(e.ts + e.changeId + e.to)),
    ];

    await writeJson(this.#file, { changes: [...mergedChanges.values()], audit: mergedAudit });
  }

  async create(input) {
    const release = await acquireLock(this.#file);
    try {
      const change = createChange(input);
      this.#changes.set(change.id, change);
      this.#audit.push({ changeId: change.id, from: null, to: 'DRAFT', ts: change.createdAt });
      await this.#persist();
      return change;
    } finally {
      release();
    }
  }

  async get(id) {
    const release = await acquireLock(this.#file);
    try {
      const c = this.#changes.get(id);
      if (!c) throw Object.assign(new Error(`Change ${id} not found`), { code: 'NOT_FOUND' });
      return c;
    } finally {
      release();
    }
  }

  async transition(id, nextState) {
    const release = await acquireLock(this.#file);
    try {
      // Refresh from disk to reconcile any concurrent writes before validating
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
      this.#audit.push({ changeId: id, from: before, to: nextState, ts: c.updatedAt });
      await this.#persist();
      return c;
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
}
