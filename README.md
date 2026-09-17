# Buddy monorepo

This repository contains focused assistants built under the Buddy name.

## Workspaces

- [`slack-buddy`](./slack-buddy) — private DevRel briefing and research web
  app powered by the Mistral Slack MCP connector.
- [`changelog-buddy`](./changelog-buddy) — monitors public Mistral release
  sources and emails a daily developer and content-opportunity briefing.

## Commands

Install every workspace from the repository root:

```bash
npm install
```

Run all available checks:

```bash
npm run check
```

Run Slack Buddy locally:

```bash
npm run dev:slack
```

Run Changelog Buddy locally:

```bash
npm run dev:changelog
```

Validate its Cloudflare bundle:

```bash
npm run deploy:dry-run:slack
npm run deploy:dry-run:changelog
```

Workspace-specific setup and deployment instructions are in
[`slack-buddy/README.md`](./slack-buddy/README.md) and
[`changelog-buddy/README.md`](./changelog-buddy/README.md).
