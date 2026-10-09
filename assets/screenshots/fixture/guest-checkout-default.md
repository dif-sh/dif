---
id: guest-checkout-default
status: active
owner: maya@example.com
surface: checkout
hypothesis: >
  Mobile shoppers abandon at the sign-in wall. Opening checkout in guest
  mode, with sign-in as a link, lifts completed checkouts on mobile.
audience:
  include:
    - device_type: mobile
variants:
  - id: control
    weight: 50
    summary: Sign-in screen first, guest checkout as a link
  - id: guest_first
    weight: 50
    summary: Guest checkout first, sign-in as a link
metrics:
  primary: completed_checkout
  guardrails: [account_signup, refund_rate]
exclusion_group: checkout
created: 2026-09-22
---

## Brief

Hold at 50/50 for two full weeks. Ship `guest_first` if completed checkouts rise and signups hold.
