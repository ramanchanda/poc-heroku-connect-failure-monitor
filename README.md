# poc-heroku-connect-failure-monitor

salesforce._trigger_log
        │
        │ SELECT state='FAILED'
        ▼
custom.failed_records
        │
        │ WHERE notified = false
        ▼
SendGrid/Mailgun Email
        │
        ▼
UPDATE notified = true




Application / SQL        Postgres DB        Heroku Connect        Salesforce        Scheduler / Worker        Mailgun
        |                     |                    |                   |                     |                   |
        | INSERT / UPDATE     |                    |                   |                     |                   |
        |-------------------->|                    |                   |                     |                   |
        |                     |  Row written       |                   |                     |                   |
        |                     |------------------->|                   |                     |                   |
        |                     |                    | Push to SF        |                     |                   |
        |                     |                    |------------------>|                     |                   |
        |                     |                    |                   | Reject (validation) |
        |                     |                    |<------------------|                     |                   |
        |                     |                    | Write trigger log |
        |                     |<-------------------|                   |                     |
        |                     | state = FAILED     |                   |                     |
        |                     |                    |                   |                     |
        |                     |                    |                   |                     | (every 10 mins)   |
        |                     |                    |                   |                     |------------------>|
        |                     |                    |                   |                     | Start job         |
        |                     |                    |                   |                     |                   |
        |                     |                    |                   |                     | INSERT new FAILED |
        |                     |<-------------------------------------------------------------|
        |                     | custom.failed_records                                       |
        |                     |                    |                   |                     |
        |                     |                    |                   |                     | SELECT unnotified |
        |                     |<-------------------------------------------------------------|
        |                     |                    |                   |                     |                   |
        |                     |                    |                   |                     | Send email        |
        |                     |                    |                   |                     |------------------------------->|
        |                     |                    |                   |                     |                   | Deliver mail
        |                     |                    |                   |                     |                   |
        |                     |                    |                   |                     | UPDATE notified   |
        |                     |<------------------
