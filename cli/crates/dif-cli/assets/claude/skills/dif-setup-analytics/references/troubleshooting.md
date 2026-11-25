# When events do not arrive

Read `status` from `dif site check --json` first. The counts below mean something only when `status` is `seen`. Then read `refused_last_hour`.

| Field above 0 | Cause | Fix |
|---|---|---|
| `origin` | The page's origin is not in the key's list. | `dif site setup --env <env> --origin <exact origin> --json`. Test keys take only local origins. |
| `gates` | Site analytics is off, or the key is wrong for the env. | Do the key check in Step 2, item 3 of the skill: compare `prefix` with the key the page sends. If they differ, ask the person for the full key from Settings → Site. Check the live key is in production and the test key locally. |
| `rate` | The rate limit or the spend cap. | Tell the person. Do not raise it yourself. |
| `bad_request` | The page URL is over 8,192 bytes or is not http(s). | Find the page with very long query strings. |

No refusals and `accepted_last_hour` is 0, or `status` is `unknown_key`: the request did not leave the browser. Check, in this order:

1. The change is deployed to the host you are checking.
2. `data-domains` lists that hostname.
3. The CSP allows `cdn.dif.sh` and `ingest.difdb.com`. For product tracks with a user id, it also allows the `events.url` origin from `dif/config.yaml` (default `https://cloud.dif.sh`).
4. A pinned script has `crossorigin="anonymous"` and the hash for that version.
5. `data-consent="required"` is holding events: the CMP has not called `dif.consent(true)`.
6. `data-respect-dnt="true"` and the browser sends Do Not Track or GPC.
7. The script is not on the page twice. The second copy does nothing, but a wrong key on the first copy wins.

Page views arrive but one event is missing from `dif events --plan`:

- That code path has not run since the deploy. Ask the person to do the action once.
- The name differs. Compare the `dif.track()` call with the plan, byte for byte.
- The track has no user id and `anonymous` is off. The SDK drops it.
- The page uses the SDK in `mode: custom`. Those events go to the person's own handlers.
- The event was sent with the test key. `dif events` shows live events only.
