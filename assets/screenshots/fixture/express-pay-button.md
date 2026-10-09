---
id: express-pay-button
status: active
owner: sam@example.com
surface: checkout
hypothesis: >
  A one-tap express pay button above the card form shortens checkout
  for returning customers without raising payment failures.
variants:
  - id: "off"
    weight: 90
    summary: Card form only
  - id: "on"
    weight: 10
    summary: Express pay button above the card form
metrics:
  primary: completed_checkout
  guardrails:
    - payment_failure_rate
exclusion_group: checkout
created: 2026-10-01
---

## Brief

Flag at 10%. Ramp to 50% once payment failures hold flat for a week.
