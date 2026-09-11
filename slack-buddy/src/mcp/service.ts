import type { Env } from "../env";
import { SlackMcp, McpFailure } from "./client";
import { AppStore } from "./store";
import { retrieve } from "./retrieve";
import { summarize, researchPlan, type Briefing } from "./model";
import { envelope } from "./normalize";
import {
  digestWindowForDate,
  localDateAt,
  targetDigestDate,
} from "../domain/time";

export async function generateBriefing(
  env: Env,
  input: {
    id: string;
    question?: string;
    conversation?: Array<{ role: "user" | "assistant"; content: string }>;
    start: number;
    end: number;
    kind: "briefing" | "research" | "scheduled";
  },
) {
  const store = new AppStore(env.DB, env.SLACK_USER_ID);
  await store.begin(input.id, input.kind);
  const mcp = new SlackMcp(env.MISTRAL_API_KEY);
  const began = Date.now();
  let requests = 0,
    results = 0,
    partial = true;
  try {
    const { settings } = await store.settings();
    const plan = input.question
      ? await researchPlan(env, input.question, input.conversation)
      : undefined;
    const retrieval = await retrieve(
      mcp,
      settings,
      env.SLACK_USER_ID,
      input.start,
      input.end,
      { plan },
    );
    requests = retrieval.requests;
    results = retrieval.sources.length;
    partial = retrieval.partial;
    const briefing = await summarize(
      env,
      settings,
      retrieval,
      input.question,
      input.conversation,
    );
    await store.finish(input.id, requests, results, partial);
    return {
      runId: input.id,
      generatedAt: Date.now(),
      window: { start: input.start, end: input.end },
      briefing,
      coverage: retrieval.coverage,
      metrics: {
        requests,
        matches: results,
        durationMs: Date.now() - began,
        partial,
      },
    };
  } catch (error) {
    const code = error instanceof McpFailure ? error.code : "generation_failed";
    await store.finish(input.id, requests, results, true, code);
    throw new Error(code);
  } finally {
    await mcp.close();
  }
}

export function deliveryPages(
  briefing: Briefing,
  window: { start: number; end: number },
  partial: boolean,
  timezone = "Europe/Paris",
): string[] {
  const sections = {
    attention: "Needs your attention",
    radar: "Your radar",
    upcoming: "Coming soon",
    content: "Content opportunities",
  };
  const date = localDateAt(window.end - 1, timezone);
  const intro = `**Slack Buddy · DevRel briefing · ${date}**\n${partial ? "Coverage is partial. Some searches or context reads were limited." : "Based on targeted searches; this is not an exhaustive workspace scan."}\n`;
  const blocks = briefing.items.map(
    (item) =>
      `\n**${sections[item.section]} · ${item.title}**\n${item.summary}\n${item.why}\n${item.section === "upcoming" ? `Status: ${item.certainty}\n` : ""}${item.section === "content" ? `Audience: ${item.audience} · Format: ${item.format}\nConfirm readiness before publishing.\n` : ""}${item.nextStep ? `Next: ${item.nextStep}\n` : ""}${item.sources.map((s) => `[Open #${s.channelName}](${s.url})`).join(" · ")}\n`,
  );
  const pages: string[] = [];
  let page = intro;
  for (const block of blocks) {
    if (page.length + block.length > 4900) {
      pages.push(page);
      page = intro;
    }
    page += block;
  }
  if (!blocks.length) page += `\n${briefing.overview}`;
  pages.push(page);
  return pages.map(
    (text, index) =>
      text + (pages.length > 1 ? `\nPart ${index + 1}/${pages.length}` : ""),
  );
}
export async function sendBriefing(
  env: Env,
  runId: string,
  briefing: Briefing,
  window: { start: number; end: number },
  partial: boolean,
) {
  const store = new AppStore(env.DB, env.SLACK_USER_ID);
  if (!(await store.deliveryIntent(runId)))
    throw new Error("delivery_already_attempted");
  const mcp = new SlackMcp(env.MISTRAL_API_KEY);
  let sent = 0;
  try {
    const { settings } = await store.settings();
    const pages = deliveryPages(briefing, window, partial, settings.timezone);
    for (const page of pages) {
      const result = await mcp.send(env.SLACK_USER_ID, page);
      const data = envelope(result);
      if (data.error || data.ok === false) throw new Error("delivery_failed");
      sent++;
    }
    await store.delivered(runId, null, null);
    return { sent, pages: pages.length };
  } catch {
    // The gateway exposes no message-update or idempotency-key parameter.
    // Persist uncertainty; an HTTP retry must never send the same pages again.
    await store.delivered(runId, null, null, "uncertain");
    throw new Error("delivery_uncertain");
  } finally {
    await mcp.close();
  }
}

export async function scheduledBriefing(env: Env, now = Date.now()) {
  const store = new AppStore(env.DB, env.SLACK_USER_ID);
  await store.cleanup();
  if (env.SLACK_BUDDY_SCHEDULED_MCP_ENABLED !== "true") return;
  const { settings } = await store.settings();
  if (!settings.dailyDelivery) return;
  const date = targetDigestDate(now, settings.timezone, settings.digestHour);
  if (!date) return;
  const window = digestWindowForDate(date, settings.timezone);
  const id = `daily:${env.SLACK_USER_ID}:${date}`;
  try {
    const result = await generateBriefing(env, {
      id,
      kind: "scheduled",
      start: window.startMs,
      end: window.endMs,
    });
    if (result.coverage.every((c) => ["failed", "skipped"].includes(c.status)))
      return;
    await sendBriefing(
      env,
      id,
      result.briefing,
      result.window,
      result.metrics.partial,
    );
  } catch (e) {
    if (e instanceof Error && ["run_exists", "run_busy"].includes(e.message))
      return;
    // No source text, model output, or connector errors in persistent logs.
    console.error("Slack Buddy scheduled briefing did not complete");
  }
}
