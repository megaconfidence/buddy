# Slack Buddy architecture

A private web app with optional delivery to the owner in Slack. See [README](../README.md) for setup and deployment.

## Product goals and coverage

The four briefing sections are direct mentions/actions, broader DevRel developments, upcoming plans, and content opportunities. Upcoming items distinguish confirmed statements, tentative plans, and inferences. Content ideas identify an audience, format, timely angle, and next step, with publication confirmation required.

OCR and Vibe are the initial editable priorities. Each keeps a primary keyword search in every briefing. Additional aliases rotate through spare search slots. Broader DevRel searches retain their own allocation independently of focus areas. Explicit feedback separates relevance from content usefulness; it affects model ranking rather than silently rewriting priorities.

All current joined public/private channels are included in search scope by default through `only_my_channels=true` and `channel_types=public_channel,private_channel`. Membership is evaluated by Slack at query time, without maintaining an inventory. Future memberships therefore enter the same scope automatically; joining a new channel was not part of the benchmark. Separate public search covers other accessible public channels. DMs and group DMs are excluded. Search inclusion is not exhaustive per-channel reading.

## Verified gateway behavior

Endpoint: `https://api.mistral.ai/v1/connectors-gateway/slack/mcp`, authenticated with a server-side Mistral API key. Initialization, discovery, and bounded reads were verified on 2026-09-11 against MistralAI-ConnectorsGateway 3.4.4.

Nineteen tools were advertised, including public/private message search, channel/user search, channel/thread reads, file/canvas reads, message delivery, and scheduling existing text. Semantic search is unavailable for this account. Keywords use spaces as AND, without boolean operators; search pages are capped at 20 matches.

The adapter parses the actual gateway response: a JSON envelope containing formatted message text and prose pagination cursors. It validates Slack permalinks against returned channel IDs/timestamps, applies an exclusive upper time bound, and marks unknown/truncated data as partial. Thread context is bounded and labeled as background that may predate the briefing window.

## Execution and efficiency

Standard plans contain mentions, each primary priority keyword, one rotating joined-channel radar query, optional wider-public radar, and extra aliases if slots remain. At most eight initial searches leave room within ten tool calls for selected thread reads. Mentions can use a second page when budget allows. Research uses up to three model-planned plain keyword queries over joined channels.

A shared request limit and retrieval initiation deadline bound retrieval work. Read authentication/rate-limit failures stop further calls. Search text is capped at 48,000 characters, with at most two additional 6,000-character thread expansions. Sources are deduplicated and owner mentions ranked first. One structured model call produces the briefing; research adds one query-planning call. Coverage, counts, and elapsed time are visible to the owner.

A live benchmark retrieved 59 distinct candidates from three searches plus one thread read in 6.7 seconds and summarized them into 13 validated items in 14.3 seconds. More results remained; coverage correctly stayed partial. The full daily planner can use more calls, so this sample does not establish a daily latency guarantee.

## Boundaries and persistence

The application enforces MCP tool allowlists, channel scope, owner identity, and destination outside the model. Source text and conversational history cannot grant permissions. Generated citations must use retrieved source IDs with an exact supporting excerpt. This rejects invented provenance but is not a semantic proof that every model claim follows from its evidence.

Owner access uses a separate random login key, signed session cookies, same-origin mutations, and login throttling. Settings updates use optimistic versions; runs use an expiring owner lease. Interrupted runs are marked failed once their lease expires. Browser-held delivery payloads are signed, expire after 30 minutes, and cannot be changed without invalidating authorization.

Raw sources, briefings, and research turns are processed transiently. Persistent state contains explicit preferences, user-entered feedback topics, and operational metadata. A send records intent first; uncertain delivery does not retry. Real sender identity and send response shape still require a live owner delivery test.

## Scheduling

An hourly runner supports the previous local day's briefing, defaulting to 08:00 Europe/Paris. Unique owner/date run IDs suppress duplicate daily generation. Both the operator feature flag and the owner's daily-delivery preference must be enabled. The feature flag remains off pending confirmation that unattended retrieval is supported by this gateway under Slack's underlying search requirements.

The Worker handles browser requests and the hourly Cron Trigger. D1 stores preferences and operational state. See [deployment instructions](../README.md#deployment) for configuration and verification.

The browser is the research interface; Slack is an explicit delivery destination.
