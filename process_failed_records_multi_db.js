import pkg from 'pg';
import Mailgun from 'mailgun.js';
import formData from 'form-data';

const { Pool } = pkg;

/* ===========================
   CONFIG
=========================== */

const MAX_EMAIL_RECORDS = 50; // safety limit

const {
  DATABASE_URL,       // Central Notification DB (A-DB)
  MAILGUN_API_KEY,
  MAILGUN_DOMAIN,
  ALERT_EMAIL_TO,
  NODE_ENV = 'production'
} = process.env;

if (!DATABASE_URL || !MAILGUN_API_KEY || !MAILGUN_DOMAIN || !ALERT_EMAIL_TO) {
  console.error('Missing required environment variables');
}

/*
 * Configuration convention:
 *
 * database_url_<app_name>_<dbid>
 * schema_<app_name>_<dbid>_<salesforceOrgID>
 *
 * Example:
 *
 * database_url_app1_db1 = <production DB URL>
 * schema_app1_db1_salesforceOrg1 = salesforce
 * schema_app1_db1_salesforceOrg2 = salesforce
 *
 * database_url_app1_db2 = <production DB URL>
 * schema_app1_db2_salesforceOrg3 = salesforce
 *
 * database_url_app2_db1 = <production DB URL>
 * schema_app2_db1_salesforceOrg4 = salesforce
 *
 * Production DB credentials are used READ-ONLY.
 * DATABASE_URL is used for the central Notification DB (A-DB).
 */

/* ===========================
   DATABASE CONNECTIONS
=========================== */

// Central Notification DB (A-DB) - READ/WRITE
const notificationPool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL?.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

// Production DB pools - READ ONLY
const sourcePools = new Map();

function getSourcePool(appName, dbId, databaseUrl) {
  const poolKey = `${appName}_${dbId}`;

  if (!sourcePools.has(poolKey)) {
    sourcePools.set(
      poolKey,
      new Pool({
        connectionString: databaseUrl,
        ssl: databaseUrl.includes('localhost')
          ? false
          : { rejectUnauthorized: false }
      })
    );
  }

  return sourcePools.get(poolKey);
}

/* ===========================
   MAILGUN
=========================== */

const mailgun = new Mailgun(formData);

const mg = mailgun.client({
  username: 'api',
  key: MAILGUN_API_KEY
});

const FROM_EMAIL =
  `Mailgun Sandbox <postmaster@${MAILGUN_DOMAIN}>`;

/* ===========================
   CONFIG DISCOVERY
=========================== */

function validateIdentifier(value) {
  if (!/^[A-Za-z0-9_]+$/.test(value)) {
    throw new Error(`Invalid identifier: ${value}`);
  }

  return value;
}

function loadSourceConfig() {
  const sources = [];

  for (const key of Object.keys(process.env)) {

    if (!key.startsWith('schema_')) {
      continue;
    }

    /*
     * Expected Config Var name:
     *
     * schema_<app_name>_<dbid>_<salesforceOrgID>
     *
     * Example:
     *
     * schema_app1_db1_salesforceOrg1
     */

    const match = key.match(
      /^schema_(.+)_(.+)_(salesforceOrg[^_]+)$/
    );

    if (!match) {
      console.warn(
        `Ignoring invalid schema Config Var: ${key}`
      );

      continue;
    }

    const [
      ,
      appName,
      dbId,
      salesforceOrgId
    ] = match;

    /*
     * Corresponding database Config Var:
     *
     * database_url_<app_name>_<dbid>
     */

    const databaseUrlKey =
      `database_url_${appName}_${dbId}`;

    const databaseUrl =
      process.env[databaseUrlKey];

    if (!databaseUrl) {
      console.warn(
        `Missing ${databaseUrlKey} for ${key}; source will be skipped`
      );

      continue;
    }

    /*
     * Config Var value contains the actual
     * Heroku Connect schema name.
     */

    const sourceSchema =
      process.env[key];

    if (!sourceSchema) {
      console.warn(
        `Empty schema value for ${key}; source will be skipped`
      );

      continue;
    }

    sources.push({
      appName: validateIdentifier(appName),
      dbId: validateIdentifier(dbId),
      salesforceOrgId:
        validateIdentifier(salesforceOrgId),
      sourceSchema:
        validateIdentifier(sourceSchema),
      databaseUrl
    });
  }

  return sources;
}

/* ===========================
   A-DB PROVISIONING
=========================== */

async function ensureNotificationSchema(
  salesforceOrgId
) {
  /*
   * A-DB schema is identified by Salesforce Org ID.
   *
   * Example:
   *
   * salesforceOrg1.failed_records
   */

  const schema =
    validateIdentifier(salesforceOrgId);

  await notificationPool.query(`
    CREATE SCHEMA IF NOT EXISTS "${schema}";
  `);

  await notificationPool.query(`
      CREATE TABLE IF NOT EXISTS "${schema}".failed_records (
        id BIGSERIAL PRIMARY KEY,
        trigger_log_id BIGINT NOT NULL,
        txid BIGINT,
        created_at TIMESTAMP,
        updated_at TIMESTAMP,
        processed_at TIMESTAMP,
        processed_tx BIGINT,
        state TEXT,
        action TEXT,
        table_name TEXT,
        record_id TEXT,
        sfid TEXT,
        old TEXT,
        values TEXT,
        sf_result TEXT,
        sf_message TEXT,
        notified BOOLEAN DEFAULT FALSE,
        UNIQUE (trigger_log_id, updated_at)
      );
  `);
}

/* ===========================
   SOURCE DB - READ ONLY
=========================== */

async function fetchFailedRecords(
  sourcePool,
  sourceSchema
) {
  const schema =
    validateIdentifier(sourceSchema);

  const sql = `
    SELECT
      id AS trigger_log_id,
      txid,
      created_at,
      updated_at,
      processed_at,
      processed_tx,
      state,
      action,
      table_name,
      record_id,
      sfid,
      old,
      values,
      sf_result,
      sf_message
    FROM "${schema}"._trigger_log
    WHERE state = 'FAILED';
  `;

  const result =
    await sourcePool.query(sql);

  return result.rows;
}

/* ===========================
   A-DB - INSERT
=========================== */

async function insertFailedRecords(
  targetSchema,
  rows
) {
  if (!rows || rows.length === 0) {
    return 0;
  }

  const schema =
    validateIdentifier(targetSchema);

  let inserted = 0;

  await notificationPool.query('BEGIN');

  try {

    const sql = `
      INSERT INTO "${schema}".failed_records
      (
        trigger_log_id,
        txid,
        created_at,
        updated_at,
        processed_at,
        processed_tx,
        state,
        action,
        table_name,
        record_id,
        sfid,
        old,
        values,
        sf_result,
        sf_message
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12,
        $13,
        $14,
        $15
      )
      ON CONFLICT (trigger_log_id, updated_at)
      DO NOTHING;
    `;

    for (const row of rows) {

      const result =
        await notificationPool.query(
          sql,
          [
            row.trigger_log_id,
            row.txid,
            row.created_at,
            row.updated_at,
            row.processed_at,
            row.processed_tx,
            row.state,
            row.action,
            row.table_name,
            row.record_id,
            row.sfid,
            row.old,
            row.values,
            row.sf_result,
            row.sf_message
          ]
        );

      inserted += result.rowCount;
    }

    await notificationPool.query('COMMIT');

    return inserted;

  } catch (error) {

    await notificationPool.query(
      'ROLLBACK'
    );

    throw error;
  }
}

/* ===========================
   A-DB - FETCH UNNOTIFIED
=========================== */

async function fetchUnnotifiedRecords(
  targetSchema
) {
  const schema =
    validateIdentifier(targetSchema);

  const sql = `
    SELECT *
    FROM "${schema}".failed_records
    WHERE notified = false
    ORDER BY created_at ASC
    LIMIT $1;
  `;

  const result =
    await notificationPool.query(
      sql,
      [MAX_EMAIL_RECORDS]
    );

  return result.rows;
}

/* ===========================
   A-DB - MARK NOTIFIED
=========================== */

async function markAsNotified(
  targetSchema,
  failedRecordIds
) {
  if (
    !failedRecordIds ||
    failedRecordIds.length === 0
  ) {
    return;
  }

  const schema =
    validateIdentifier(targetSchema);

  const sql = `
    UPDATE "${schema}".failed_records
    SET notified = true
    WHERE id = ANY($1);
  `;

  await notificationPool.query(
    sql,
    [failedRecordIds]
  );
}

/* ===========================
   HTML EMAIL BUILDER
=========================== */

function buildHtmlEmail(
  source,
  rows
) {

  const tableRows = rows.map(
    r => `
    <tr>
      <td>${r.trigger_log_id}</td>
      <td>${r.txid || 'N/A'}</td>
      <td>${r.table_name}</td>
      <td>${r.action}</td>
      <td>${r.record_id}</td>
      <td>${r.sfid || 'N/A'}</td>
      <td>${r.sf_result || 'N/A'}</td>

      <td
        style="max-width:300px; word-wrap:break-word;"
      >
        ${r.sf_message || 'N/A'}
      </td>

      <td
        style="
          max-width:300px;
          word-wrap:break-word;
          font-size:11px;
        "
      >
        ${r.values || 'N/A'}
      </td>

      <td>
        ${new Date(
          r.updated_at
        ).toLocaleString()}
      </td>
    </tr>
  `
  ).join('');

  return `
  <div
    style="
      font-family: Arial, sans-serif;
      color:#333;
    "
  >

    <h2 style="color:#d32f2f;">
      Heroku Connect – FAILED Sync Alert
    </h2>

    <p>

      <strong>Environment:</strong>
      ${NODE_ENV}<br/>

      <strong>Application:</strong>
      ${source.appName}<br/>

      <strong>Database:</strong>
      ${source.dbId}<br/>

      <strong>Salesforce Org:</strong>
      ${source.salesforceOrgId}<br/>

      <strong>Source Schema:</strong>
      ${source.sourceSchema}<br/>

      <strong>Total Failed Records:</strong>
      ${rows.length}

    </p>

    <table
      border="1"
      cellpadding="6"
      cellspacing="0"
      style="
        border-collapse:collapse;
        width:100%;
        font-size:12px;
      "
    >

      <thead style="background:#f5f5f5;">

        <tr>
          <th>Trigger Log ID</th>
          <th>TXID</th>
          <th>Table</th>
          <th>Action</th>
          <th>Record ID</th>
          <th>SFID</th>
          <th>Error Code</th>
          <th>Error Message</th>
          <th>Values</th>
          <th>Failed At</th>
        </tr>

      </thead>

      <tbody>
        ${tableRows}
      </tbody>

    </table>

    <p
      style="
        margin-top:15px;
        font-size:12px;
        color:#777;
      "
    >
      This is an automated alert from your
      centralized Heroku application.
    </p>

  </div>
  `;
}

/* ===========================
   MAILGUN
=========================== */

async function sendEmail(
  source,
  rows,
  htmlBody
) {

  await mg.messages.create(
    MAILGUN_DOMAIN,
    {

      from: FROM_EMAIL,

      to: [
        ALERT_EMAIL_TO
      ],

      subject:
        `Heroku Connect Sync Failures – ` +
        `${source.appName} / ` +
        `${source.dbId} / ` +
        `${source.salesforceOrgId} – ` +
        `${rows.length} record(s)`,

      text:
        `Heroku Connect sync failures detected ` +
        `for ${source.appName} / ` +
        `${source.dbId} / ` +
        `${source.salesforceOrgId}: ` +
        `${rows.length} record(s).`,

      html: htmlBody
    }
  );
}

/* ===========================
   PROCESS ONE SOURCE
=========================== */

async function processSource(
  source
) {

  const sourcePool =
    getSourcePool(
      source.appName,
      source.dbId,
      source.databaseUrl
    );

  console.log(
    `\n=== Processing ` +
    `${source.appName} / ` +
    `${source.dbId} / ` +
    `${source.salesforceOrgId} ===`
  );

  console.log(
    `Source Application: ${source.appName}`
  );

  console.log(
    `Source Database: ${source.dbId}`
  );

  console.log(
    `Source Salesforce Org: ` +
    `${source.salesforceOrgId}`
  );

  console.log(
    `Source Schema: ${source.sourceSchema}`
  );

  /*
   * A-DB schema is identified by Salesforce Org ID.
   */

  const targetSchema =
    source.salesforceOrgId;

  /*
   * Ensure A-DB schema/table exists.
   */

  await ensureNotificationSchema(
    targetSchema
  );

  /*
   * READ ONLY operation
   * against Production DB.
   */

  const failedRows =
    await fetchFailedRecords(
      sourcePool,
      source.sourceSchema
    );

  console.log(
    `Found ${failedRows.length} ` +
    `FAILED record(s) in production source`
  );

  /*
   * WRITE operation only
   * against A-DB.
   */

  const insertedCount =
    await insertFailedRecords(
      targetSchema,
      failedRows
    );

  console.log(
    `Inserted ${insertedCount} new ` +
    `FAILED record(s) into A-DB ` +
    `schema ${targetSchema}`
  );

  /*
   * Retrieve unnotified records
   * from A-DB.
   */

  const rows =
    await fetchUnnotifiedRecords(
      targetSchema
    );

  if (
    !rows ||
    rows.length === 0
  ) {

    console.log(
      `No new unnotified FAILED records ` +
      `found in A-DB schema ${targetSchema}`
    );

    return;
  }

  console.log(
    `${rows.length} unnotified ` +
    `FAILED record(s) detected`
  );

  const htmlBody =
    buildHtmlEmail(
      source,
      rows
    );

  const failedRecordIds =
    rows.map(
      r => r.id
    );

  console.log(
    'Sending Mailgun notification...'
  );

  try {

    await sendEmail(
      source,
      rows,
      htmlBody
    );

    console.log(
      '\x1b[1m\x1b[32m' +
      'Email sent successfully' +
      '\x1b[0m'
    );

    console.log(
      'Marking records as notified...'
    );

    /*
     * UPDATE only on A-DB.
     */

    await markAsNotified(
      targetSchema,
      failedRecordIds
    );

    console.log(
      `Marked ${failedRecordIds.length} ` +
      `record(s) as notified`
    );

  } catch (mailError) {

    /*
     * Mail issues must NEVER crash the dyno.
     *
     * Records remain:
     *
     * notified = false
     *
     * and will be retried during
     * the next Scheduler execution.
     */

    console.error(
      '⚠ Mailgun error (non-fatal)'
    );

    console.error(
      mailError.message
    );

    console.error(
      'Status:',
      mailError.status
    );
  }
}

/* ===========================
   MAIN
=========================== */

async function run() {

  const sources =
    loadSourceConfig();

  console.log(
    `Found ${sources.length} ` +
    `configured source(s)`
  );

  if (
    sources.length === 0
  ) {

    console.warn(
      'No source schemas configured. ' +
      'Nothing to process.'
    );

    return;
  }

  try {

    for (
      const source of sources
    ) {

      try {

        await processSource(
          source
        );

      } catch (
        sourceError
      ) {

        /*
         * One source failure must not
         * prevent other configured
         * applications, databases,
         * or Salesforce Orgs from
         * processing.
         */

        console.error(
          `Failed processing ` +
          `${source.appName} / ` +
          `${source.dbId} / ` +
          `${source.salesforceOrgId}`
        );

        console.error(
          sourceError
        );
      }
    }

  } catch (err) {

    console.error(
      '\x1b[1m\x1b[31m' +
      'Error while processing FAILED records' +
      '\x1b[0m'
    );

    console.error(
      err
    );

  } finally {

    /*
     * Close all production DB pools.
     */

    for (
      const pool of sourcePools.values()
    ) {

      await pool.end();
    }

    /*
     * Close A-DB connection.
     */

    await notificationPool.end();

    console.log(
      'process_failed_records completed'
    );
  }
}

run();