# Feedback receiver

The desktop form posts to its local `/api/feedback` route, which validates and relays only the form fields to `https://docuflex.eu/api/feedback`. The desktop keeps the message in the form if sending fails, and shows success only after the central receiver returns a receipt ID.

The receiver runs as the separate `docuflex-feedback` Docker service on the Docuflex host. Traefik routes only the exact HTTPS `/api/feedback` path to it. It does not serve a feedback inbox or files over HTTP and does not modify or restart the website container.

- Deployment: `/home/max/docuflex-feedback/compose.yaml`
- Receiver code: `/home/max/docuflex-feedback/receiver/`
- Persistent submissions: `/var/lib/docuflex/feedback/YYYY-MM-DD.jsonl`
- Submitted fields: category, message, optional email, version and desktop/web platform. The server adds an ID and timestamp.
- Documents, API keys and diagnostic logs are not attached. Addresses are hashed with an ephemeral salt only for the in-memory rate limit and are not written to submissions.
- Files have mode `0600` under a directory owned by the service user. The receiver periodically removes old daily files.

Read feedback through SSH:

```sh
ssh docuflex 'sudo cat /var/lib/docuflex/feedback/*.jsonl'
```

To update the receiver, copy `scripts/feedback-server.mjs`, `src/lib/server/feedback.js` and `desktop/feedback-compose.yaml` to the matching paths above, then run `docker compose up -d --force-recreate` in `/home/max/docuflex-feedback/`. The website container can remain running.

For a new installation, first create `/var/lib/docuflex/feedback` with owner `65532:65532` and mode `0700`; see `feedback-compose.yaml` for the runtime configuration. Feedback deployment is independent of a public Docuflex release.
