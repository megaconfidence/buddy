# Changelog Buddy

Changelog Buddy monitors public Mistral release sources, detects new and
updated information, identifies developer-impacting changes and content
opportunities with GLM 5.2, and sends a daily email through Resend.

## Architecture

```text
30-minute Cloudflare Cron
  |
  +-- due source -> SourceScanWorkflow
  |     fetch -> parse -> hash -> baseline/diff -> D1
  |                                    |
  |                                    `-> large snapshots in R2
  |
  `-- 08:00 Europe/Paris -> DigestWorkflow
        D1 changes -> deterministic clustering -> GLM editorial pass
        -> HTML/plain-text renderer -> Resend -> D1 delivery ledger

Email feedback link -> confirmation page -> signed POST -> preference profile
```

This is a deterministic collection pipeline. The model never browses or fetches
URLs itself.

## Sources

The initial source registry includes:

- Mistral News RSS
- Mistral status RSS
- Documentation changelog commits
- Product release-note commits
- Published docs and GitHub repository security advisories
- Model lifecycle and model-definition commits
- Search Toolkit changelog
- Public OpenAPI specification
- Python SDK, TypeScript SDK, Vibe, and mistral-common GitHub Releases
- Mistral Cookbook commits
- PyPI releases for `mistralai`, `mistral-vibe`, and `mistral-common`
- npm releases for `@mistralai/mistralai`
- New and materially changed models in the Mistral Hugging Face organization

Definitions and polling intervals live in `src/sources/registry.ts`.

## Change detection

Each source adapter produces normalized items with a stable external ID and a
content hash.

- An unseen ID creates a new item.
- A changed hash creates an update.
- Registry metadata detects yanked or deprecated versions.
- OpenAPI snapshots are compared semantically by operation and schema.
- Duplicate registry, GitHub, documentation, and announcement events are
  clustered before reaching the model.

The first successful scan establishes a baseline and does not send the
historical backlog.

## Editorial output

GLM 5.2 scores normalized evidence for:

- Importance
- Developer impact
- Content potential
- Social post, demo app, cookbook, and video suitability
- Suggested hook and demo concept
- Effort and freshness window

Model calls use JSON Schema without tools. Source text is treated as untrusted
data. Application code validates source IDs and renders the email.

## Email

The email contains:

1. A short daily overview
2. The top three content opportunities
3. Must-know security, breaking, deprecation, and migration changes
4. Other meaningful updates
5. Source-health coverage

Resend receives both responsive HTML and plain text. The deterministic
`Idempotency-Key` prevents duplicate sends when a Workflow retries.

The HTML follows Mistral's current brand guidance: the official gradient
lockup on a white surface with clearspace, warm cream backgrounds, navy type,
the orange-to-yellow pixel stripe, and Inter/monospace typography with
email-safe fallbacks. The official logo asset is bundled with the Worker,
embedded as a Base64 CID attachment by Resend, and never recolored or
transformed.

Feedback links offer `Worth pursuing`, `Not relevant`, and `Handled`. GET
requests only show a confirmation page so automated email link scanners cannot
record feedback. The confirmed POST updates a versioned preference profile.

## Install

From the monorepo root:

```bash
npm install
cp changelog-buddy/.env.example changelog-buddy/.env
```

Configure:

```dotenv
MISTRAL_API_KEY="..."
RESEND_API_KEY="re_..."
EMAIL_TO="you@example.com"
EMAIL_FROM="Changelog Buddy <digest@your-verified-domain.com>"
FEEDBACK_SECRET="at-least-32-random-characters"
PUBLIC_BASE_URL="https://changelog-buddy.<account>.workers.dev"
GITHUB_TOKEN=""
```

A GitHub token is optional. Without one, Buddy uses public GitHub Atom feeds;
with one, it uses the API for richer release bodies, changed files, and patches.
The token only needs access to public repositories.

In Resend, verify the domain used by `EMAIL_FROM` before sending.

## Cloudflare resources

Run from `changelog-buddy/`:

```bash
cd changelog-buddy
npx wrangler d1 create changelog-buddy-db
npx wrangler r2 bucket create changelog-buddy-snapshots
```

Replace the placeholder D1 `database_id` in `wrangler.jsonc`, then apply the
migration:

```bash
npm run db:migrate:remote
```

Store production secrets:

```bash
npx wrangler secret bulk .env
```

Deploy:

```bash
npm run deploy
```

## Local development

```bash
npm run db:migrate:local
npm run dev
```

Trigger the coordinator locally:

```bash
curl "http://localhost:8787/cdn-cgi/local/scheduled"
```

The first trigger launches baseline scans. Trigger it again after the scan
Workflows complete to exercise digest scheduling.

## Commands

From the monorepo root:

```bash
npm run check
npm run deploy:dry-run:changelog
```

The application is designed for Cloudflare's free Worker, Workflow, D1, and R2
allowances at this source volume. Resend's free allowance is sufficient for one
daily recipient. Mistral API usage is billed separately unless covered by the
account.
