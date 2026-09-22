/**
 * The uploaded workbooks, held in memory so a draft import can be re-planned
 * after a rule change without asking for the file again (#45).
 *
 * They are held only while they can still be used: a committed or deleted
 * batch never re-plans, and an upload nobody came back to is dropped after
 * a few hours. Kept for the life of the process, the bytes of every sheet
 * ever imported stayed until the next deploy.
 *
 * Losing one early costs an upload, never data: the batch and its reviewed
 * items are in the database, and the re-plan says so ("upload it again").
 */
const HOUR_MS = 60 * 60 * 1000;

export class UploadCache {
  constructor({ ttlMs = 6 * HOUR_MS, maxEntries = 20, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
  }

  set(id, buffer) {
    this.entries.delete(id);                       // re-insert, so it counts as the newest
    this.entries.set(id, { buffer, at: this.now() });
    this.sweep();
    // Still too many uploads in flight: drop the oldest, which is the one
    // least likely to be re-planned.
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
    return this;
  }

  get(id) {
    this.sweep();
    return this.entries.get(id)?.buffer;
  }

  delete(id) {
    return this.entries.delete(id);
  }

  /** Forget uploads older than the time to live. */
  sweep() {
    const oldest = this.now() - this.ttlMs;
    for (const [id, entry] of this.entries) {
      if (entry.at <= oldest) this.entries.delete(id);
    }
  }

  get size() {
    return this.entries.size;
  }

  /** What the cache is holding, for the admin jobs page. */
  bytes() {
    let total = 0;
    for (const { buffer } of this.entries.values()) total += buffer.length;
    return total;
  }
}
