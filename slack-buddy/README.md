# Slack Buddy

Slack Buddy is a private, personalized Slack assistant for a Developer Advocate
at Mistral. It passively ingests messages from channels the Slack app can
access, learns from explicit feedback, answers questions in DM, and sends a
source-linked daily briefing.

## Architecture

```text
Slack Events API
    |
    v
Cloudflare Worker + Chat SDK Slack adapter
    |-- channel messages, edits, deletes --> D1
    |-- owner DM --------------------------> Slack Buddy Think agent
    `-- feedback actions ------------------> profile memory

Hourly scheduler (minute 17)
    |-- expire raw messages and recover pending jobs
    |-- refresh the shared Slack directory when its 24-hour cache expires
    `-- after 08:00 Europe/Paris, start the previous day's digest
                                  |
                                  v
Independent Cloudflare Workflow instances, linked by a D1 job ledger
    |-- checkpoint up to 10 sync phases per instance; join up to 50 channels per batch
    |-- reconcile recent history and active replies; periodically audit older parents
    |-- group messages into threads
    |-- apply must-show and low-signal rules
    |-- batch-rank with zai-glm-5-2 on Mistral's API
    |-- synthesize a source-grounded digest
    `-- post or update the owner's Slack DM
```

Slack Buddy uses three separate state stores:

- D1 stores retained Slack messages, digest runs, and the durable job ledger.
- `ChatStateDO` stores Chat SDK locks, deduplication, and subscriptions.
- `SlackBuddyAgent` stores the user's Think conversation and relevance profile.

Raw Slack messages in D1 expire after 14 days by default. Hourly cleanup runs
before Slack requests, independently of digest delivery. Digests, profile versions,
and feedback remain available for learning and auditing. Completed job chains and
their temporary artifacts are removed after the same retention interval; active
chains are retained for recovery.

"Learning" means versioned preference memory, not model fine-tuning. Relevant
and not-relevant feedback adds bounded examples to the user's profile; handled
items are recorded without changing topic preferences. In DM, you can also ask
Slack Buddy to remember current priorities, add watched topics, or adjust
relevance thresholds.

## Current scope

- One Slack workspace and one authorized user per deployment.
- Cross-channel search is only exposed through that user's DM with Slack Buddy.
- Channel messages are ingested but Slack Buddy does not reply in public
  channels.
- Direct mentions are always considered for the daily digest.
- Required mentions survive synthesis and the usual 15-item limit. Larger
  briefings are delivered in multiple Slack messages with per-item feedback.
- Slack Buddy automatically joins every non-archived public channel it is
  permitted to join. Directory refreshes run at most once per 24 hours by default.
- Private channels must explicitly invite the Slack Buddy app.
- Files and message attachments are not ingested in the first version.

## Prerequisites

- Node.js 22 or newer
- A Cloudflare account on **Workers Paid**
- A Slack app approved for the target workspace
- A Mistral API key with access to `zai-glm-5-2`

## Install

From the monorepo root:

```bash
npm install
cp slack-buddy/.env.example slack-buddy/.env
```

Set local secrets in `slack-buddy/.env`:

```dotenv
SLACK_BOT_TOKEN="xoxb-..."
SLACK_SIGNING_SECRET="..."
SLACK_USER_ID="U..."
MISTRAL_API_KEY="..."
```

`.env` is for local Wrangler development only. It is gitignored and is not
uploaded by a push or by Cloudflare Workers Builds. Configure the same values
as Worker runtime secrets before production use.

The non-secret defaults are in `wrangler.jsonc`:

- Timezone: `Europe/Paris`
- Digest eligibility: `08:00`; the hourly cron normally starts delivery at
  approximately `08:17`
- Auto-join public channels: enabled
- Raw-message retention: 14 days
- Slack reconciliation overlap: 48 hours
- Directory cache: 24 hours
- Full history audit interval: 7 days per channel
- Sync phases per Workflow instance: 10 (configurable from 1 to 20)
- Channel membership batch: up to 50 channels
- CPU limit: 30 seconds; subrequest limit: 10,000
- Model: `zai-glm-5-2`

## Create the Slack app

1. Open the Slack app management page and create an app from
   `slack-manifest.bootstrap.json`. This version does not require a live webhook.
2. Install the app to the workspace.
3. Copy the Bot User OAuth Token and Signing Secret.
4. Set `SLACK_USER_ID` to the only Slack member allowed to use the assistant.
5. After deploying Slack Buddy, replace `YOUR-WORKER` in
   `slack-manifest.json` with the deployed Worker subdomain and apply that full
   manifest.
6. Invite Slack Buddy to every private channel it should monitor. Public
   channels are joined automatically unless Slack restricts app membership.

The app requests:

- Message history plus channel and user directory data
- DM access for the interactive assistant
- `chat:write` for answers and daily briefings
- `users:read` for attribution

## Create Cloudflare resources

Run the Cloudflare commands in this section from `slack-buddy/`.

The Cloudflare resource names are:

- Worker: `slack-buddy`
- D1 database: `slack-buddy-db`
- Workflow: `slack-buddy-digest`
- Durable Object agent class: `SlackBuddyAgent`

Create D1 and replace the placeholder `database_id` in `wrangler.jsonc`:

```bash
cd slack-buddy
npx wrangler d1 create slack-buddy-db
```

Copy the returned database ID into `wrangler.jsonc`, replacing
`00000000-0000-0000-0000-000000000000`, then apply the schema:

```bash
npm run db:migrate:remote
```

Deployments do not apply D1 migrations automatically. Run the remote migration
command once during initial setup and whenever a future release adds a
migration.

Store production secrets:

```bash
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put SLACK_USER_ID
npx wrangler secret put MISTRAL_API_KEY
npx wrangler secret list
```

These are runtime secrets. If using the dashboard, add them under the
`slack-buddy` Worker's **Settings > Variables & Secrets**, not only under its
build settings. The final command should list all four names without exposing
their values.

## Deploy

For a manual deployment from `slack-buddy/`:

```bash
npm run deploy
```

For automatic deployment with Cloudflare Workers Builds, create a separate
build configuration for the `slack-buddy` Worker. Keep the repository root as
the build root so npm uses the monorepo lockfile, and configure:

- Production branch: `main`
- Build command: leave empty
- Deploy command:
  `npm run deploy --workspace @buddy/slack-buddy`
- Runtime secrets: configure them under **Settings > Variables & Secrets**

The Changelog Buddy build is a separate Worker and does not deploy Slack Buddy.
Optional build watch paths can limit Slack Buddy deployments to changes under
`slack-buddy/` plus the root `package.json` and `package-lock.json`.

## Activate Slack webhooks

After the first successful deployment:

1. Confirm the health endpoint responds:

   ```bash
   curl "https://<your-worker>.workers.dev/health"
   ```

   The response should contain `"name":"Slack Buddy"` and `"status":"ok"`.

2. Replace both `YOUR-WORKER` placeholders in `slack-manifest.json` with the
   deployed Worker hostname. Both resulting request URLs should be:

   ```text
   https://<your-worker>.workers.dev/webhooks/slack
   ```

3. Apply the full JSON manifest to the existing Slack app. Confirm that Slack
   verifies the Events API and interactivity request URLs.
4. Reinstall or request approval again only if Slack indicates that the
   manifest change requires it.
5. Invite Slack Buddy to every private channel it should monitor. Public
   channels are discovered and joined when the directory cache next refreshes
   (checked hourly at minute `17`), subject to workspace restrictions.

## Verify production

Run this checklist after the full Slack manifest is active. Run the Wrangler
commands below from `slack-buddy/`.

1. DM Slack Buddy from the member identified by `SLACK_USER_ID`. It should
   answer; messages from other members are intentionally ignored.
2. After Slack Buddy has joined a public channel, post a harmless test message
   there.
3. Confirm that the message reached D1:

   ```bash
   npx wrangler d1 execute slack-buddy-db --remote \
     --command "SELECT COUNT(*) AS message_count FROM slack_messages"
   ```

4. Inspect runtime logs if either test fails:

   ```bash
   npx wrangler tail slack-buddy
   ```

5. Confirm the next briefing arrives after approximately `08:17`
   `Europe/Paris`. It summarizes the previous local calendar day.

## Upgrade and recover a missed briefing

The pipeline requires `0002_bounded_jobs.sql` for the job ledger and
`0003_incremental_sync.sql` for directory caching and history coverage. From
`slack-buddy/`, apply migrations **before** deploying the new Worker:

```bash
npm run db:migrate:remote
npm run deploy
```

On the next hourly tick at minute `17`, the scheduler queues new bounded jobs
for unfinished digests, including failed runs from older dates. Their digest IDs
and Slack delivery markers stay the same, but their Workflow instance IDs change.
Restarting an old monolithic Workflow keeps its old deployed code and does not
apply this fix. The scheduler waits for any still-running old instance to finish
before migrating that digest, preventing overlapping old and new pipelines.

Inspect overall progress in D1; the latest Workflow instance represents just one
job, so its completion alone no longer proves that the briefing was delivered:

```bash
npx wrangler d1 execute slack-buddy-db --remote --command \
  "SELECT id, local_date, status, workflow_instance_id, error FROM digest_runs ORDER BY local_date DESC LIMIT 5"
npx wrangler d1 execute slack-buddy-db --remote --command \
  "SELECT id, run_key, sequence, status, error FROM slack_jobs WHERE status != 'completed' ORDER BY updated_at LIMIT 25"
```

Use a returned job ID to inspect the failing instance:

```bash
npx wrangler workflows instances describe slack-buddy-digest <job-id>
```

The digest's `completed` status means all its Slack message parts were delivered.
Recovery can only use raw messages still inside the retention window.

Existing `free-v1` job IDs remain valid: that prefix identifies the ledger protocol,
not the Cloudflare plan. Existing Workflow instances remain pinned to their deployed
code; new instances use the new deployment. Completed work and delivery markers
are preserved. Each channel needs an initial full audit to establish the new scan
coverage before later digests can use incremental history.

The Paid configuration uses `SLACK_BUDDY_JOB_PHASES` (default `10`, maximum `20`),
`SLACK_BUDDY_DIRECTORY_REFRESH_HOURS` (default `24`), and
`SLACK_BUDDY_FULL_SCAN_DAYS` (default `7`). Smaller phase counts reduce the retry
scope of a Workflow instance; larger counts reduce instance and ledger overhead.
Slack's own rate limits still apply.

## Local development

Apply the local migration and start Wrangler:

```bash
npm run db:migrate:local
npm run dev
```

Slack cannot call localhost directly. Use a secure tunnel for webhook testing,
or deploy a development Worker and point a separate Slack test app at it.

To exercise the scheduled handler locally, start Wrangler with
`npm run dev -- --test-scheduled`, then request
`http://localhost:8787/__scheduled`.

## Troubleshooting

- `invalid_auth`: verify the production `SLACK_BOT_TOKEN`.
- Slack request-signature failures: verify `SLACK_SIGNING_SECRET`.
- Missing-table errors: apply the remote D1 migrations, including
  `0002_bounded_jobs.sql` for the job ledger and `0003_incremental_sync.sql`
  for directory and history sync state.
- `Too many subrequests by single Worker invocation` on an old digest instance:
  upgrade to the bounded job pipeline and follow the recovery steps above.
  Workers Free permits 50 external requests per invocation; extra Workflow steps
  alone do not create a new allowance. See Cloudflare's
  [Workflow limits](https://developers.cloudflare.com/workflows/reference/limits/).
- DMs receive no answer: verify the full manifest's `message.im` subscription,
  the request URL, and `SLACK_USER_ID`.
- Public messages are absent from D1: confirm the app joined the channel and
  that `message.channels` is subscribed.
- Private messages are absent from D1: invite the app to the private channel
  and confirm `message.groups` is subscribed.
- Workflow or model errors: inspect `npx wrangler tail slack-buddy` and confirm
  `MISTRAL_API_KEY` and model access.

## Reliability model

- Slack event writes are idempotent by workspace, channel, and message
  timestamp.
- Ingestion preserves Slack's raw mention identifiers alongside message text.
- Chat SDK dispatches overlapping messages concurrently; D1 timestamps and
  unique keys make those writes order-independent and idempotent.
- Edits and deletions update existing D1 rows.
- Each digest has a stable digest ID; each job has its own deterministic
  `slack-buddy-free-v1-<run-hash>-<sequence>` Workflow instance ID.
- The D1 job ledger stores each successor atomically with its predecessor's
  completion, before Workflow creation. The scheduler recovers a pending
  successor if that creation fails, without repeating completed parent work.
- One instance checkpoints up to 10 sync phases by default, each performing
  one directory/history/replies page or up to 50 membership operations. Model
  batches, synthesis, and delivery remain separate jobs. Successful phase
  checkpoints are reused when a later phase retries.
- Each sync phase permits one Workflow retry and two transport retries per
  Slack request. The maximum configuration of 20 phases therefore bounds
  external requests at 6,000 per instance, below the configured Paid limit of
  10,000. Delivery has no immediate Workflow retry; failures wait for recovery.
- A successful directory refresh publishes a reusable snapshot of accessible
  channels and refreshes users. Digests reuse that snapshot for 24 hours by
  default; the hourly scheduler also skips fresh snapshots. A run keeps its
  chosen snapshot across retries and restarts, even if the cache later expires.
  Published channel snapshots are immutable, and replaying their jobs does not
  renew their freshness. Concurrent cold starts may both refresh before either
  publishes a snapshot.
- Unchanged user/channel upserts and duplicate or older message updates do
  not rewrite rows. Message ordering watermarks still advance when needed to
  protect against out-of-order edits. History reads do not create synthetic
  webhook audit rows. Genuine webhook event IDs remain deduplicated.
- History coverage advances only after all pages for a channel succeed.
  Ordinary scans use a 48-hour overlap behind the previous completed scan,
  extending back to the digest window when needed and bounded by raw-message
  retention. Bounds are persisted for retries and concurrent runs.
- Initial and periodic full audits scan older parents too, without storing raw
  text outside retention. The default audit interval is seven days. Webhook
  replies on older parents seed reconciliation targets on every digest. A missed
  webhook reply to an older parent outside the overlap may only be discovered
  by the next full audit; it is not guaranteed to appear in the next daily digest.
- Cached conversations that become inaccessible and threads that have been
  deleted are skipped without advancing their history coverage. Authentication,
  scope, and other unexpected failures remain retryable job failures.
- Job payloads and history checkpoints contain identifiers and cursors, not
  copies of raw source messages. Ranking reloads only the selected batch's
  threads using indexed thread lookups, with retained earlier context, instead
  of scanning all retained messages for each batch.
- Active threads include retained context from before the briefing window;
  mentions in that earlier context do not trigger another required item.
- Ranked item IDs are derived from validated sources, so independent model
  batches cannot collide and exchange source links during synthesis.
- Before posting, delivery searches recent DM history for Slack Buddy's
  deterministic Block Kit marker and updates an existing digest instead of
  reposting. Every part of a multi-message digest has its own marker, allowing
  recovery after only some parts have been delivered. Delivered page references
  are stored in D1. A durable write-intent marker makes recovery restart its
  history search from the newest message if Slack accepted a write but its
  response was lost.
- The hourly reconciler checks all unfinished digest runs, including older
  dates and runs checked before the next delivery time, in bounded sweeps of
  up to 25 digest runs and 25 jobs. Only one hourly directory chain is active
  at a time, and a new refresh starts only when the cache is stale. Cron itself
  only calls Slack for authentication; directory scans
  and joins run in their own jobs.
- Slack history reconciliation repairs webhook gaps before every digest.
- Slack Web API requests are intercepted to use Cloudflare's supported
  `cache: "no-store"` mode; Axios `1.20.0` otherwise sends the unsupported
  `cache: "default"` value.
- Workflow API calls validate Slack's `ok` field, including HTTP-200 errors,
  and retry explicit rate limits twice while honoring `Retry-After`. Ambiguous
  failed writes are left to digest delivery recovery instead of blindly reposted.
- Feedback reads the current profile after external I/O and persists its next
  version without yielding, preserving overlapping feedback and explicit edits.

## Security model

- Only `SLACK_USER_ID` can interact with Slack Buddy or submit learning
  feedback.
- Cross-channel retrieval is DM-only.
- Slack text is treated as untrusted data.
- Digest ranking uses structured output without agent tools.
- Interactive Think turns use an allowlist of search, digest, profile, and
  explicit preference-update tools.
- Raw message text is deleted on the configured retention schedule.
- Secrets live in Wrangler secrets and are never committed.

Before using Slack Buddy with corporate Slack, confirm that storing Slack
content in Cloudflare D1 and sending selected content to Mistral's API is
approved.

## Commands

From the monorepo root:

```bash
npm run typecheck
npm test
npm run check
npm run deploy:dry-run:slack
```

This configuration targets Workers Paid. The subscription includes larger
allowances, but Workflow steps, D1/Durable Objects operations, and CPU usage can
incur charges above included amounts. Directory caching, incremental history,
and larger jobs reduce repeated work. Mistral model usage is billed separately
unless covered by your account.
