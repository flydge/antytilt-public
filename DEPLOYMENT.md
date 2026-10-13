# AntyTILT production deployment

The production topology is defined in `render.yaml`:

- `antytilt-web` serves the compiled React application and `/api` from one HTTPS
  origin, so authentication remains first-party and `SameSite=Strict`;
- `antytilt-rm-worker` runs BullMQ continuously and never accepts public HTTP;
- `antytilt-postgres` is the durable source of truth;
- `antytilt-redis` stores the queue, renewable account locks and heartbeats.

All resources are pinned to Frankfurt except the frontend assets, which are served
by the web service on the same origin. The Blueprint uses paid always-on plans;
review the estimated monthly price in Render before confirming creation.

## First deployment

1. Push `render.yaml` to the default GitHub branch.
2. Open the Render Blueprint creation page for this repository:
   `https://dashboard.render.com/blueprints`.
3. Connect this repository, select the default branch, review the resources
   and confirm **Deploy Blueprint**.
4. Wait until PostgreSQL, Key Value, web and worker are healthy.
5. Open `https://<web-host>/api/health/ready` and require HTTP 200.
6. Open `https://<web-host>/api/health/worker` and require `ok: true`, a recent
   `checkedAt`, the current `releaseSha` and zero failed queue jobs.
7. Register a staging user, connect BingX VST and complete the RM smoke test before
   connecting any live API key.

The Blueprint deliberately keeps `ALLOW_LIVE_TRADING=true` and
`ALLOW_LIVE_RM_AUTOMATION=true`. Live automatic exchange actions still require
the user's explicit consent in the saved RM profile. Live trigger orders are
controlled by a separate `ALLOW_LIVE_TRIGGER_ORDERS` flag.

## Health and shutdown

- `/api/health/live` checks only the API process.
- `/api/health/ready` requires PostgreSQL and Redis.
- `/api/health/worker` requires a fresh independent worker heartbeat.
- Both API and worker drain on `SIGTERM`; the worker closes BullMQ only after
  active jobs finish and account locks are released by their owners.

## Data and secrets

Render generates one shared 256-bit `CREDENTIALS_ENCRYPTION_KEY` through the
Blueprint environment group. Never replace it without a credential re-encryption
procedure. PostgreSQL and Key Value have no public IP allow-list entries.

The first deployment creates an empty production database. Local users and API
credentials are not uploaded automatically. Use an explicit encrypted migration
and retain the same credential key only if existing local data must be imported.
