import type { Pool } from "pg";

export interface StoredResponse {
  status: number;
  body: string;
}

export type Claim =
  | { kind: "acquired" | "pending" | "conflict" }
  | { kind: "replay"; response: StoredResponse };

export interface IdempotencyStore {
  claim(key: string, fingerprint: string): Promise<Claim>;
  complete(key: string, response: StoredResponse): Promise<void>;
  check(): Promise<void>;
}

export class StorageUnavailable extends Error {}

interface PaymentRow {
  fingerprint: string;
  response_status: number | null;
  response_body: string | null;
}

export class PostgresIdempotencyStore implements IdempotencyStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async claim(key: string, fingerprint: string): Promise<Claim> {
    try {
      const inserted = await this.#pool.query(
        `INSERT INTO payment_idempotency (idempotency_key, fingerprint)
         VALUES ($1, $2)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [key, fingerprint],
      );
      if (inserted.rowCount === 1) return { kind: "acquired" };

      // A separate statement sees the winner's committed row even if INSERT had to wait.
      const {
        rows: [existing],
      } = await this.#pool.query<PaymentRow>(
        `SELECT fingerprint, response_status, response_body
         FROM payment_idempotency WHERE idempotency_key = $1`,
        [key],
      );
      if (!existing) throw new Error("Idempotency record disappeared.");
      if (existing.fingerprint !== fingerprint) return { kind: "conflict" };
      if (
        existing.response_status === null ||
        existing.response_body === null
      ) {
        return { kind: "pending" };
      }
      return {
        kind: "replay",
        response: {
          status: existing.response_status,
          body: existing.response_body,
        },
      };
    } catch (cause) {
      throw new StorageUnavailable("Could not claim idempotency key.", {
        cause,
      });
    }
  }

  async complete(key: string, response: StoredResponse): Promise<void> {
    try {
      const result = await this.#pool.query(
        `UPDATE payment_idempotency
         SET response_status = $2, response_body = $3, completed_at = now()
         WHERE idempotency_key = $1 AND completed_at IS NULL`,
        [key, response.status, response.body],
      );
      if (result.rowCount !== 1)
        throw new Error("No pending record was updated.");
    } catch (cause) {
      throw new StorageUnavailable("Could not record payment outcome.", {
        cause,
      });
    }
  }

  async check(): Promise<void> {
    await this.#pool.query(
      "SELECT idempotency_key, fingerprint, response_status, response_body FROM payment_idempotency LIMIT 0",
    );
  }
}
