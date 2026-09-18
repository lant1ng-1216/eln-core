/**
 * ELN Core — State / Versions
 *
 * A turn is a transaction; a branch is a version reference (DESIGN §5).
 *
 * Canon carries a monotonically increasing `version`. Committed versions are
 * immutable snapshots, and `checkout` restores one. `branch` starts a new world
 * line from a version — because versions are numbered globally, commits on the
 * new line never overwrite the old line's snapshots, and no data is copied
 * between lines.
 *
 * Snapshots cover the *whole* runtime state (canon + minds + ledgers + turn
 * records), not canon alone. Restoring only canon would leave every `Mind` at
 * the newer state — a character would remember a secret that, in the restored
 * world line, had never been revealed.
 *
 * This replaces 0.1.0's `rewindTo(index)`, a grow-only array that could not
 * represent two world lines at all.
 */

let lineCounter = 0;

/** @returns {string} a fresh world-line id */
function nextLineId() {
  lineCounter += 1;
  return `line_${lineCounter}`;
}

/**
 * Accept either a full state bundle or a bare Canon and normalize it.
 * @param {object} state
 */
function normalizeState(state) {
  if (state && typeof state === 'object' && 'canon' in state) {
    return {
      canon: structuredClone(state.canon),
      minds: state.minds ? structuredClone(state.minds) : new Map(),
      ledgers: structuredClone(state.ledgers ?? { events: [], seeds: [] }),
      turnRecords: structuredClone(state.turnRecords ?? []),
    };
  }
  return {
    canon: structuredClone(state),
    minds: new Map(),
    ledgers: { events: [], seeds: [] },
    turnRecords: [],
  };
}

/**
 * @typedef {Object} VersionEntry
 * @property {number} version
 * @property {string} lineId
 * @property {number} turn
 * @property {number} parentVersion
 * @property {{canon: object, minds: Map, ledgers: object, turnRecords: Array}} state
 */

export class VersionStore {
  /**
   * @param {object} state - A state bundle, or a bare Canon
   */
  constructor(state) {
    const normalized = normalizeState(state);

    /** @type {Map<number, VersionEntry>} */
    this._entries = new Map();
    this._lineId = nextLineId();
    this._head = normalized.canon.version;

    this._entries.set(this._head, {
      version: this._head,
      lineId: this._lineId,
      turn: normalized.canon.turn,
      parentVersion: -1,
      state: normalized,
    });
  }

  get head() { return this._head; }
  get lineId() { return this._lineId; }

  /** Cloned Canon at the head version. */
  get headCanon() {
    return structuredClone(this._entries.get(this._head).state.canon);
  }

  /** Cloned full state at the head version. */
  get headState() {
    return structuredClone(this._entries.get(this._head).state);
  }

  /**
   * Commit a new state as a child of `parentVersion` (default: current head).
   * The assigned version is `maxVersion + 1`, so it is unique across all lines.
   *
   * @param {object} state - Full state bundle, or a bare Canon
   * @param {number} [parentVersion]
   * @returns {number} the new version number
   */
  commit(state, parentVersion = this._head) {
    const normalized = normalizeState(state);
    const version = Math.max(...this._entries.keys()) + 1;
    normalized.canon.version = version;

    this._entries.set(version, {
      version,
      lineId: this._lineId,
      turn: normalized.canon.turn,
      parentVersion,
      state: normalized,
    });
    this._head = version;
    return version;
  }

  /**
   * Start a new world line from `from` (default: current head).
   * Nothing is deleted — the previous line's versions remain checkable.
   *
   * @param {number} [from]
   * @returns {{lineId: string, version: number}}
   */
  branch(from = this._head) {
    if (!this._entries.has(from)) {
      throw new Error(`[ELN] Cannot branch: unknown version ${from}`);
    }
    this._lineId = nextLineId();
    this._head = from;
    return { lineId: this._lineId, version: from };
  }

  /**
   * Move the head to `version`, restoring that snapshot.
   * @returns {{canon: object, minds: Map, ledgers: object, turnRecords: Array}}
   */
  checkout(version) {
    const entry = this._entries.get(version);
    if (!entry) throw new Error(`[ELN] Unknown version ${version}`);
    this._head = version;
    this._lineId = entry.lineId;
    return structuredClone(entry.state);
  }

  /** The ancestry chain from `version` back to the root. */
  history(version = this._head) {
    const chain = [];
    let cur = this._entries.get(version);
    while (cur) {
      chain.push({ version: cur.version, lineId: cur.lineId, turn: cur.turn });
      cur = cur.parentVersion >= 0 ? this._entries.get(cur.parentVersion) : undefined;
    }
    return chain.reverse();
  }

  /** Every stored version, ascending. */
  versions() {
    return [...this._entries.values()]
      .map(e => ({ version: e.version, lineId: e.lineId, turn: e.turn }))
      .sort((a, b) => a.version - b.version);
  }
}
