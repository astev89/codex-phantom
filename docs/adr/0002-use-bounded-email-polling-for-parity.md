# Use Bounded Email Polling for Parity

Email channel parity will start with bounded IMAP polling rather than Phantom's long-lived IMAP IDLE loop. This preserves the operator-facing Email capability while fitting `codex-phantom`'s production-safe feature bar: bounded work per cycle, simpler restart and shutdown behavior, clearer recovery, and easier operator visibility. IMAP IDLE can be added later if polling proves insufficient for real deployments.
