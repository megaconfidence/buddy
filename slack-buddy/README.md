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
    |-- discover and join accessible public channels
    `-- after 08:00 Europe/Paris, start the previous day's digest
                                  |
                                  v
Cloudflare Workflow
    |-- reconcile Slack history
    |-- group messages into threads
    |-- apply must-show and low-signal rules
    |-- batch-rank with zai-glm-5-2 on Mistral's API
    |-- synthesize a source-grounded digest
    `-- post or update the owner's Slack DM
```

Slack Buddy uses three separate state stores:

- D1 is the short-lived source of truth for Slack messages and digest runs.
- `ChatStateDO` stores Chat SDK locks, deduplication, and subscriptions.
- `SlackBuddyAgent` stores the user's Think conversation and relevance profile.

Raw Slack messages in D1 expire after 14 days by default. Hourly cleanup runs
before Slack requests, independently of digest delivery. Digests, profile versions,
and feedback remain available for learning and auditing.

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
  permitted to join, and checks for new public channels hourly.
- Private channels must explicitly invite the Slack Buddy app.
- Files and message attachments are not ingested in the first version.

## Prerequisites

- Node.js 22 or newer
- A Cloudflare account
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
- Slack reconciliation lookback: 48 hours
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
   channels are discovered and joined on the next hourly run at minute `17`,
   subject to workspace restrictions.

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
- Missing-table errors: apply the remote D1 migration.
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
- Each digest has a deterministic Workflow ID.
- The D1 run ledger is written before idempotent Workflow `createBatch`
  reconciliation, closing the insert/create crash gap.
- Workflow steps checkpoint directory sync, each reconciliation page, each model batch,
  synthesis, delivery, and completion.
- Reconciliation scans available parent-message history, including older
  parents with recent replies. This requires more Slack API requests for large
  channels; completed pages resume from checkpoints after a retry. Only text
  inside the retention period is stored in D1, and page checkpoints contain
  cursor metadata rather than copies of source messages.
- Active threads include retained context from before the briefing window;
  mentions in that earlier context do not trigger another required item.
- Ranked item IDs are derived from validated sources, so independent model
  batches cannot collide and exchange source links during synthesis.
- Before posting, delivery searches recent DM history for Slack Buddy's
  deterministic Block Kit marker and updates an existing digest instead of
  reposting. Every part of a multi-message digest has its own marker, allowing
  recovery after only some parts have been delivered.
- The hourly reconciler checks all unfinished digest runs, including older
  dates and runs checked before the next delivery time. A failed run or channel
  discovery request does not prevent other runs from being reconciled.
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

The current dry-run bundle is below Cloudflare Workers Free's compressed
3 MiB limit. Hosting should fit the free tier at modest volume; Mistral model
usage is billed separately unless covered by your account.
