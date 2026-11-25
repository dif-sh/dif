# Event names and props

## Names

- snake_case, the object first, then a past-tense verb: `signup_completed`, `checkout_started`, `pricing_cta_clicked`.
- Never start a name with `$`. Names like `$pageview` are built in.
- At most 128 bytes, no spaces. `dif validate` refuses others (E012).
- One name per thing. Do not add `signup` and `signup_completed` for the same moment.
- An experiment's metric name wins. If code already sends another spelling, propose one rename of the code. Never change the experiment file.
- If an experiment's metric name breaks these rules, it cannot go in the plan. Leave it out of the plan, tell the person, and expect W006 for it.

## Marketing or product

- **marketing:** an action on a public page before sign-in. Calls to action, pricing, demo requests, links into the app.
- **product:** an action in the app, usually by a signed-in user. Account created, the first key action, core actions, upgrade, invite.

## Props

- Low-cardinality strings only: `plan`, `source`, `location`, `variant`.
- Never emails, names, free text, URLs with ids, or tokens.
- Money goes in `value` and `currency`, not in props:
  `dif.track("checkout_completed", { value: 49, currency: "USD" })`.
- At most a few props per event. Each must be one the person will filter by.

## Where to fire

- Fire on success, after the server confirms. Do not fire when the button is pressed.
- Fire once per action. Check for re-renders and retries.
