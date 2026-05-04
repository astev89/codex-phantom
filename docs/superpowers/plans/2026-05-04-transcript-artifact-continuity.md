# Transcript And Artifact Continuity Implementation Plan

Goal: add durable continuity for Codex chat operations without cloning Phantom's full browser chat protocol.

## Summary

Implement file-backed chat attachments, explicit generated artifacts, session detail summaries, and authenticated download APIs. Keep the current versioned SSE envelope stable.

## Implementation

- Store uploaded chat blobs under `CODEX_PHANTOM_DATA_DIR/chat-blobs/` using generated IDs, not user filenames.
- Extend `chat_attachments` with nullable `storage_path` and `sha256` so legacy metadata-only rows remain readable.
- Add `chat_artifacts` for explicit artifact records linked to sessions and optional runs.
- Add authenticated APIs for attachment upload/download, artifact creation/download, session continuity summaries, and `scope=chat` operator export metadata.
- Update `/chat` to upload files for existing sessions, show attachment/artifact links, and preserve metadata fallback for brand-new first messages.

## Verification

```bash
node --experimental-strip-types --test tests/server.test.ts
npm run typecheck
npm test
npm run build
git diff --check
```

## Deferred

- Automatic artifact extraction from tool events.
- Searchable attachment contents.
- Service-worker push and offline transcript cache.
- Phantom's full 32-event browser wire protocol.
