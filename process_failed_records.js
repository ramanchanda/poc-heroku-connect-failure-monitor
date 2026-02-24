import pkg from 'pg';
import Mailgun from 'mailgun.js';
import formData from 'form-data';

const { Pool } = pkg;

/* ===========================
   DATABASE CONFIG
=========================== */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

/* ===========================
   MAILGUN CONFIG
=========================== */
const mailgun = new Mailgun(formData);
const mg = mailgun.client({
  username: 'api',
  key: process.env.MAILGUN_API_KEY
});

const DOMAIN = process.env.MAILGUN_DOMAIN;
const TO_EMAIL = process.env.ALERT_EMAIL_TO;
const FROM_EMAIL = `alerts@${DOMAIN}`;

/* ===========================
   SQL QUERIES
=========================== */
const INSERT_FAILED_SQL = `
INSERT INTO custom.failed_records (trigger_log_id, txid, created_at, updated_at, processed_at, processed_tx, state, action, table_name, record_id, sfid, old, values, sf_result, sf_message)
SELECT id, txid, created_at, updated_at, processed_at, processed_tx, state, action, table_name, record_id, sfid, old, values, sf_result, sf_message
FROM salesforce._trigger_log
WHERE state = 'FAILED'
AND id NOT IN (
  SELECT trigger_log_id FROM custom.failed_records
);
`;

const FETCH_UNNOTIFIED_SQL = `
SELECT *
FROM custom.failed_records
WHERE notified = false
ORDER BY created_at DESC;
`;

const MARK_NOTIFIED_SQL = `
UPDATE custom.failed_records
SET notified = true
WHERE notified = false;
`;

/* ===========================
   MAIN PROCESS
=========================== */
async function run() {
  const client = await pool.connect();

  try {
    console.log('Syncing FAILED records from _trigger_log...');
    await client.query(INSERT_FAILED_SQL);

    console.log('Fetching unnotified failures...');
    const { rows } = await client.query(FETCH_UNNOTIFIED_SQL);

    if (rows.length === 0) {
      console.log('No new FAILED records found');
      return;
    }

    console.log(`${rows.length} FAILED records detected`);

    const emailBody = rows.map(r => `
Table        : ${r.table_name}
Action       : ${r.action}
Record ID    : ${r.record_id}
SFID         : ${r.sfid || 'N/A'}
Error Code   : ${r.sf_result}
Error Message:
${r.sf_message}

Created At   : ${r.created_at}
----------------------------------------
`).join('\n');

    console.log('Sending Mailgun notification...');
    await mg.messages.create(DOMAIN, {
      from: FROM_EMAIL,
      to: [TO_EMAIL],
      subject: `Heroku Connect FAILED sync (${rows.length} record(s))`,
      text: emailBody
    });

    console.log('Email sent. Marking records as notified...');
    await client.query(MARK_NOTIFIED_SQL);

    console.log('Processing complete');
  } catch (error) {
    console.error('Error while processing FAILED records');
    console.error(error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

run();
