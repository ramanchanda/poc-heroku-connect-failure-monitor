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



Application / SQL    Heroku Postgres DB      Heroku Connect                        Salesforce                      Scheduler / Worker           Mailgun
        |                     |                    |                                   |                                        |                   |
        | INSERT / UPDATE     |                    |                                   |                                        |                   |
        |-------------------->|                    |                                   |                                        |                   |
        |                     |  Row written       |                                   |                                        |                   |
        |                     |------------------->|                                   |                                        |                   |
        |                     |                    | Push to SF                        |                                        |                   |
        |                     |                    |---------------------------------->|                                        |                   |
        |                     |                    |                                   | Reject (validation)                    |                   |
        |                     |                    |                                   |                                        |                   |
        |                     |                    | Write to salesforce._trigger_log  |                                        |                   |
        |                     |                    |<----------------------------------|                                        |                   |
        |                     |                    |                                   |                                        |                   |
        |                     |<-------------------|                                   |                                        |                   |
        |                     | state = FAILED     |                                   |                                        |                   |
        |                     |                    |                                   |                                        |                   |
        |                     |                    |                                   |                     (Runs every X mins)|                   |
        |                     |<------------------------------------------------------------------------------------------------|                   |
        |                     |                    |   Start job -  Checks salesforce._trigger_log for records with FAILED state|                   |
        |                     |                    |                                   |                                        |                   |
        |                     |                    |                                   |                                        |                   |
        |                     |                    |                                   |                                        |                   |
        |                     |                    |                         INSERT new FAILED records to custom.failed_records |                   |
        |                     |<------------------------------------------------------------------------------------------------|                   |
        |                     |                    |                                   |                                        |                   |
        |                     |                    |                                   |                                        |                   |
        |                     |                    |                SELECT unnotified FAILED records from custom.failed_records |                   |
        |                     |------------------------------------------------------------------------------------------------>|                   | 
        |                     |                    |                                   |                                        |                   |
        |                     |                    |                                   |                                        | Send email        |
        |                     |                    |                                   |                                        |------------------>|
        |                     |                    |                                   |                                        |                   | Deliver mail
        |                     |                    |                                   |                                        |                   |
        |                     |                    |                                   |                                        |                   |
        |                     |                    |                            UPDATE notified records in custom.failed_records|                   |
        |                     |<------------------------------------------------------------------------------------------------|                   |
        |                     |                    |                                   |                                        |                   | 
        |                     |                    |                                   |                                        |                   | 
