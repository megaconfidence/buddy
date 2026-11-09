# Slack Buddy architecture

A personal DevRel agent that watches the Slack channels you have joined, sends you a
daily briefing, and answers follow-up questions — with Slack as the only interface.

Built as a Cloudflare Worker with a single `Think` agent (Durable Object). All Slack
access goes through the Mistral connectors gateway over MCP. No Slack app is involved.

## Verified facts

Probed on 2026-09-17 against `MistralAI-ConnectorsGateway 3.4.4` at
`https://api.mistral.ai/v1/connectors-gateway/slack/mcp`.

| Fact                 | Detail                                                                                                                                                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transport            | Stateless HTTP JSON-RPC, bearer auth with `MISTRAL_API_KEY`. No session header required.                                                                                                                                                                               |
| Tools                | 19 advertised. 12 are read-only; 7 write or send.                                                                                                                                                                                                                      |
| Owner identity       | `U0BUM44636U`. The gateway acts **as the user**, not as a bot.                                                                                                                                                                                                         |
| Joined-channel scope | `only_my_channels=true` with `channel_types=public_channel,private_channel`. Slack evaluates membership at query time, so channels joined later enter scope with no inventory to maintain.                                                                             |
| Inline context       | `include_context=true` returns surrounding messages within the search result, removing most follow-up thread reads.                                                                                                                                                    |
| Search cost          | ~1.3 s per call. Pages cap at 20 matches. Keywords are AND-ed; no boolean operators.                                                                                                                                                                                   |
| Self-DM              | `slack_read_channel` with `channel_id=U0BUM44636U` resolves to `D0BTQQF7WCW` and reads cleanly.                                                                                                                                                                        |
| Send response        | Returns `message_context.message_ts` and `channel_id` as structured fields, not just a permalink. No parsing, no read-back needed.                                                                                                                                     |
| Threading            | A reply sent with `thread_ts` does **not** appear as a top-level entry in `slack_read_channel`. But `slack_read_thread` returns both parties' messages under the same author ID, so threading guards the top level only — inside a thread a ledger is required.        |
| Thread activity      | The top-level read annotates each parent with `Thread: N replies (latest: <ts>)`, so new thread activity is detectable without a `slack_read_thread` call.                                                                                                             |
| App attribution      | Messages sent through the gateway are suffixed `*Sent using* <@U0B66544P62\|Vibe>`, giving a second, independent signal for agent-authored messages.                                                                                                                   |
| Mention search       | `keywords: ["<@U0BUM44636U>"]` returns real mentions. The obvious alternative, `filters: "to:<@U0BUM44636U>"`, returns zero hits **silently** — it is not a supported modifier. Searching the display name is unusable: "confidence" is also an ordinary English word. |
| Channel-type default | `channel_types` defaults to `public_channel,private_channel,mpim,im` — DMs and group DMs are **included** unless set explicitly. Always pass it.                                                                                                                       |
| Time bounds          | `after` and `before` take Unix timestamps as strings and are both **inclusive**. Boundary items can repeat across runs; dedupe absorbs this.                                                                                                                           |
| Owner role           | `Admin: No`. The account cannot self-approve a Slack app, which independently confirms the app-free design.                                                                                                                                                            |
| Timezone             | `Europe/London`.                                                                                                                                                                                                                                                       |
| Model                | `glm-5-2`, `function_calling: true`, **1,048,576-token context**. Verified to emit correct multi-step tool calls. The context is large enough that retrieval needs no character cap.                                                                                   |

**There is no inbound path.** The gateway exposes no event, webhook, or subscription
tool. Nothing can push a Slack message into the Worker. This single constraint shapes
the whole design.

### Probed 2026-11-01, for the digest

Probed against the live gateway with the real parsers, printing structure only. The
gateway's tool names match Slack's own MCP server, whose published rate limits apply.

| Fact              | Detail                                                                                                                                                                            |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Send format       | `slack_send_message` describes its input as standard Markdown (`**bold**`, `_italic_`, links, lists) and caps a message at 5,000 characters. Slack's `*bold*` renders as italics. |
| Previews          | The only preview switch is `unfurl_app_links`, for app links such as GitHub. Nothing turns off previews of Slack message links; the owner accepts them to keep sources inline.    |
| Search pagination | The cursor arrives in prose, in `pagination_info`: "For the next page of results use cursor `…`". Page two returned older results with no overlap.                                |
| Enterprise Grid   | Permalinks have a four-label host, `<org>.<subdomain>.slack.com`; host checks must allow more than one label before `slack.com`.                                                  |
| Thread signatures | Times render in the owner's zone, and both `GMT` and `BST` occur; all parsed.                                                                                                     |
| Search is scarce  | Roughly 10 searches a minute per user, every page counted, with daily limits for sustained use.                                                                                   |
| Reads are cheap   | `slack_read_channel` and `slack_read_thread` are Tier 3, 50+ a minute; a thread read returns up to 1,000 messages.                                                                |
| Model             | `glm-5-2` accepted both structured-output schemas. A 24-hour Sunday window ran end to end in 18 s: 9 searches, 6 thread reads, 2 model calls.                                     |

### Probed 2026-11-02, for the briefing's layout

Two labelled test replies in the owner's DM, read back with `slack_read_thread`.

| Fact         | Detail                                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Lists        | Markdown lists become list blocks. `-` renders as `•`, and no blank line survives after a list, so whatever follows sits directly under its last item.             |
| List numbers | An ordered list keeps its start number, so `3.` stays 3, but only after a blank line. Directly under a paragraph line it stays plain text, as CommonMark requires. |
| Line breaks  | Single newlines inside a paragraph stay line breaks, and blank lines between paragraphs are kept.                                                                  |

### Probed 2026-11-09, for notifications

One labelled test notification through the owner's workflow, found again with a DM search.

| Fact       | Detail                                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| Gateway    | No reminder tool among the 19, and the seven write tools all act as the owner, so nothing it sends can notify them.         |
| Publishing | An unpublished workflow answers `400 {"ok":false,"error":"workflow_not_published"}`; once published, `200`.                 |
| Delivery   | `{"message": "…"}` arrived as a DM from the workflow, a bot, not from the owner. A URL in the variable became a Slack link. |

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
    ├── getScheduledTasks() dailyDigest ── handler runs the digest
    └── SQLite              sent_ledger · briefed_threads · briefing_items · watchlist
                            focus_channels · preferences · digest_runs · cursors
                                   │
                                   ▼
        digest      collect conversations → read threads → findings (map)
                    → briefing (reduce) → one message, sources linked inline
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

| Condition                                        | Interval |
| ------------------------------------------------ | -------- |
| Working hours, Mon–Fri 08:00–19:00 Europe/London | 10 s     |
| Overnight and weekends                           | 30 s     |
| Within 15 min of a message from you              | 2 s      |
| Within 20 min of digest delivery                 | 2 s      |

Roughly 5,600 requests a day against a free-plan allowance of 100,000, and about 8% of
the monthly Durable Object duration. Cloudflare is not the constraint here; the
gateway's own rate limiting is the practical ceiling.

**The cadence is not what makes a reply slow.** A poll costs ~1.6 s and the full
pipeline — read, react, model turn, send — is ~7 s, so latency is `poll wait + ~7 s`.
Going from 10 s to 2 s takes a reply from ~12 s to ~8 s; going below 2 s saves under a
second and polls would start to overlap. The model turn is the floor. Push delivery via
a Slack app would remove the poll wait entirely and still land at ~7 s, so it is not a
fix for latency either.

**Active threads cost nothing to watch.** Your replies land inside a thread, which the
top-level read does not expand — but it does annotate the parent with
`Thread: N replies (latest: <ts>)`. The poller compares that timestamp against the last
one it handled and calls `slack_read_thread` only when it has actually advanced.
Polling therefore stays at one call per tick, with a second call only on a real reply
rather than on every tick of an open conversation.

Only parents inside the read window carry that annotation, and the window starts at the
cursor, which moves past the briefing as soon as anything newer is posted. The read
therefore reaches back to the latest briefing for 36 hours (`pollReadOldest()`), so "more
on 3" typed in the briefing's thread is still seen the next afternoon. New top-level
input is still decided by the cursor alone. Threads are filtered by a changed signature
before the three-per-tick cap, so quiet threads in the wider window cannot crowd out
the one that just moved.

**Perceived latency is what to optimize.** The `eyes` reaction lands within a tick and
tells you the agent heard you. A ten-second acknowledgment reads as responsive; ten
seconds of silence does not.

## Daily briefing

A `getScheduledTasks()` handler task fires weekdays at 08:30 Europe/London, matching the
owner's Slack timezone, and runs the digest keyed by the task's `idempotencyKey`.

**Digest, not triage.** The first design searched for keywords and asked the model to
sort each matching message into a section, then posted one message per item. It
produced a thread of 15 to 20 fragments with no overview, each item one message read
out of its conversation. The digest now follows changelog-buddy's pipeline instead:
collect evidence deterministically, have the model evaluate it in batches, synthesise
one briefing from the results, and render one artifact. Slack evidence is
conversational rather than a stream of discrete change events, so the unit is the
conversation: a thread, or a top-level message that started none.

```
collect    searches find where things happen; threads are then read in full
filter     drop what the owner already answered, or what was briefed and has not moved
map        model reads conversations in batches → findings (one fact each, cited)
reduce     model writes the briefing from all findings, merging stories across channels
finalise   ids checked against our records, permalinks attached, mentions guaranteed
render     one numbered message, each item linking its sources
```

The digest runs inside the scheduled task rather than as a Workflow. A run is now one
to a few minutes: 10 to 20 searches, up to 8 focus-channel reads, up to 25 thread
reads, and three to six model calls. A failed run is retried by the agent itself, as
described under "When a briefing fails". Promote it to a Workflow if a run needs
step-level checkpoints.

### Collect

Search is the scarce call, so it is spent on discovery. Thread reads are cheap, so
they are spent on depth.

| Pass           | Pages                           | Purpose                                                                                                                                          |
| -------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mentions       | up to 3                         | `<@U0BUM44636U>` since the window opened, always ranked first                                                                                    |
| Team           | up to 3                         | `devrel`, always searched. People here ask for DevRel in plain words: a month of results held 60+ such messages and no user-group mention at all |
| Owner posts    | up to 3                         | `from:<@owner>`: what the owner has answered, and threads where someone answered them                                                            |
| Watchlist      | up to 2 each, 4 topics          | OCR, Vibe, and anything promoted by feedback                                                                                                     |
| Signal pools   | 1 each, the rest of the 9 slots | `launch·roadmap·shipping·GA·beta·rollout` and `blog·talk·demo·webinar·cookbook·tutorial`, rotated daily                                          |
| Focus channels | 1 read each, up to 8            | read in full instead of sampled; optional, managed in conversation                                                                               |
| Thread reads   | up to 25                        | the highest-ranked conversations, read whole                                                                                                     |

Every query gets its first page. Deeper pages are fetched only where Slack has more,
most valuable query first, within 20 search calls per run, so a quiet day never pages
and a Monday covering the weekend does. Calls are paced to 10 in any minute, Slack's
per-user limit; a rate-limited search waits 20 seconds and retries once. A search that
still fails costs its own query, is counted in the run log, and is reported in the
briefing's footer ("3 of 18 searches failed, so coverage is partial") so a thin
briefing is not mistaken for a quiet day. A 72-hour window, probed live, made 11
searches: no more than 10 in any minute, none failed, and one query paged.

Hits are grouped by thread, using the permalink's `thread_ts`, so three hits from one
launch thread become one conversation rather than three items. The best-ranked
conversations are then read in full: a keyword hit is one message, but the date, the
decision and the ask are usually in the replies. When a thread read and a search hit
disagree about a message, the thread's fuller text wins.

Ranking puts mentions first, then conversations about DevRel, threads where someone
replied after the owner's last post, watchlist topics, focus channels, signal terms,
and thread size. At most 60 conversations reach the model.

### Map and reduce

The reader sees conversations in batches of about 32,000 characters, with the owner's
messages labelled and anything older than the window, or already briefed, marked
`[earlier]` as context. It returns findings: a self-contained fact with a kind (`ask`,
`shipped`, `planned`, `decision`, `feedback`, `event`, `content`), the timing as stated,
a certainty, whether it concerns the owner, and two 0–100 scores, DevRel value and
content value. A failed batch costs only its own conversations.

The editor sees every finding, the items briefed in the last five days, and the learned
preferences. It writes the briefing:

```
TL;DR                one or two sentences: the biggest development, the best content play
Needs you            asks, mentions and replies awaiting the owner
What's new           what shipped, changed, was decided, or moved on the roadmap
Opportunities        launches needing support, events and CFPs, pain points, content requests
Content ideas        up to three: working title, format, hook, why now, effort
```

It is told to merge the same story across channels, to say what changed rather than
repeat a recent item, and never to propose publishing unannounced plans before launch.
If the editor call fails, a plain briefing is built from the findings, so a model
outage costs the polish, not the briefing.

### Delivery

The briefing is **one message**, with items numbered across sections so the owner can
reply about any of them ("more on 3"). The model never supplies a link. It cites
finding ids, and the application maps them to its own conversation records and
attaches permalinks from search results or builds them from known ids. An invented or
mismatched link is therefore not expressible, rather than caught after the fact.
Model-written text is also stripped of link syntax and URLs, and bare domains are
defused so Slack cannot auto-link them.

Each item links its sources inline, up to two and one per channel, and a source
without a valid permalink is named but not linked. A first version put the sources in
a thread reply to keep Slack's link previews out of the briefing, since the send tool
cannot turn them off. The owner preferred the links in place, previews and all.

Each item is one line led by a bold number, under its section's bold heading, with a
blank line between sections. A first version used a Markdown list, which Slack showed
with a bullet in front of every number and no gap after each section, so the briefing
read as one block. A numbered list would keep the numbers but still lose the gap. The
cost of plain lines is that a wrapped item has no hanging indent.

The message is rendered within 4,500 characters, under the 5,000 limit. An Enterprise
Grid permalink is about 120 characters, so links give way first: one per item instead
of two. If it is still over, items are dropped from the end of the longest section,
"Needs you" last, so trimming keeps the briefing balanced. The rest are renumbered, so
stored numbers always match what was shown, and every source stays reachable through
"more on N".

A direct mention is never dropped silently. If the editor leaves out a conversation
that mentions the owner, the finaliser puts it back under Needs you.

### When a briefing fails

In October the Slack connector went down and the agent stayed silent for eight
weekdays: every briefing failed into the run ledger, nothing reached the owner, and the
MCP registration sat in `authenticating` for good. Three rules now cover that, kept as
pure functions in `recovery.ts`:

**The owner is told.** The scheduled task's handler owns its retries, because Think's
retry runs immediately and tells the handler nothing about attempts. A run gets two
quick attempts, the second on the fallback model if the first was rate limited. If both
fail, one line goes to the DM: "Morning briefing · Mon 2 Nov didn't go out: the model
call failed. I'll try again at 09:00." Retries follow at 30 minutes and 2 hours; only
the last failure is announced again, handing over to the next morning. Reasons are
fixed phrases, never raw errors, which can carry tool output.

**The connection heals itself.** The gateway authenticates with a bearer header, so
`authenticating` means it answered 401 and the SDK is waiting for an OAuth callback that
will never come. That, `failed`, and any handshake state lasting over two minutes count
as stuck, and the poller replaces the registration with backoff: at once, then after 1,
2, 4 and 8 minutes, then every 15. While Slack is unreachable the poller reads nothing,
and the scheduled briefing forces one repair before deciding it cannot run.

**It catches up.** A missed briefing is recorded with the start of its window and kept
until a later briefing covers it. When Slack comes back, or a retry succeeds, the
catch-up covers everything since the last briefing that went out, under a line saying
so: "Catching up: briefings haven't gone out since 21 Oct 08:30 (Slack couldn't be
reached)." While Slack itself is down nothing can be posted, not even the notice. The
workflow notification still goes out, since it does not go through the gateway; see
"Notifications".

### Notifications

The agent posts as the owner, and Slack never notifies anyone about their own messages,
so briefings arrived silently, without even an unread badge. The gateway cannot change
that: its seven write tools all act as the owner, and it has no reminder tool.

A Workflow Builder workflow can. It starts from a webhook and sends its one text
variable, `message`, to the owner as a DM. That DM comes from the workflow, not the
owner, so Slack notifies as for any DM, on desktop and phone. It needs no Slack app,
only a paid plan, though admins can restrict who may create webhook workflows. Its URL is
the optional `SLACK_WORKFLOW_URL` secret; without it nothing is sent. The URL is a
credential: anyone who has it can make the workflow DM the owner.

| Event             | Notification, in plain text                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| Briefing          | "Morning briefing · Mon 9 Nov: 5 items, 1 needs you." then the summary and a link to the briefing       |
| Quiet day         | "Morning briefing · Mon 9 Nov: nothing worth surfacing." and a link                                     |
| Failure notice    | the notice itself, and a link to it                                                                     |
| Slack unreachable | "… didn't go out: Slack couldn't be reached. I'll catch up once it's back.", once per scheduled morning |

Replies to the owner raise none. They answer something the owner just sent, so the
owner is usually still watching, and a notification for each would double up during a
conversation.

The webhook does not go through the gateway, so it still works when the gateway does
not. In October it would have announced the outage on its first morning, not eight
weekdays later.

Sending is best effort. The call times out after 10 seconds and never throws, and it
runs after the briefing is recorded, so a failed notification can neither fail nor
repeat a briefing. A refusal is logged without the URL.

## What it decides to watch

Six inputs, in order of strength:

| Input               | Role                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| Owner mention token | always query #1, always ranked first, guaranteed a line                                              |
| Team terms          | `devrel`, always searched and ranked just below a mention; `TEAM_TERMS` in `collect.ts`              |
| Focus channels      | read in full every run; up to 8, managed in conversation, suggested from evidence                    |
| Watchlist           | up to 4 topic queries; seeded `OCR`, `Vibe`; editable in conversation                                |
| Two signal pools    | `launch·roadmap·shipping·GA·beta·rollout`, `blog·talk·demo·webinar·cookbook·tutorial`, rotated daily |
| The model           | reads whole conversations, keeps what a developer advocate needs, writes the briefing                |

Keyword retrieval is blunt on purpose — the gateway AND-s keywords with no OR, and each
query costs one of nine slots. `natural_language_query` is passed on topic and signal
queries for semantic reranking; whether this account supports it is unconfirmed. Focus
channels exist for what keywords miss: in a channel like `#launches`, every message
matters, whatever words it uses.

**Focus channels are suggested, not guessed.** The gateway cannot list the channels the
owner has joined, so suggestions come from evidence: a channel that fed at least three
briefings in the last two weeks, or two items the owner rated useful, and whose items
were not marked noise more often than useful. The briefing then ends with one tip,
"Reply "focus on #launches" to read it in full every morning", and the same channel is
not suggested again for a month. "focus on #launches" resolves the name from channels
recent briefings cited, so it needs no channel search.

**Feedback is a reply.** With one message there is no item to react to, so the owner
replies with a number instead: "3 useful", "5 noise", "2 done". The agent records the
verdict with `rate_briefing_item`, which does two things, as in changelog-buddy:

- The item joins a preference profile of liked and disliked examples, plus preferred
  content formats, that both model passes read on every run.
- The query terms that surfaced it are scored in `topic_signals`. At +2 a term is
  promoted into a scarce topic slot; at −2 it is dropped from the plan entirely, team
  terms included, so the plan moves toward what the owner engages with.
- Its channels count toward a focus-channel suggestion, or against one.

Verdicts are captured as they are given, not harvested a day later, and they work on
any item, including ones the owner never opened.

**Scope is channels only.** `channel_types=public_channel,private_channel`, never the
`im,mpim` default. DMs and group DMs stay out of the sweep and therefore out of model
context.

**Quiet days get one line**, not silence:

```
Morning briefing · Fri 18 Sept — nothing worth surfacing.
Read 7 messages across 3 channels since Thu 22:37.
```

Silence was the original choice and it failed in practice: a correct, on-time, empty run
read as a broken agent, because from the DM there is no difference between the two. The
counts also make the run self-explaining — whether the window was thin or the triage was
strict is visible without opening the run ledger.

Every run is still recorded in `digest_runs` regardless of outcome, and the agent can
report its own run history when asked.

**The window has an 18-hour floor.** Anchoring `since` purely on the previous run let any
run consume the next one's window — a manual test at 22:37 left the 08:30 briefing with
7 messages instead of 63. `briefed_threads` is what prevents repeats, so the window only
has to be wide enough, not exact.

**Repeats are tracked per thread, not per message.** Each conversation behind a
briefing item is recorded with its newest message. It is skipped until something newer
arrives; then it comes back with the briefed part marked as context, and the editor is
told what was said before, so a three-day launch thread reads as a sequence of updates
rather than the same item three times.

**Already-read messages are approximated by engagement.** The gateway exposes no Slack
read state: no `last_read`, and search ignores `is:unread`. A conversation is dropped
when the owner posted after everyone else in it, judged from the thread read, or from
one extra `from:<@owner>` search over the same window when the thread was not read.
Replies that arrive after the owner's last post are kept and ranked up: someone is
waiting on them. Messages read without replying cannot be detected. The drop count is
recorded as `engaged=` in `digest_runs.note`.

## State

All state lives in the agent's Durable Object SQLite, with no D1 binding. No Slack
message text is stored: the digest reads conversations in memory during a run. What
persists is what the model wrote, thread keys and timestamps, and preferences.

| Table               | Holds                                                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sent_ledger`       | timestamp of every agent-sent message; the in-thread loop guard. Pruned at 30 days                                                                  |
| `briefing_items`    | each numbered item delivered, with its sources and any verdict; what "more on 3" resolves against. Pruned at 60 days                                |
| `briefed_threads`   | conversation key → newest message ts when briefed; pruned at 30 days                                                                                |
| `watchlist`         | tracked topics and aliases, editable in conversation                                                                                                |
| `focus_channels`    | channels read in full every run, editable in conversation                                                                                           |
| `preferences`       | liked and disliked examples and preferred formats, fed to both model passes                                                                         |
| `focus_suggestions` | when each channel was last suggested as a focus channel                                                                                             |
| `topic_signals`     | accumulated useful/noise score per query term                                                                                                       |
| `digest_runs`       | run ledger and delivery outcome, with per-stage counts                                                                                              |
| `cursors`           | poll watermarks, thread signatures, last activity, digest and briefing times, workspace host, Slack outage and reconnect state, the missed briefing |

The earlier `seen_items` and `digest_items` tables are no longer used. They are left in
place rather than dropped.

## Configuration

```
MISTRAL_API_KEY      secret   gateway auth and model auth
SLACK_WORKFLOW_URL   secret   optional: the Slack workflow that notifies the owner
OWNER_SLACK_USER_ID  var      U0BUM44636U
OWNER_DM_CHANNEL_ID  var      D0BTQQF7WCW
```

Secrets go in `.env` for local development, which is also where `wrangler types` reads
them from, and are set in production with `wrangler secret put`. The agent reads
`SLACK_WORKFLOW_URL` loosely, so a checkout without it still typechecks.

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

## Operations

`/health` reports MCP connection state, how many of the 12 tools were discovered,
armed schedules, cursors and recent run outcomes. Two query flags force work that would
otherwise wait for an alarm:

| Flag                  | Effect                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `?reconnect=1`        | Drop and re-add the MCP registration now. The poller does this by itself with backoff; this skips the wait. |
| `?poll=1`             | Run a poll immediately instead of waiting for the armed alarm.                                              |
| `?digest=1[&hours=N]` | Run the sweep now, optionally overriding the lookback window.                                               |
| `?reset=seen`         | Forget which threads have been briefed, so conversations can resurface.                                     |

Every run records `searches=… failed_searches=… reads=… messages=… conversations=…
engaged=… briefed_before=… candidates=… findings=… surfaced=… failed_batches=…` in
`digest_runs.note`, so an empty briefing says which stage produced nothing. Without
those counts "empty" is unreadable — it could equally mean a quiet day, a broken
search, or an editor that rejected everything.

`/health` also lists the focus channels, the learned workspace host, the item count of
the latest briefing, and under `recovery` when Slack went down, how many reconnects
have been tried, the missed briefing if any, and pending retries. Under
`notifications` it shows whether a workflow is configured, and when the last
notification was sent and whether Slack accepted it.

These endpoints are unauthenticated. They only touch the owner's own DM and cannot leak
data, but anyone who learns the URL can trigger a poll or a sweep. Add a shared secret
before relying on this unattended.

### Failure modes found in production

Three bugs survived design review and only appeared once deployed. All are fixed; they
are recorded because each was invisible from the outside.

**The tool policy bricked every turn.** `getTools()` threw unless all 12 Slack tools
were present, but Think's `waitForMcpConnections` defaults to `false`, so the first turn
after any cold start saw an empty catalog. Filtering to the allowlist is the security
control; a partial catalog is a readiness signal and is now reported, not thrown.

**A stuck MCP registration could not heal.** `addMcpServer` is idempotent on name+URL
and returns an existing row without redriving it, and the SDK only runs discovery when
connect reports `connected`. A registration left at `connecting` therefore stayed there
across every restart, with `error: null` and no log. `connectSlack()` now drops any
non-ready registration before re-adding, and the poller repairs a dropped connection on
its next tick.

**The cron could defer the poll indefinitely.** The 15-minute cron called `armNextPoll`,
which cancelled the pending poll and re-armed it a full interval out. At idle cadence
the two intervals match, so each tick pushed the poll further away while `/health` still
showed an armed alarm.

**The fix for that then killed the alarm chain.** Keeping "whichever poll fires soonest"
looked right, but `pollInbox` re-arms from its own `finally`, while its schedule row
still exists. That row read as a poll already scheduled sooner, so no new poll was
armed; the SDK then deleted the row and the chain stopped after exactly one tick. The
agent polled only when something external called `armNextPoll`, which during debugging
was masked by repeated `/health` calls appearing to work.

Both cases turn on liveness, which is now the rule in `choosePollSchedule()`: a row at
or before now is the alarm currently executing or one that was missed, and can never
block re-arming; a row strictly in the future is a real pending poll and is never pushed
back. The decision is a pure function so it can be tested without a live Durable Object,
which is what the original change lacked.

**The schema was silently discarded.** `@ai-sdk/openai-compatible` defaults
`supportsStructuredOutputs` to false and drops the JSON schema with only a warning, so
`generateObject` received whatever shape the model chose and failed validation on every
run. Setting the flag on the provider fixes it.

**A bad triage run burned a day of candidates.** Every retrieved item was marked seen
whether or not it was briefed, so one failed or over-strict triage permanently buried
that day's material. Only surfaced items are marked now; rejected ones are cheap to
reconsider and usually fall outside the next window anyway.

**Untruncated context degraded triage.** `include_context: true` appends surrounding
messages to every hit, and 63 untruncated candidates produced a prompt that returned
zero items where a truncated one returned four. A 1M-token context means input _fits_,
not that the model reasons well over it. The digest's answer is the map pass: whole
conversations, but in batches of about 32,000 characters, each conversation capped at
6,000 by keeping its root and newest messages.

**Replies were invisible.** Conversational replies were posted as thread replies, which
Slack does not surface in the main DM pane — and because the agent posts under the
owner's own account, no notification is raised either. The agent looked dead while
answering every message. Conversational replies now set `reply_broadcast`.

**An outage went unnoticed for eight weekdays.** From 21 October the Slack connector
answered 401. The registration went to `authenticating`, which the repair logic did
not treat as dead, every scheduled briefing failed into the run ledger, and nothing was
said in the DM. It surfaced only when `/health` was read on 1 November. Failures are
now announced, stuck states are repaired with backoff, and missed windows are caught up;
see "When a briefing fails".

## Known tradeoffs

- Replies are authored by you. Private to your DM, but visibly your account.
- Latency is 10 s mid-conversation, up to 15 min when idle overnight. Never instant.
- Polling spends MCP calls while idle.
- Search is a sample, not full channel coverage. Briefings should report partial
  coverage rather than imply completeness. Focus channels are the exception, up to 8.
- Sources are linked inline, so Slack may show previews under the briefing; the send
  tool cannot turn them off. On a heavy day, links drop to one per item before any
  item is cut.
- A briefing costs three to six model calls instead of one, plus up to 25 thread reads.
- Staying under Slack's search limit costs time: a run needing more than 10 searches
  waits for the minute to roll over, so a busy day's search phase takes one to two
  minutes.
- While Slack itself is unreachable no notice can be posted in the DM. The workflow
  notification says so, and the catch-up after Slack returns says what was missed.
- Notifications arrive in the workflow's own DM, a tap away from the briefing, and
  replies to the owner raise none.

## Migration path to a bot app

If a Slack app is later approved for the workspace, the agent gains a distinct
identity, real-time events, and `app_mention` in shared channels. Keep inbound and
outbound behind one `Transport` interface (`poll()`, `deliver()`, `acknowledge()`) so
the swap to Think messengers with `@chat-adapter/slack` touches only that module.
Retrieval, ranking, synthesis, and state are unaffected.

Note that Think ships a Telegram messenger adapter only; Slack would go through the
generic `chatSdkMessenger()` with `@chat-adapter/slack`, in single-workspace mode with
`SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`.
