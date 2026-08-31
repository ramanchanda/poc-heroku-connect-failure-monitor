CREATE SCHEMA IF NOT EXISTS custom;

CREATE TABLE IF NOT EXISTS custom.failed_records (
    id BIGSERIAL PRIMARY KEY,
    trigger_log_id BIGINT NOT NULL,
    txid BIGINT,
    created_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE,
    processed_at TIMESTAMP WITH TIME ZONE,
    processed_tx BIGINT,
    state VARCHAR(8),
    action VARCHAR(7),
    table_name VARCHAR(128),
    record_id INTEGER,
    sfid VARCHAR(18),
    old TEXT,
    values TEXT,
    sf_result INTEGER,
    sf_message TEXT,
    notified BOOLEAN DEFAULT FALSE,
    archived_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    UNIQUE (trigger_log_id, updated_at)
);


CREATE INDEX IF NOT EXISTS failed_records_notified_idx
ON custom.failed_records (notified);