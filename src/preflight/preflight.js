/**
 * Deterministic preflight verification runner.
 *
 * Host-owned required checks are injected at construction and cannot be
 * overridden by worker-facing calls. The runner validates the proof bundle,
 * checks revision staleness, enforces protected paths, runs required checks,
 * and persists controller results separately from worker claims.
 */
// @ts-nocheck
import { ChangeDomainError } from '../domain/change.js';

export class PreflightRunner {
  /**
   * @param {import('../storage/change-store.js').ChangeStore} store
   * @param {object} options
   * @param {Array<{name: string, command?: string, env?: object, cwd?: string}>} options.requiredChecks
   * @param {string[]} [options.protectedPaths=[]]
   */
  constructor(store, { requiredChecks, protectedPaths = [] } = {}) {
    this.#store = store;
    this.#requiredChecks = structuredClone(requiredChecks ?? []);
    this.#protectedPaths = structuredClone(protectedPaths ?? []);
    // Map check-name → check-def for O(1) lookup during validation.
    this.#checksByName = new Map();
    for (const check of this.#requiredChecks) {
      this.#checksByName.set(check.name, check);
    }
  }

  #store;
  #requiredChecks;
  #protectedPaths;
  #checksByName;

  /**
   * Run deterministic preflight verification for a Change.
   *
   * @param {string} changeId
   * @param {object} params
   * @param {string} params.currentRevision — current workspace revision
   * @param {string[]} params.changedFiles — files changed since proof
   * @param {Array<{name: string, passed: boolean, exitCode?: number}>} params.checkResults — results from controller-required checks
   * @returns {Promise<{allowed: boolean, state: string, preflight: object}>}
   */
  async run(changeId, { currentRevision, changedFiles, checkResults } = {}) {
    // 1. Load the change and verify it is in PREFLIGHT.
    const change = await this.#store.get(changeId);
    if (change.state !== 'PREFLIGHT') {
      throw Object.assign(
        new Error(`Change ${changeId} is in ${change.state}, expected PREFLIGHT`),
        { code: 'INVALID_STATE', changeId }
      );
    }

    // 2. Load the proof bundle — mandatory for preflight to succeed.
    let proof;
    try {
      proof = await this.#store.getProof(changeId);
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

    // 4. Protected-path check: no allowed changed file may be in protectedPaths.
    const violation = (changedFiles ?? []).find((f) => this.#protectedPaths.includes(f));
    if (violation) {
      throw Object.assign(
        new Error(`Protected path changed: ${violation}`),
        { code: 'PROTECTED_PATH_CHANGED', changeId, protectedPath: violation }
      );
    }

    // 5. Required-checks filtering: only run checks whose name is in the
    //    host-owned requiredChecks list.
    const filtered = this.#requiredChecks
      .map((def) => {
        const result = (checkResults ?? []).find((r) => r.name === def.name);
        return result ?? { name: def.name, passed: false, exitCode: 1 };
      });

    // 6. Any failure blocks REVIEW and is durable (state stays PREFLIGHT).
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
      command: this.#checksByName.get(r.name)?.command ?? null,
      passed: r.passed,
      exitCode: r.exitCode ?? 0,
    }));

    // Store controllerPreflight on the change record; keep proof.workerChecks untouched.
    change._controllerPreflightResults = persistedResults;
    await this.#store._persist();

    // 8. Transition PREFLIGHT → REVIEW.
    try {
      change.transitionTo('REVIEW');
    } catch (err) {
      if (err instanceof ChangeDomainError) throw err;
      throw err;
    }
    await this.#store._persist();

    return {
      allowed: true,
      state: change.state,
      preflight: { controllerResults: persistedResults, status: 'PASSED' },
    };
  }

  /**
   * Read-only status probe: returns persisted preflight result or null.
   * @param {string} changeId
   * @returns {Promise<object|null>}
   */
  async getStatus(changeId) {
    const change = await this.#store.get(changeId);
    if (change.state !== 'REVIEW' && change.state !== 'PREFLIGHT') {
      return null;
    }
    const results = change._controllerPreflightResults;
    if (!results) return null;
    return { allowed: true, results, state: change.state };
  }
}

/**
 * Factory function: create a preflight policy object compatible with ChangeStore.
 * @param {object} options
 * @param {Array<string>} options.requiredChecks
 * @param {string[]} [options.protectedPaths=[]]
 * @returns {{requiredChecks: string[], protectedPaths: string[]}}
 */
export function createPreflightPolicy({ requiredChecks, protectedPaths = [] } = {}) {
  return {
    requiredChecks: Array.isArray(requiredChecks) ? requiredChecks : [],
    protectedPaths: Array.isArray(protectedPaths) ? protectedPaths : [],
  };
}
