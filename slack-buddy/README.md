# Buddy

Buddy is a private, personalized Slack assistant for a Developer Advocate at
Mistral. It passively ingests messages from channels the Slack app can access,
learns from explicit feedback, answers questions in DM, and sends a
source-linked daily briefing.

## Architecture

```text
Slack Events API
    |
    v
Cloudflare Worker + Chat SDK Slack adapter
    |-- channel messages, edits, deletes --> D1
    |-- owner DM --------------------------> Buddy Think agent
    `-- feedback actions ------------------> profile memory

Hourly reconciler
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

Buddy uses three separate state stores:

- D1 is the short-lived source of truth for Slack messages and digest runs.
- `ChatStateDO` stores Chat SDK locks, deduplication, and subscriptions.
- `BuddyAgent` stores the user's Think conversation and relevance profile.

Raw Slack messages expire after 14 days by default. Digests, profile versions,
and feedback remain available for learning and auditing.

"Learning" means versioned preference memory, not model fine-tuning. Relevant
and not-relevant feedback adds bounded examples to the user's profile; handled
items are recorded without changing topic preferences. In DM, you can also ask
Buddy to remember current priorities, add watched topics, or adjust relevance
thresholds.

## Current scope

- One Slack workspace and one authorized user per deployment.
- Cross-channel search is only exposed through that user's DM with Buddy.
- Channel messages are ingested but Buddy does not reply in public channels.
- Direct mentions are always considered for the daily digest.
- Buddy automatically joins every non-archived public channel it is permitted
  to join, and checks for new public channels hourly.
- Private channels must explicitly invite the Buddy app.
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

The non-secret defaults are in `wrangler.jsonc`:

- Timezone: `Europe/Paris`
- Delivery hour: `08:00`
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
5. After deploying Buddy, replace `YOUR-WORKER` in `slack-manifest.json` with
   the deployed Worker subdomain and apply that full manifest.
6. Invite Buddy to every private channel it should monitor. Public channels are
   joined automatically unless Slack restricts app membership.

The app requests:

- Message history and metadata for joined public/private channels
- DM access for the interactive assistant
- `chat:write` for answers and daily briefings
- `users:read` for attribution

## Create Cloudflare resources

Run the Cloudflare commands in this section from `slack-buddy/`.

Create D1 and replace the placeholder `database_id` in `wrangler.jsonc`:

```bash
cd slack-buddy
npx wrangler d1 create buddy-db
npm run db:migrate:remote
```

Store production secrets:

```bash
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put SLACK_USER_ID
npx wrangler secret put MISTRAL_API_KEY
```

Deploy:

```bash
npm run deploy
```

Then set both Slack request URLs to:

```text
https://<your-worker>.workers.dev/webhooks/slack
```

## Local development

Apply the local migration and start Wrangler:

```bash
npm run db:migrate:local
npm run dev
```

Slack cannot call localhost directly. Use a secure tunnel for webhook testing,
or deploy a development Worker and point a separate Slack test app at it.

## Reliability model

- Slack event writes are idempotent by workspace, channel, and message
  timestamp.
- Chat SDK dispatches overlapping messages concurrently; D1 timestamps and
  unique keys make those writes order-independent and idempotent.
- Edits and deletions update existing D1 rows.
- Each digest has a deterministic Workflow ID.
- The D1 run ledger is written before idempotent Workflow `createBatch`
  reconciliation, closing the insert/create crash gap.
- Workflow steps checkpoint directory sync, reconciliation, each model batch,
  synthesis, delivery, and completion.
- Before posting, delivery searches recent DM history for Buddy's deterministic
  Slack message metadata and updates an existing digest instead of reposting.
- The hourly reconciler restarts failed Workflow instances.
- Slack history reconciliation repairs webhook gaps before every digest.

## Security model

- Only `SLACK_USER_ID` can interact with Buddy or submit learning feedback.
- Cross-channel retrieval is DM-only.
- Slack text is treated as untrusted data.
- Digest ranking uses structured output without agent tools.
- Interactive Think turns use an allowlist of search, digest, profile, and
  explicit preference-update tools.
- Raw message text is deleted on the configured retention schedule.
- Secrets live in Wrangler secrets and are never committed.

Before using Buddy with corporate Slack, confirm that storing Slack content in
Cloudflare D1 and sending selected content to Mistral's API is approved.

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
