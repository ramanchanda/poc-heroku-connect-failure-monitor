import pkg from 'pg';
import Mailgun from 'mailgun.js';
import formData from 'form-data';

const { Pool } = pkg;

/* ===========================
   CONFIG
=========================== */

const MAX_EMAIL_RECORDS = 50; // safety limit

const {
  DATABASE_URL,
  MAILGUN_API_KEY,
  MAILGUN_DOMAIN,
  ALERT_EMAIL_TO,
  NODE_ENV = 'production'
} = process.env;

if (!DATABASE_URL || !MAILGUN_API_KEY || !MAILGUN_DOMAIN || !ALERT_EMAIL_TO) {
  console.error(' Missing required environment variables');
}

/* ===========================
   DATABASE
=========================== */

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

/* ===========================
   MAILGUN
=========================== */

const mailgun = new Mailgun(formData);
const mg = mailgun.client({
  username: 'api',
  key: MAILGUN_API_KEY
});

const FROM_EMAIL = `alerts@${MAILGUN_DOMAIN}`;

/* ===========================
   SQL
=========================== */

const INSERT_FAILED_SQL = `
INSERT INTO custom.failed_records
(trigger_log_id, txid, created_at, updated_at, processed_at, processed_tx,
 state, action, table_name, record_id, sfid, old, values, sf_result, sf_message)
SELECT id, txid, created_at, updated_at, processed_at, processed_tx,
       state, action, table_name, record_id, sfid, old, values,
       sf_result, sf_message
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
ORDER BY created_at DESC
LIMIT $1;
`;

const MARK_NOTIFIED_SQL = `
UPDATE custom.failed_records
SET notified = true
WHERE trigger_log_id = ANY($1);
`;

/* ===========================
   HTML EMAIL BUILDER
=========================== */

function buildHtmlEmail(rows) {
  const tableRows = rows.map(r => `
    <tr>
      <td>${r.table_name}</td>
      <td>${r.action}</td>
      <td>${r.record_id}</td>
      <td>${r.sfid || 'N/A'}</td>
      <td>${r.sf_result || 'N/A'}</td>
      <td style="max-width:400px; word-wrap:break-word;">
        ${r.sf_message || 'N/A'}
      </td>
      <td>${new Date(r.created_at).toLocaleString()}</td>
    </tr>
  `).join('');

  return `
  <div style="font-family: Arial, sans-serif; color:#333;">
    <h2 style="color:#d32f2f;">
      Heroku Connect – FAILED Sync Alert
    </h2>

    <p>
      <strong>Environment:</strong> ${NODE_ENV}<br/>
      <strong>Total Failed Records:</strong> ${rows.length}
    </p>

    <table border="1" cellpadding="8" cellspacing="0"
      style="border-collapse:collapse; width:100%; font-size:13px;">
      <thead style="background:#f5f5f5;">
        <tr>
          <th>Table</th>
          <th>Action</th>
          <th>Record ID</th>
          <th>SFID</th>
          <th>Error Code</th>
          <th>Error Message</th>
          <th>Created At</th>
        </tr>
      </thead>
      <tbody>
        ${tableRows}
      </tbody>
    </table>

    <p style="margin-top:15px; font-size:12px; color:#777;">
      This is an automated alert from your Heroku application.
    </p>
  </div>
  `;
}

/* ===========================
   MAIN
=========================== */

async function run() {
  let client;

  try {
    client = await pool.connect();

    console.log('Syncing FAILED records from salesforce._trigger_log...');
    await client.query(INSERT_FAILED_SQL);

    console.log('Insert to table custom.failed_records complete...');


    console.log('Fetching unnotified FAILED records from table custom.failed_records...');
    const { rows } = await client.query(
      FETCH_UNNOTIFIED_SQL,
      [MAX_EMAIL_RECORDS]
    );

    if (!rows || rows.length === 0) {
      console.log('No new FAILED records found in table custom.failed_records');
      return;
    }

    console.log(`${rows.length} FAILED record(s) detected in table custom.failed_records`);

    const htmlBody = buildHtmlEmail(rows);
    const triggerIds = rows.map(r => r.trigger_log_id);

    console.log('Sending Mailgun notification...');

    try {
      await mg.messages.create(MAILGUN_DOMAIN, {
        from: FROM_EMAIL,
        to: [ALERT_EMAIL_TO],
        subject: `Heroku Connect Sync Failures – ${rows.length} record(s)`,
        text: `Heroku Connect sync failures detected: ${rows.length} record(s).`,
        html: htmlBody
      });

      console.log('Email sent successfully');

      console.log('Marking records as notified...');
      await client.query(MARK_NOTIFIED_SQL, [triggerIds]);
    } catch (mailError) {
      // Mail issues must NEVER crash the dyno
      console.error('⚠ Mailgun error (non-fatal)');
      console.error(mailError.message);
      console.error('Status:', mailError.status);
    }

  } catch (err) {
    console.error('Error while processing FAILED records');
    console.error(err);
  } finally {
    if (client) client.release();
    await pool.end();
    console.log('process_failed_records completed');
  }
}

run();
