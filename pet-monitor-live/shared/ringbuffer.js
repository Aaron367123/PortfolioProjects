/**
 * Fixed-capacity ring buffer: O(1) push, oldest item overwritten when full.
 * Keeps the "live window" in memory with a hard memory bound regardless of uptime.
 */
export class RingBuffer {
  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new RangeError('capacity must be a positive integer');
    this.capacity = capacity;
    this.items = new Array(capacity);
    this.start = 0; // index of the oldest item
    this.length = 0;
  }

  push(item) {
    const end = (this.start + this.length) % this.capacity;
    this.items[end] = item;
    if (this.length < this.capacity) this.length++;
    else this.start = (this.start + 1) % this.capacity; // overwrote the oldest
  }

  /** i = 0 is the oldest item. */
  at(i) {
    if (i < 0 || i >= this.length) return undefined;
    return this.items[(this.start + i) % this.capacity];
  }

  latest() {
    return this.at(this.length - 1);
  }

  /** The newest n items, oldest first. */
  last(n = this.length) {
    const count = Math.min(n, this.length);
    const out = new Array(count);
    for (let i = 0; i < count; i++) out[i] = this.at(this.length - count + i);
    return out;
  }

  toArray() {
    return this.last(this.length);
  }

  clear() {
    this.start = 0;
    this.length = 0;
  }
}
