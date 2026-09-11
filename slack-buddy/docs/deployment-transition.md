# One-time infrastructure transition

This note applies only to Cloudflare accounts that already deployed Slack Buddy before the MCP app. It contains retirement steps, not instructions for enabling application features. Follow the [current README](../README.md) for normal setup.

The source checkout is MCP-only. Remote resources and secrets are unchanged until these operations are performed. Review data retention before executing destructive infrastructure operations.

## Existing Worker resources

1. Disable the currently deployed scheduled trigger in the Cloudflare dashboard during the transition, so it cannot create further executions.
2. Inspect the `slack-buddy-digest` Workflow and terminate any active instances. Retire that Workflow before publishing a Worker that no longer exports its class. From `slack-buddy`, the installed Wrangler CLI provides:

   ```sh
   npx wrangler workflows instances list slack-buddy-digest
   npx wrangler workflows delete slack-buddy-digest
   ```

   Workflow deletion removes its instances and execution history. Resolve any retention needs first; do not delete the Worker or D1 database.

3. The deployment applies the `v2-mcp-only` Durable Object migration in `wrangler.jsonc`. It deletes the `SlackBuddyAgent` and `ChatStateDO` namespaces **and their stored data**. Export anything you need before deployment. The earlier `v1` migration and exact class names remain only because Cloudflare needs its migration history to apply the transition correctly.
4. Follow the README to apply D1 migrations, configure the three current secrets, deploy, and verify the app. The configured hourly Cron Trigger now runs MCP app housekeeping and, when enabled, daily briefings.
5. Remove the unused `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` secrets from the deployed Worker. These names are not used by application code or local environment files.

## Database migration history

`0001_initial.sql` through `0003_incremental_sync.sql` have already been applied in production. Keep their names and contents unchanged: they are migration history, not the current data model. The MCP app uses only the four tables introduced in `0004_mcp_app.sql`.

This checkout does not drop existing D1 tables or erase their contents. The MCP app does not read them or run their previous retention process. Before rollout, make an explicit archive/removal decision for that stored data; do not assume the new metadata cleanup will expire it. Keep `mcp_profiles`, `mcp_runs`, `mcp_locks`, and `mcp_login_attempts`, which are the current application's tables.
