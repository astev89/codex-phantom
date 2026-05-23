# Runtime Configuration

`codex-phantom` reads configuration from process environment at startup. Local development can copy `.env.example` to `.env`; Docker Compose also reads that file when present. Production startup rejects default operator, MCP, and external channel secrets, and requires `OPENAI_API_KEY`.

| Variable                       | Default                                          | Production               | Notes                                                                                            |
| ------------------------------ | ------------------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------ |
| `APP_ENV` / `NODE_ENV`         | `development`                                    | set `APP_ENV=production` | Only `development`, `test`, and `production` are recognized.                                     |
| `PORT`                         | `3210`                                           | optional                 | HTTP server port. Must be a positive integer.                                                    |
| `CODEX_PHANTOM_DATA_DIR`       | `./data`                                         | recommended              | Parent directory for local app state.                                                            |
| `CODEX_PHANTOM_DATABASE_PATH`  | `${CODEX_PHANTOM_DATA_DIR}/codex-phantom.sqlite` | recommended              | SQLite database path. Directory is created automatically.                                        |
| `LOG_LEVEL`                    | `info`                                           | optional                 | One of `debug`, `info`, `warn`, or `error`.                                                      |
| `AGENT_NAME`                   | `Codex Phantom`                                  | optional                 | Display name used by health and the operator console.                                            |
| `ROLE_CONFIG_PATH`             | `./config/roles.yaml`                            | recommended              | YAML role policy inventory used by first-run readiness checks.                                   |
| `OPERATOR_CONFIG_PATH`         | `./config/operator.yaml`                         | recommended              | YAML operator setup inventory used by first-run readiness checks.                                |
| `OPERATOR_BEARER_TOKEN`        | `dev-operator-token`                             | required non-default     | Authenticates `/admin`, console, scheduler, memory, channel, metrics, and chat APIs.             |
| `MCP_BEARER_TOKEN`             | `dev-mcp-token`                                  | required non-default     | Authenticates `/mcp` tool calls.                                                                 |
| `EXTERNAL_CHANNEL_SECRET`      | `dev-external-secret`                            | required non-default     | HMAC secret for inbound external channel webhooks.                                               |
| `REJECT_DEFAULT_SECRETS`       | `true` in production                             | keep enabled             | Set to `false` only for non-production diagnostics. Production still rejects defaults.           |
| `OPENAI_API_KEY`               | unset                                            | required                 | Enables OpenAI-backed agent and embedding calls. Without it, development uses fallback behavior. |
| `OPENAI_BASE_URL`              | unset                                            | optional                 | Override for compatible OpenAI API endpoints.                                                    |
| `OPENAI_MODEL`                 | `gpt-5`                                          | optional                 | Responses model used by the Codex adapter.                                                       |
| `OPENAI_CONVERSATION_MODE`     | `previous_response_id`                           | optional                 | Set `manual` to avoid previous-response chaining.                                                |
| `OPENAI_REQUEST_TIMEOUT_MS`    | `60000`                                          | optional                 | Positive integer timeout for Responses calls.                                                    |
| `OPENAI_EMBEDDING_MODEL`       | `text-embedding-3-small`                         | optional                 | Embedding model used for memory vectors.                                                         |
| `OPENAI_EMBEDDING_TIMEOUT_MS`  | `10000`                                          | optional                 | Positive integer timeout for embedding calls.                                                    |
| `SEMANTIC_RETRIEVAL_ENABLED`   | `true`                                           | optional                 | Set `false` to disable embedding/vector memory retrieval.                                        |
| `QDRANT_ENABLED`               | `false`                                          | recommended with Compose | Requires `QDRANT_URL` when true.                                                                 |
| `QDRANT_URL`                   | unset                                            | required if enabled      | Compose uses `http://qdrant:6333`.                                                               |
| `QDRANT_API_KEY`               | unset                                            | optional                 | Qdrant API key for secured deployments.                                                          |
| `QDRANT_COLLECTION_NAME`       | `codex-phantom-memory`                           | optional                 | Must not be blank.                                                                               |
| `QDRANT_TIMEOUT_MS`            | `5000`                                           | optional                 | Positive integer timeout for vector store calls.                                                 |
| `SLACK_BOT_TOKEN`              | unset                                            | optional                 | Required for outbound Slack sends and inbound Slack thread replies.                              |
| `SLACK_APP_TOKEN`              | unset                                            | optional                 | Reserved for future Slack app-level flows.                                                       |
| `SLACK_SIGNING_SECRET`         | unset                                            | optional                 | Required for `POST /channels/slack/events`.                                                      |
| `SLACK_BOT_USER_ID`            | unset                                            | optional                 | Bot user id used to strip `<@bot>` mentions and ignore self-authored Slack events.               |
| `EMAIL_IMAP_HOST`              | unset                                            | optional                 | Required with the other Email vars only when the Email channel is enabled.                       |
| `EMAIL_IMAP_PORT`              | `993`                                            | optional                 | Positive integer IMAP port. Defaults to the TLS IMAP port.                                       |
| `EMAIL_IMAP_USERNAME`          | unset                                            | optional                 | Mailbox username for bounded inbound polling.                                                    |
| `EMAIL_IMAP_PASSWORD`          | unset                                            | optional                 | Mailbox password or provider app password for IMAP auth.                                         |
| `EMAIL_IMAP_TLS`               | `true`                                           | optional                 | Set `false` only for providers that require plaintext IMAP on a trusted network.                 |
| `EMAIL_SMTP_HOST`              | unset                                            | optional                 | Required with the other Email vars only when the Email channel is enabled.                       |
| `EMAIL_SMTP_PORT`              | `587`                                            | optional                 | Positive integer SMTP port. Defaults to STARTTLS-friendly submission.                            |
| `EMAIL_SMTP_USERNAME`          | unset                                            | optional                 | SMTP username for threaded agent replies.                                                        |
| `EMAIL_SMTP_PASSWORD`          | unset                                            | optional                 | SMTP password or provider app password.                                                          |
| `EMAIL_SMTP_TLS`               | `true`                                           | optional                 | Set `false` only for providers that require plaintext SMTP on a trusted network.                 |
| `EMAIL_FROM_ADDRESS`           | unset                                            | optional                 | Required sender address for agent replies when Email is enabled.                                 |
| `EMAIL_FROM_NAME`              | `AGENT_NAME`                                     | optional                 | Display name for outbound replies. Defaults to the configured agent name.                        |
| `EMAIL_POLL_INTERVAL_MS`       | `30000`                                          | optional                 | Positive integer bounded polling interval for unread mail checks.                                |
| `EMAIL_POLL_BATCH_SIZE`        | `10`                                             | optional                 | Positive integer cap for each IMAP poll batch.                                                   |
| `EMAIL_MAX_MESSAGE_BYTES`      | `1048576`                                        | optional                 | Positive integer cap for accepted raw message size.                                              |
| `EMAIL_MAX_ATTACHMENT_BYTES`   | `200000`                                         | optional                 | Positive integer cap for attachment text extraction and metadata indexing.                       |
| `EMAIL_SEND_TIMEOUT_MS`        | `10000`                                          | optional                 | Positive integer timeout for outbound SMTP sends.                                                |
| `MEMORY_EMBEDDING_BATCH_SIZE`  | `8`                                              | optional                 | Positive integer batch size for embedding backfills.                                             |
| `MEMORY_TOP_K`                 | `12`                                             | optional                 | Positive integer semantic retrieval result count.                                                |
| `MEMORY_PER_CATEGORY_LIMIT`    | `3`                                              | optional                 | Positive integer category cap for memory query responses.                                        |
| `MEMORY_SUMMARY_LIMIT`         | `2`                                              | optional                 | Positive integer summary count returned with memory.                                             |
| `MEMORY_SUMMARY_TRIGGER_COUNT` | `6`                                              | optional                 | Positive integer threshold for summary generation.                                               |
| `MEMORY_SUMMARY_CLUSTER_SIZE`  | `4`                                              | optional                 | Positive integer grouping size for summary generation.                                           |
| `DEFAULT_RUN_TIMEOUT_MS`       | `30000`                                          | optional                 | Positive integer fallback run timeout.                                                           |
| `DEFAULT_MAX_TOOL_CALLS`       | `6`                                              | optional                 | Positive integer fallback tool-call cap.                                                         |

## Failure Behavior

Startup fails fast when integer fields are non-positive, role/config paths are blank, required secrets are blank, `QDRANT_ENABLED=true` lacks `QDRANT_URL`, production lacks `OPENAI_API_KEY`, or production/default-secret rejection finds `replace-me` or development defaults.

## Email Channel Notes

The Email channel is present in the runtime registry but disabled by default. Enabling it requires a complete IMAP and SMTP configuration together: `EMAIL_IMAP_HOST`, `EMAIL_IMAP_USERNAME`, `EMAIL_IMAP_PASSWORD`, `EMAIL_SMTP_HOST`, `EMAIL_SMTP_USERNAME`, `EMAIL_SMTP_PASSWORD`, and `EMAIL_FROM_ADDRESS`.

This parity slice is intentionally bounded. Polling uses `EMAIL_POLL_INTERVAL_MS` and `EMAIL_POLL_BATCH_SIZE` rather than a long-lived IMAP IDLE session, and message or attachment processing is capped by `EMAIL_MAX_MESSAGE_BYTES` and `EMAIL_MAX_ATTACHMENT_BYTES`.

For hosted providers, prefer provider-specific app passwords or mailbox credentials with the minimum required scope instead of reusing a personal login password.
