# Slack Buddy

A private DevRel briefing and research app using the approved Mistral Slack MCP connector.

## What it does

- **Your briefing:** source-linked developments, upcoming plans, content opportunities, and direct mentions.
- **Ask & explore:** questions and follow-ups over recent Slack activity, with session context held only in browser memory.
- **Priorities:** editable OCR and Vibe defaults, additional search keywords, broader DevRel topics, preferred content formats, and separate relevance/content feedback.
- **Slack delivery:** review a briefing in the browser, then send it to your configured Slack account.
- **Activity:** recent run counts, coverage, errors, and delivery status without a stored archive of Slack content.

Joined public and private channels are in scope by default. The connector checks current memberships at search time, so future joined channels enter scope automatically. DMs and group DMs are explicitly excluded. A separate search explores other accessible public channels; both private inclusion and wider public discovery are configurable.

Being in scope does **not** mean every channel or message is read. This is bounded keyword search, not exhaustive monitoring. The interface shows which searches completed, failed, or returned partial results.

## How it works

```text
Authenticated private web app
    → bounded searches through Mistral Slack MCP
    → selected thread context
    → one structured model summary with validated source IDs and excerpts
    → browser results / explicit send to the owner
```

Each standard briefing searches direct mentions, the first keyword of every priority, a rotating broader DevRel keyword, and an optional wider public keyword. Extra priority keywords rotate through spare search slots. Rotation is daily. At most ten search/thread tool calls are initiated, with a 65-second retrieval initiation budget, up to two thread expansions, and bounded model context. A started request can run past that budget until its own timeout. Transport initialization is additional MCP protocol traffic.

The connector currently supports keyword search, not semantic search. Spaces mean AND. Searches return at most 20 results per page; only mentions may get an extra page when budget permits. Auth/rate-limit failures stop further reads, and the app does not automatically retry them. Research uses one short query-planning model call before retrieval and one summarization call afterward.

Source text cannot select tools, alter channel scope, change settings, or choose a delivery destination. Results include verified Slack links and exact supporting excerpts. This validates provenance, not every interpretation: upcoming items distinguish confirmed/tentative/inferred claims, and content ideas require publication confirmation.

## Local setup

Requires Node.js 22+ and the existing monorepo dependencies:

```sh
npm install
cp -n slack-buddy/.env.example slack-buddy/.env
```

Set the following in `slack-buddy/.env`:

| Variable                 | Purpose                                                             |
| ------------------------ | ------------------------------------------------------------------- |
| `MISTRAL_API_KEY`        | Server-side key for the approved Slack connector and model          |
| `SLACK_USER_ID`          | Owner identity matching the connector's authenticated Slack account |
| `SLACK_BUDDY_WEB_SECRET` | A separate random owner login key, at least 32 characters           |
| `SLACK_BUDDY_LOCAL_DEV`  | `true` only for localhost development                               |

Generate a new web login key with `openssl rand -hex 32`. Do not reuse the Mistral API key. The web key is also the session-signing secret; rotating it invalidates existing sessions. The interface is for a single owner, with a signed 12-hour cookie, same-origin mutation checks, and login throttling. It does not implement enterprise multi-user SSO.

From the repository root:

```sh
npm run db:migrate:local --workspace @buddy/slack-buddy
npm run dev:slack
```

Open the local URL Wrangler prints and sign in with the owner access key. Preferences are saved in local D1; production D1 has separate preferences.

## Deployment

The app uses a Cloudflare Worker, D1 for preferences and run metadata, and an hourly Cron Trigger for housekeeping and optional daily briefings. Timezone and delivery hour are saved in the web app's Preferences. Model selection and scheduled-access availability are configured in `wrangler.jsonc`.

For an existing deployment, complete the [one-time infrastructure transition](docs/deployment-transition.md) first. That note documents migration requirements; it is not application setup.

From the repository root, apply the D1 migrations:

```sh
npm run db:migrate:remote --workspace @buddy/slack-buddy
```

From `slack-buddy`, configure production secrets interactively:

```sh
npx wrangler secret put MISTRAL_API_KEY
npx wrangler secret put SLACK_USER_ID
npx wrangler secret put SLACK_BUDDY_WEB_SECRET
```

Retain valid existing values for the connector key and owner ID. Keep `SLACK_BUDDY_LOCAL_DEV` unset in production. Then deploy from the repository root:

```sh
npm run deploy --workspace @buddy/slack-buddy
```

Check `/health` for `mode: "mcp"`, sign in with the owner access key, generate a briefing, inspect coverage, and test delivery of a reviewed briefing to yourself. Live sending and sender identity still need verification; the development benchmark sent no Slack messages.

## Morning delivery

Daily generation and owner delivery are implemented but **disabled by default**. Slack's underlying [real-time search guidance](https://docs.slack.dev/apis/web-api/real-time-search-api/) describes user-initiated retrieval and restricts storing retrieved data. Verify that this approved gateway supports unattended scheduled retrieval before enabling it; connector availability alone does not establish that support.

Once supported, set `SLACK_BUDDY_SCHEDULED_MCP_ENABLED` to `"true"` in Wrangler configuration and deploy, then enable daily delivery in Preferences. Defaults are 08:00 Europe/Paris. The hourly trigger checks the configured local hour, retrieves the previous local calendar day, and starts at most one run per owner/date. A missed hour can be caught by a later check that day. Generation time comes after the scheduled hour.

Daily runs do not retry automatically after failure. Manual runs remain available. Delivery records intent before the first send; an ambiguous or partly completed multipart send becomes `uncertain` and is never blindly resent. Check Slack before taking further action. An interrupted send may remain `sending`, also preventing retries. Briefings are split below the gateway's 5,000-character text limit.

## Data and retention

New MCP source text, generated briefings, and research conversation stay transient in the request/browser session. They are not written to D1, local storage, or application logs. Refreshing or signing out clears the displayed briefing and conversational context. Model calls send the bounded source context to Mistral using the configured model.

D1 stores explicit preferences and user-entered feedback topics, hashed login-throttle keys, and operational run metadata. Run history is retained for 30 days. Avoid copying Slack excerpts into preference fields or enabling payload logging/tracing in future changes.

## Verification and performance

```sh
npm run check --workspace @buddy/slack-buddy
npm run format:check --workspace @buddy/slack-buddy
npm run deploy:dry-run --workspace @buddy/slack-buddy
```

Tests cover scope/time boundaries, response parsing, grounding, budgets, rate limits, owner auth/CSRF, settings concurrency, execution leases, scheduling, and uncertain-delivery suppression. Browser checks exercise desktop/mobile login, settings, result cards, research, and simulated delivery.

A live read/model benchmark on 2026-09-11 used three searches and one thread read over seven days: **59 distinct candidates in 6.7 seconds, then 13 source-grounded items in 14.3 seconds** (about 21 seconds total). Coverage was partial because more search results remained. This is a bounded sample, not a daily-run latency guarantee. `scripts/benchmark-mcp.ts` contains the opt-in benchmark; it never sends Slack messages.

See [the architecture](docs/architecture.md) for implementation details.
