CREATE TABLE IF NOT EXISTS payment_idempotency (
    idempotency_key text PRIMARY KEY,
    fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
    response_status smallint,
    response_body text,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    CHECK (
        (completed_at IS NULL AND response_status IS NULL AND response_body IS NULL)
        OR (
            completed_at IS NOT NULL
            AND response_status IS NOT NULL
            AND response_status IN (200, 402, 503)
            AND response_body IS NOT NULL
            AND jsonb_typeof(response_body::jsonb) = 'object'
        )
    )
);

CREATE INDEX IF NOT EXISTS payment_idempotency_pending_created_at
    ON payment_idempotency (created_at)
    WHERE completed_at IS NULL;
