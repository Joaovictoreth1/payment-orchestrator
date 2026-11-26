import { performance } from 'node:perf_hooks';

export class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

interface Entry<T> {
  fingerprint: string;
  result: Promise<T>;
  expiresAt: number;
}

export class IdempotencyStore<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly capacity: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(capacity = 1_024, ttlMs = 300_000, now = () => performance.now()) {
    this.capacity = capacity;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  run(key: string, fingerprint: string, operation: () => Promise<T>): Promise<T> {
    const now = this.now();
    for (const [existingKey, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(existingKey);
    }

    const existing = this.entries.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new HttpError(409, 'Idempotency-Key already used for a different payment.');
      }
      return existing.result;
    }
    if (this.entries.size >= this.capacity) {
      throw new HttpError(503, 'Idempotency cache is full; try again later.');
    }

    const result = Promise.resolve().then(operation);
    const entry = { fingerprint, result, expiresAt: Infinity };
    this.entries.set(key, entry);
    void result.then(
      () => { entry.expiresAt = this.now() + this.ttlMs; },
      () => { this.entries.delete(key); },
    );
    return result;
  }
}
