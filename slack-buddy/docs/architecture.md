# Slack Buddy architecture

A personal DevRel agent that watches the Slack channels you have joined, sends you a
daily briefing, and answers follow-up questions — with Slack as the only interface.

Built as a Cloudflare Worker with a single `Think` agent (Durable Object). All Slack
access goes through the Mistral connectors gateway over MCP. No Slack app is involved.

## Verified facts

Probed on 2026-09-17 against `MistralAI-ConnectorsGateway 3.4.4` at
`https://api.mistral.ai/v1/connectors-gateway/slack/mcp`.

| Fact | Detail |
| --- | --- |
| Transport | Stateless HTTP JSON-RPC, bearer auth with `MISTRAL_API_KEY`. No session header required. |
| Tools | 19 advertised. 12 are read-only; 7 write or send. |
| Owner identity | `U0BUM44636U`. The gateway acts **as the user**, not as a bot. |
| Joined-channel scope | `only_my_channels=true` with `channel_types=public_channel,private_channel`. Slack evaluates membership at query time, so channels joined later enter scope with no inventory to maintain. |
| Inline context | `include_context=true` returns surrounding messages within the search result, removing most follow-up thread reads. |
| Search cost | ~1.3 s per call. Pages cap at 20 matches. Keywords are AND-ed; no boolean operators. |
| Self-DM | `slack_read_channel` with `channel_id=U0BUM44636U` resolves to `D0BTQQF7WCW` and reads cleanly. |
| Send response | Returns `message_context.message_ts` and `channel_id` as structured fields, not just a permalink. No parsing, no read-back needed. |
| Threading | A reply sent with `thread_ts` does **not** appear as a top-level entry in `slack_read_channel`. But `slack_read_thread` returns both parties' messages under the same author ID, so threading guards the top level only — inside a thread a ledger is required. |
| Thread activity | The top-level read annotates each parent with `Thread: N replies (latest: <ts>)`, so new thread activity is detectable without a `slack_read_thread` call. |
| App attribution | Messages sent through the gateway are suffixed `*Sent using* <@U0B66544P62\|Vibe>`, giving a second, independent signal for agent-authored messages. |
| Mention search | `keywords: ["<@U0BUM44636U>"]` returns real mentions. The obvious alternative, `filters: "to:<@U0BUM44636U>"`, returns zero hits **silently** — it is not a supported modifier. Searching the display name is unusable: "confidence" is also an ordinary English word. |
| Channel-type default | `channel_types` defaults to `public_channel,private_channel,mpim,im` — DMs and group DMs are **included** unless set explicitly. Always pass it. |
| Time bounds | `after` and `before` take Unix timestamps as strings and are both **inclusive**. Boundary items can repeat across runs; dedupe absorbs this. |
| Owner role | `Admin: No`. The account cannot self-approve a Slack app, which independently confirms the app-free design. |
| Timezone | `Europe/London`. |
| Model | `glm-5-2`, `function_calling: true`, **1,048,576-token context**. Verified to emit correct multi-step tool calls. The context is large enough that retrieval needs no character cap. |

**There is no inbound path.** The gateway exposes no event, webhook, or subscription
tool. Nothing can push a Slack message into the Worker. This single constraint shapes
the whole design.

## Shape

```
Slack workspace
      ▲  ▼                    all traffic as U0BUM44636U
      │  │
   Mistral connectors gateway (MCP, 19 tools)
      ▲  ▼
Worker
└── SlackBuddy extends Think            Durable Object, one instance: "owner"
    ├── getModel()          glm-5-2 over the Mistral API
    ├── onStart()           addMcpServer("slack", gateway, { transport: { headers } })
    ├── getTools()          12 read-only MCP tools + watchlist tools
    ├── schedule(n)         pollInbox, re-armed each tick ── inbound conversation
    ├── getScheduledTasks() dailyDigest ── handler starts the sweep fiber
    └── SQLite              sent_ledger · seen_items · watchlist · digest_runs · cursor
                                   │
                                   ▼
        sweep fiber      plan → retrieve → dedupe → rank → synthesize → deliver
```

The poller uses the base Agent `schedule(seconds)` re-armed at the end of every tick,
not `getScheduledTasks()`. The Think scheduling DSL is minute-granularity
(`every <n> minutes`) and static, so it can express neither the 10 s burst nor an
adaptive interval.

One surface for everything: your self-DM, `D0BTQQF7WCW`. The briefing lands there and
you reply there.

## Consequence: the agent speaks as you

Because MCP holds a user token, every message the agent sends is authored by you. This
is what grants access to your private channels, and it is not separable from that
access. Three requirements follow.

**Loop prevention needs both a structural guard and a ledger.** The poller reads the
same DM the agent writes to, so naively it would answer itself forever.

Threading solves the top level: `slack_read_channel` returns only top-level messages, so
conversational replies posted with `thread_ts` never appear there. Verified.

Threading does **not** solve the inside of a thread, which is where the conversation
actually happens. `slack_read_thread` returns every message in the thread, and both your
messages and the agent's carry the same author — `U0BUM44636U`. They are
indistinguishable by identity. Verified against a live thread.

So `sent_ledger` records **every** agent-sent timestamp, not one per day. New input is
`ts > cursor AND ts ∉ sent_ledger`. A per-thread cursor alone is not sufficient: if you
send two messages in quick succession, the agent's reply to the first carries a later
timestamp than your second, and a cursor-only rule would skip it.

Gateway-sent messages do carry a `*Sent using* <@U0B66544P62|Vibe>` suffix that messages
typed in Slack lack, so it is a real in-band signal — but it is a rendered display
string. The ledger stays authoritative; the marker is a cross-check.

**Delivery is not a model capability.** `slack_send_message` is never exposed as a tool.
The app calls it directly through the MCP client with `channel_id` hardcoded to the
owner DM. Under a prompt injection from any channel you have joined, the agent
therefore cannot post anywhere as you. This matters more here than in a bot design,
not less.

**Nothing is real-time.** Response latency is one poll interval.

## Tool policy

Exposed to the model — read-only, 12 tools:

```
slack_search_public          slack_read_channel        slack_read_user_profile
slack_search_public_and_private  slack_read_thread     slack_list_channel_members
slack_search_channels        slack_read_canvas         slack_read_file
slack_search_users           slack_get_reactions       slack_search_emojis
```

Withheld from the model, app-invoked only:

```
slack_send_message       slack_add_reaction        slack_create_canvas
slack_schedule_message   slack_create_conversation slack_update_canvas
slack_send_message_draft
```

`slack_send_message_draft` may later be promoted to a model tool if you want
"draft a reply to this thread" — it writes to Drafts and does not send. Treat that as
a deliberate, separate decision.

### The allowlist must be enforced explicitly

Think exposes `includeMcpTools`, which **defaults to `true`** and auto-merges every tool
from every connected MCP server into each model turn. Connecting the gateway and
stopping there hands the model all 19 tools — including `slack_send_message`,
`slack_create_conversation`, and the canvas writers — running under a user token with
workspace-wide reach. The security boundary this design depends on would be silently
absent, with nothing in the code to read as wrong.

Therefore:

```ts
includeMcpTools = false;          // disable the auto-merge, explicitly

getTools() {
  const all = this.mcp.getAITools({ serverId: "slack" });
  return Object.fromEntries(
    Object.entries(all).filter(([name]) => READ_ONLY_ALLOWLIST.has(name))
  );
}
```

`MCPServerFilter` narrows by `serverId`, `serverName`, and `state` — **not** by tool
name — so the per-tool allowlist has to be applied by filtering the returned `ToolSet`
keys. Those keys are namespaced `tool_{serverId}_{toolName}`, so `slack_send_message`
arrives as `tool_slack_slack_send_message`. Write the allowlist against the namespaced
form and assert its length is 12 at startup, so a gateway that adds a twentieth tool
fails loudly instead of quietly widening the model's reach.

App-side delivery uses `this.mcp.callTool(...)`, which is unaffected by
`includeMcpTools`. The app can send; the model cannot.

Retrieved channel text is untrusted data. The allowlist is the enforcement boundary;
the system prompt is not.

## Inbound: adaptive polling

No Slack-native push exists without a Slack app. The Events API, slash commands,
Workflow Builder's outbound step, and legacy outgoing webhooks all require one.
Routing Slack's email notifications into Cloudflare Email Routing would sidestep that,
but Slack never notifies you about your own messages, and the agent posts as you — so
no notification is ever generated. Polling is the only option in this design.

`pollInbox` runs on a Durable Object alarm:

0. If a turn is already in flight, re-arm and return. The Durable Object is
   single-threaded and Think serializes turns, so an unguarded poll during a slow turn
   queues work rather than dropping it — the queue is what has to be avoided.
1. `slack_read_channel(D0BTQQF7WCW, oldest=cursor)` — returns top-level messages and,
   on each parent, `Thread: N replies (latest: <ts>)`
2. For any thread whose `latest` has advanced past its stored cursor, `slack_read_thread`
3. Across both surfaces, keep messages with `ts > cursor` and `ts ∉ sent_ledger`
4. If nothing remains, downshift cadence and return
5. `slack_add_reaction("eyes")` — acknowledgment within one tick
6. `runTurn({ mode: "wait", input, idempotencyKey: ts })`
7. Deliver with `thread_ts` set to the triggering message; record the returned
   `message_ts` in `sent_ledger` **before** advancing the cursor
8. Advance cursors, upshift cadence

Ordering in step 7 matters: if the process dies between sending and recording, the next
poll sees an agent message that is not in the ledger and answers it. Record first.

The `white_check_mark` reaction is optional — the reply itself signals completion, and
the extra call buys little. The `eyes` ack is the one that carries weight.

`wait` mode is correct here: the poll handler is not inside a turn, so blocking is
safe, and Think runs it in a recovery fiber that survives eviction. Nothing is waiting
on an HTTP deadline. (An Events API design would have to use `submit` instead, because
Slack requires a 200 within three seconds.)

**Cadence** follows your calendar rather than a flat interval:

| Condition | Interval |
| --- | --- |
| Working hours, Mon–Fri 08:00–19:00 Europe/London | 60 s |
| Overnight and weekends | 15 min |
| Within 10 min of a message from you | 10 s |
| Within 20 min of digest delivery | 10 s |

Roughly 950 MCP calls a day, against 8,640 for a flat 10 s poll — and more responsive
than a flat 60 s poll at the moments that matter.

**Active threads cost nothing to watch.** Your replies land inside a thread, which the
top-level read does not expand — but it does annotate the parent with
`Thread: N replies (latest: <ts>)`. The poller compares that timestamp against the last
one it handled and calls `slack_read_thread` only when it has actually advanced.
Polling therefore stays at one call per tick, with a second call only on a real reply
rather than on every tick of an open conversation.

**Perceived latency is what to optimize.** The `eyes` reaction lands within a tick and
tells you the agent heard you. A ten-second acknowledgment reads as responsive; ten
seconds of silence does not.

## Daily briefing

A `getScheduledTasks()` handler task fires weekdays at 08:30 Europe/London, matching the
owner's Slack timezone, and starts the sweep keyed by the task's `idempotencyKey`.

The sweep runs as a durable fiber inside the agent (`startFiber()`), not as a Workflow.
A Workflow would add a class, a binding, and cross-boundary state access by RPC in
exchange for step-level retry that `this.retry()` already provides for eight searches
and one synthesis call. Promote it to a Workflow if the sweep grows more steps or needs
long waits; do not start there.

Retrieval is search, never exhaustive reading. Budget: at most 8 searches and 2 thread
expansions per run.

| Pass | Query |
| --- | --- |
| Mentions | `keywords: ["<@U0BUM44636U>"]` since the last digest — always ranked first |
| Watchlist | one query per active topic (OCR, Vibe, Le Chat, …) |
| Upcoming | `launch`, `ship`, `GA`, `roadmap`, `beta` |
| Content | `blog`, `talk`, `demo`, `conference`, `cookbook` |

Results are deduplicated on `channel_id:message_ts` against `seen_items`, so a thread
that runs for three days does not resurface three times.

Sections delivered:

```
Needs you              direct mentions and unanswered asks
Upcoming               tagged confirmed | tentative | inferred
Content opportunities  audience · format · angle · next step
Radar                  broader DevRel chatter
```

The briefing is posted as a header at top level with **one message per item** threaded
beneath it. A single blob could only ever collect one reaction for the whole day, which
is too coarse to steer anything.

The model returns structured items citing a `SOURCE_ID` and never a URL; the app
attaches the permalink from its own record of the hit. An invented or mismatched link
is therefore not expressible, rather than caught after the fact.

## What it decides to watch

Four inputs, in order of strength:

| Input | Role |
| --- | --- |
| Owner mention token | always query #1, always ranked first |
| Watchlist | up to 4 topic queries; seeded `OCR`, `Vibe`; editable in conversation |
| Two signal pools | `launch·roadmap·shipping·GA·beta·rollout`, `blog·talk·demo·webinar·cookbook·tutorial`, rotated daily |
| The model | drops keyword-match noise at synthesis and assigns sections |

Keyword retrieval is blunt on purpose — the gateway AND-s keywords with no OR, and each
query costs one of eight slots. `natural_language_query` is passed on topic and signal
queries for semantic reranking; whether this account supports it is unconfirmed.

**Reaction feedback closes the loop.** React `:+1:` or `:-1:` on any briefing item. The
next run reads those reactions with `slack_get_reactions`, attributes the verdict to the
query term that surfaced the item, and accumulates a score in `topic_signals`. At +2 a
term is promoted into a scarce topic slot; at −2 it is dropped from the pools entirely.
The watchlist therefore moves toward what the owner actually engages with instead of
staying at whatever it was seeded with.

Two details that matter:

- Slack canonicalises emoji aliases, so a `thumbsup` reads back as `+1`. Matching the
  alias would silently never fire.
- Harvesting is deferred a full day and each item is read exactly once, which bounds the
  cost at one call per item. A reaction added later than that is missed — the price of
  not re-reading every past item forever.

**Scope is channels only.** `channel_types=public_channel,private_channel`, never the
`im,mpim` default. DMs and group DMs stay out of the sweep and therefore out of model
context.

**Quiet days are silent.** If the sweep surfaces nothing, nothing is posted. The cost is
that silence is ambiguous between a quiet day and a failed run, so every run — including
empty and failed ones — is recorded in `digest_runs`, and the agent can report its own
run history when asked in the DM. That makes the ambiguity resolvable rather than
invisible.

## State

All state lives in the agent's Durable Object SQLite. The Workflow reads and writes it
by RPC so there is one source of truth and no D1 binding.

| Table | Holds |
| --- | --- |
| `sent_ledger` | timestamp of every agent-sent message; the in-thread loop guard. Pruned with its thread |
| `seen_items` | `channel_id:message_ts` hashes already briefed; pruned at 30 days |
| `watchlist` | tracked topics and aliases, editable in conversation |
| `digest_runs` | run ledger and delivery outcome |
| `digest_items` | posted item → the query term and channel that produced it |
| `topic_signals` | accumulated positive/negative reaction score per term |
| `cursors` | poll watermarks, thread signatures, last activity and digest times |

## Configuration

```
MISTRAL_API_KEY      secret   gateway auth and model auth — the only credential
OWNER_SLACK_USER_ID  var      U0BUM44636U
OWNER_DM_CHANNEL_ID  var      D0BTQQF7WCW
```

Bindings: one Durable Object (`SlackBuddy`, SQLite migration). No Workflow binding and
no AI binding — the sweep runs in-agent and the model is reached over the Mistral API.

`compatibility_flags: ["nodejs_compat"]`. Some Think references also list an
`experimental` flag; the current quick-start does not. Confirm against the installed
version at scaffold time rather than copying either.

**Model provider.** `glm-5-2` is served by the Mistral API but is not a Mistral model,
so `@ai-sdk/mistral` may apply Mistral-specific request shaping. Use
`@ai-sdk/openai-compatible` against `https://api.mistral.ai/v1`. Pin the AI SDK major
to match Think's peer range (`ai@^6` with `@ai-sdk/react@^3`, or `ai@^7` with `^4`).

**Monorepo wiring is currently broken.** The root `package.json` orchestrates
`@buddy/slack-buddy`, but this workspace is named `slack-buddy`, so `npm run dev:slack`
and `deploy:dry-run:slack` fail. Rename the package and add the `check`, `typecheck`,
and `deploy:dry-run` scripts that the sibling `@buddy/changelog-buddy` already defines.

## Resolved risks

Both open items were probed live on 2026-09-17 against the owner's self-DM.

`slack_send_message` returns `message_context.message_ts` directly, so recording the
digest timestamp needs no permalink parsing and no read-back call.

Threading works at the top level: a reply sent with `thread_ts` is absent from the
top-level `slack_read_channel` result, and the parent instead carries a reply count and
a latest-reply timestamp, which makes thread watching free.

It does not extend inside the thread. A live `slack_read_thread` returned both the
parent and the reply under the same author ID, distinguishable only by the
`*Sent using*` suffix. An earlier revision of this document claimed the loop guard was
purely structural and reduced `sent_ledger` to one row per day. That was wrong, and it
would have produced an agent that answers itself in every conversation. The ledger
records every agent-sent timestamp.

Two test messages remain in the self-DM. The gateway exposes no delete tool, so they
have to be removed by hand.

## Known tradeoffs

- Replies are authored by you. Private to your DM, but visibly your account.
- Latency is 10 s mid-conversation, up to 15 min when idle overnight. Never instant.
- Polling spends MCP calls while idle.
- Search is a sample, not full channel coverage. Briefings should report partial
  coverage rather than imply completeness.

## Migration path to a bot app

If a Slack app is later approved for the workspace, the agent gains a distinct
identity, real-time events, and `app_mention` in shared channels. Keep inbound and
outbound behind one `Transport` interface (`poll()`, `deliver()`, `acknowledge()`) so
the swap to Think messengers with `@chat-adapter/slack` touches only that module.
Retrieval, ranking, synthesis, and state are unaffected.

Note that Think ships a Telegram messenger adapter only; Slack would go through the
generic `chatSdkMessenger()` with `@chat-adapter/slack`, in single-workspace mode with
`SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`.
