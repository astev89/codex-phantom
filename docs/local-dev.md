# Local Development Runbook

Use this when you come back to the project after a few days and need the local stack running again.

## Start The Stack

```bash
npm install
npm run local:up
```

The local helper creates `.env` on first run with local development tokens, then starts Qdrant first, waits until it answers on port `6333`, and starts `codex-phantom` on port `3210`. It starts the app with Compose dependency checks bypassed after the explicit Qdrant probe, which avoids stale Compose health state blocking a rebuilt app container.

Open the operator console at `http://localhost:3210`.

Browser auth:

- username: any non-empty value
- password: the `OPERATOR_BEARER_TOKEN` value in `.env`

## Common Commands

```bash
npm run local:status
npm run local:up:build
npm run local:stop-app
npm run local:down
npm run phantom -- doctor
npm run phantom -- status
```

- `local:status` shows Compose status, app health, Qdrant health, and whether a Cloudflare tunnel process is running for `localhost:3210`.
- `local:up:build` rebuilds the app image before starting it. Use this when the browser still shows an older UI or stale runtime behavior.
- `local:stop-app` stops only the app container on port `3210`. It leaves Qdrant and any already-running Cloudflare tunnel alone.
- `local:down` stops the full Compose stack.
- `phantom -- doctor` checks local config, token presence, and service reachability.
- `phantom -- status` prints a concise operator status without opening the browser.

## Terminal Operator

Use `phantomctl` when you want to operate the local Phantom from a terminal instead of the browser console:

```bash
npm run phantom -- doctor
npm run phantom -- status
npm run phantom -- chat "review https://example.com"
npm run phantom -- runs
npm run phantom -- sessions
npm run phantom -- tools
```

The CLI reads `.env` and process environment values. Process environment wins when both are present.

- `PHANTOM_BASE_URL` defaults to `http://localhost:3210`.
- `PHANTOM_TRANSPORT` supports `auto`, `http`, or `docker`; the default is `auto`.
- `OPERATOR_BEARER_TOKEN` is loaded from `.env` or the current shell and is never printed.

`auto` tries direct HTTP first and falls back to `docker exec` against the Compose app container when the local port is not reachable from the host. Use `PHANTOM_TRANSPORT=docker` when you want to force the container path.

## Slack Tunnel

Run this in a terminal you can leave open:

```bash
npm run local:tunnel
```

When Cloudflare prints the public URL, the helper prints the Slack values to paste into the Slack app:

- Events API Request URL: `https://your-tunnel.trycloudflare.com/channels/slack/events`
- Interactivity Request URL: `https://your-tunnel.trycloudflare.com/channels/slack/interactions`

Slack also needs these `.env` values filled for real inbound replies:

- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- `SLACK_BOT_USER_ID`
- `OPENAI_API_KEY`

Enable the Slack channel before sending real Slack events:

```bash
set -a
source .env
set +a
curl -X POST http://localhost:3210/admin/channels \
  -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id":"slack","enabled":true}'
```

After Slack is configured and the tunnel is live, use the smoke script only when you want an end-to-end Slack check:

```bash
BASE_URL=https://your-tunnel.trycloudflare.com scripts/slack-tunnel-smoke.mjs
```

## If Something Looks Stale

1. Run `npm run local:status`.
2. If the app is reachable but the UI looks old, run `npm run local:up:build`.
3. If port `3210` needs to be freed while keeping the tunnel process alive, run `npm run local:stop-app`.
4. If the full Docker stack is confused, run `npm run local:down`, then `npm run local:up:build`.
