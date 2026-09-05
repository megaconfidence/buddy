import type {
  ChangeEvent,
  DigestWindow,
  EditorialDigest,
  EditorialItem,
  FeedbackValue,
} from "../domain/types";
import { signFeedbackToken } from "../feedback/tokens";

const MISTRAL_LOGO_CID = "mistral-logo";
const COLOR = {
  cream: "#FAFAF4",
  creamStrong: "#F2F1E8",
  navy: "#151524",
  navyMuted: "#56566C",
  orange: "#FA500F",
  orangeSoft: "#FFF0EB",
  tangerine: "#FF8204",
  yellow: "#FFAF01",
  yellowSoft: "#FFF4D2",
  border: "#E4E2D6",
  red: "#E51300",
  white: "#FFFFFF",
} as const;

type SourceHealth = {
  name: string;
  lastSuccessAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
};

export type RenderedEmail = {
  subject: string;
  html: string;
  text: string;
  eventIds: string[];
};

export async function renderDigestEmail(input: {
  digestId: string;
  digest: EditorialDigest;
  events: ChangeEvent[];
  window: DigestWindow;
  sourceHealth: SourceHealth[];
  publicBaseUrl: string;
  feedbackSecret: string;
}): Promise<RenderedEmail> {
  const eventsById = new Map(input.events.map((event) => [event.id, event]));
  const mustKnow = input.digest.items.filter(
    (item) => item.category === "must_know",
  );
  const contentCandidates = input.digest.items
    .filter(
      (item) =>
        item.category !== "must_know" &&
        item.category !== "reliability" &&
        item.contentPotential >= 60 &&
        item.recommendedFormats.length > 0,
    )
    .sort((left, right) => right.contentPotential - left.contentPotential)
    .slice(0, 3);
  const used = new Set(
    [...mustKnow, ...contentCandidates].map((item) => item.id),
  );
  const other = input.digest.items
    .filter((item) => !used.has(item.id))
    .slice(0, 7);
  const failingSources = input.sourceHealth.filter(
    (source) => source.consecutiveFailures > 0 || source.lastSuccessAt === null,
  );
  const subject = `${subjectPrefix(input.digestId)}Mistral Daily Brief — ${contentCandidates.length} content ${
    contentCandidates.length === 1 ? "opportunity" : "opportunities"
  }, ${mustKnow.length} must-${mustKnow.length === 1 ? "know" : "knows"} — ${
    input.window.localDate
  }`;

  const renderItem = async (
    item: EditorialItem,
    includeIdeas: boolean,
  ): Promise<string> => {
    const events = item.eventIds.flatMap((id) => {
      const event = eventsById.get(id);
      return event ? [event] : [];
    });
    const links = uniqueSources(events)
      .map(
        (event) =>
          `<a href="${escapeAttribute(safeExternalUrl(event.canonicalUrl))}" style="color:${COLOR.orange};text-decoration:underline;text-underline-offset:2px">${escapeHtml(event.sourceName)}</a>`,
      )
      .join(" · ");
    const feedback = await feedbackLinks(
      {
        ...input,
        expiresAt: input.window.endMs + 30 * 86_400_000,
      },
      item,
    );
    const formats = item.recommendedFormats
      .map((format) => formatLabel(format))
      .join(" · ");
    const accent = itemAccent(item);
    return `<div style="border:1px solid ${COLOR.border};border-top:5px solid ${accent};padding:20px;margin:12px 0;background:${COLOR.white}">
      <div style="font-family:Inter,Arial,sans-serif;font-size:14px;line-height:1.5;color:${COLOR.navyMuted};margin-bottom:8px">${escapeHtml(
        formats || item.category.replaceAll("_", " "),
      )} · Potential ${item.contentPotential}/100 · ${escapeHtml(item.effort)} effort</div>
      <h3 style="font-family:Inter,Arial,sans-serif;font-size:18px;line-height:1.35;margin:0 0 10px;color:${COLOR.navy}">${escapeHtml(item.title)}</h3>
      <p style="margin:0 0 10px;line-height:1.6;color:${COLOR.navy}">${escapeHtml(item.summary)}</p>
      <p style="margin:0 0 10px;line-height:1.6;color:${COLOR.navy}"><strong>Why developers care:</strong> ${escapeHtml(item.developerImpact)}</p>
      ${
        includeIdeas && item.suggestedHook
          ? `<div style="background:${COLOR.orangeSoft};border-left:4px solid ${COLOR.orange};padding:12px 14px;margin:12px 0;color:${COLOR.navy};line-height:1.55"><strong>Suggested hook</strong><br>${escapeHtml(item.suggestedHook)}</div>`
          : ""
      }
      ${
        includeIdeas && item.demoIdea
          ? `<div style="background:${COLOR.yellowSoft};border-left:4px solid ${COLOR.yellow};padding:12px 14px;margin:12px 0;color:${COLOR.navy};line-height:1.55"><strong>Demo idea</strong><br>${escapeHtml(item.demoIdea)}</div>`
          : ""
      }
      <p style="margin:12px 0 0;font-size:14px;line-height:1.5;color:${COLOR.navyMuted}">Sources: ${links || "Source unavailable"}</p>
      <div style="margin:16px 0 0">${feedback}</div>
    </div>`;
  };

  const contentHtml = await Promise.all(
    contentCandidates.map((item) => renderItem(item, true)),
  );
  const mustKnowHtml = await Promise.all(
    mustKnow.map((item) => renderItem(item, false)),
  );
  const otherHtml = await Promise.all(
    other.map((item) => renderItem(item, false)),
  );
  const coverage = `${input.sourceHealth.length - failingSources.length}/${
    input.sourceHealth.length
  } sources healthy`;
  const preheader = escapeHtml(input.digest.overview.slice(0, 180));

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="light">
  </head>
  <body style="margin:0;background:${COLOR.creamStrong};font-family:Inter,Arial,Helvetica,sans-serif;font-size:16px;color:${COLOR.navy}">
    <div style="display:none;max-height:0;overflow:hidden">${preheader}</div>
    <main style="max-width:660px;margin:0 auto;padding:28px 12px">
      <div style="background:${COLOR.white};border:1px solid ${COLOR.border}">
        ${pixelStripe()}
        <div style="padding:30px 28px 26px">
          <img src="cid:${MISTRAL_LOGO_CID}" width="168" alt="Mistral AI" style="display:block;width:168px;max-width:55%;height:auto;margin:0 0 30px">
          <div style="font-family:Inter,Arial,sans-serif;font-size:14px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${COLOR.orange};margin-bottom:8px">Changelog Buddy / ${escapeHtml(input.window.localDate)}</div>
          <h1 style="font-family:Inter,Arial,sans-serif;font-size:30px;line-height:1.12;letter-spacing:-.02em;margin:0 0 14px;color:${COLOR.navy}">Mistral <span style="color:${COLOR.orange}">Daily Brief</span></h1>
          <p style="margin:0;line-height:1.65;font-size:16px;color:${COLOR.navy}">${escapeHtml(input.digest.overview)}</p>
        </div>
      </div>
      ${section("Top content opportunities", contentHtml, "No strong content candidates today.")}
      ${section("Must know", mustKnowHtml, "No breaking, security, or migration alerts.")}
      ${section("Other updates", otherHtml, "No additional updates.")}
      <div style="background:${COLOR.navy};color:${COLOR.cream};padding:22px 24px;font-family:Inter,Arial,sans-serif;font-size:14px;line-height:1.7">
        <strong style="color:${COLOR.yellow}">SOURCE HEALTH</strong><br>
        ${escapeHtml(coverage)}<br>
        Coverage ${escapeHtml(formatCoverage(input.window))}
        ${failingSources.length > 0 ? `<br>Unavailable: ${escapeHtml(failingSources.map((source) => source.name).join(", "))}` : ""}
      </div>
      ${pixelStripe()}
    </main>
  </body>
</html>`;

  const text = renderText(
    input.digest,
    mustKnow,
    contentCandidates,
    other,
    eventsById,
    coverage,
    input.window,
  );
  return {
    subject,
    html,
    text,
    eventIds: [...new Set(input.digest.items.flatMap((item) => item.eventIds))],
  };
}

async function feedbackLinks(
  input: {
    digestId: string;
    publicBaseUrl: string;
    feedbackSecret: string;
    expiresAt: number;
  },
  item: EditorialItem,
): Promise<string> {
  const values: Array<[string, FeedbackValue]> = [
    ["Worth pursuing", "pursue"],
    ["Not relevant", "not_relevant"],
    ["Handled", "handled"],
  ];
  const links = await Promise.all(
    values.map(async ([label, value]) => {
      const token = await signFeedbackToken(input.feedbackSecret, {
        digestId: input.digestId,
        itemId: item.id,
        value,
        expiresAt: input.expiresAt,
      });
      const url = new URL("/feedback", input.publicBaseUrl);
      url.searchParams.set("token", token);
      const style =
        value === "pursue"
          ? `background:${COLOR.navy};border:1px solid ${COLOR.navy};color:${COLOR.white}`
          : `background:${COLOR.white};border:1px solid ${COLOR.border};color:${COLOR.navy}`;
      return `<a href="${escapeAttribute(url.toString())}" style="display:inline-block;${style};font-family:Inter,Arial,sans-serif;font-size:14px;font-weight:600;text-decoration:none;padding:9px 12px;margin:0 6px 6px 0;border-radius:8px">${label}</a>`;
    }),
  );
  return links.join("");
}

function section(title: string, items: string[], empty: string): string {
  return `<section style="margin:26px 0">
    <div style="display:inline-block;background:${COLOR.navy};color:${COLOR.white};font-family:Inter,Arial,sans-serif;font-size:14px;font-weight:700;line-height:1;padding:9px 12px;letter-spacing:.05em;text-transform:uppercase">${escapeHtml(title)}</div>
    ${items.length > 0 ? items.join("") : `<div style="border:1px solid ${COLOR.border};background:${COLOR.cream};padding:18px;font-size:16px;color:${COLOR.navyMuted}">${escapeHtml(empty)}</div>`}
  </section>`;
}

function renderText(
  digest: EditorialDigest,
  mustKnow: EditorialItem[],
  content: EditorialItem[],
  other: EditorialItem[],
  eventsById: Map<string, ChangeEvent>,
  coverage: string,
  window: DigestWindow,
): string {
  const itemText = (item: EditorialItem) => {
    const sources = item.eventIds
      .flatMap((id) => {
        const event = eventsById.get(id);
        return event ? [safeExternalUrl(event.canonicalUrl)] : [];
      })
      .filter((value, index, values) => values.indexOf(value) === index)
      .join(", ");
    return `- ${item.title}\n  ${item.summary}\n  Why developers care: ${item.developerImpact}${
      item.suggestedHook ? `\n  Suggested hook: ${item.suggestedHook}` : ""
    }${item.demoIdea ? `\n  Demo idea: ${item.demoIdea}` : ""}\n  Sources: ${sources}`;
  };
  return [
    `MISTRAL DAILY BRIEF`,
    digest.overview,
    "",
    "TOP CONTENT OPPORTUNITIES",
    ...(content.length > 0 ? content.map(itemText) : ["No strong candidates."]),
    "",
    "MUST KNOW",
    ...(mustKnow.length > 0 ? mustKnow.map(itemText) : ["No alerts."]),
    "",
    "OTHER UPDATES",
    ...(other.length > 0 ? other.map(itemText) : ["No additional updates."]),
    "",
    `SOURCE HEALTH: ${coverage}`,
    `COVERAGE: ${formatCoverage(window)}`,
  ].join("\n");
}

function uniqueSources(events: ChangeEvent[]): ChangeEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    if (seen.has(event.canonicalUrl)) return false;
    seen.add(event.canonicalUrl);
    return true;
  });
}

function formatLabel(
  value: EditorialItem["recommendedFormats"][number],
): string {
  return {
    social_post: "Social post",
    demo_app: "Demo app",
    cookbook: "Cookbook",
    video: "Video",
  }[value];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function safeExternalUrl(value: string): string {
  try {
    const url = new URL(value);
    const allowed =
      url.protocol === "https:" &&
      [
        "docs.mistral.ai",
        "github.com",
        "huggingface.co",
        "mistral.ai",
        "pypi.org",
        "status.mistral.ai",
        "www.mistral.ai",
        "www.npmjs.com",
      ].includes(url.hostname);
    return allowed ? url.toString() : "https://docs.mistral.ai/";
  } catch {
    return "https://docs.mistral.ai/";
  }
}

function isTestDigest(digestId: string): boolean {
  return /(?:^|-)e2e(?:-|$)|(?:^|-)test(?:-|$)/iu.test(digestId);
}

function subjectPrefix(digestId: string): string {
  if (isTestDigest(digestId)) return "[TEST] ";
  return /(?:^|-)preview(?:-|$)/iu.test(digestId) ? "[PREVIEW] " : "";
}

function formatCoverage(window: DigestWindow): string {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: window.timezone,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  });
  return `${formatter.format(new Date(window.startMs))} – ${formatter.format(
    new Date(window.endMs),
  )}`;
}

function itemAccent(item: EditorialItem): string {
  if (item.category === "must_know") return COLOR.red;
  if (item.category === "reliability") return "#0082E6";
  if (item.contentPotential >= 75) return COLOR.orange;
  return COLOR.yellow;
}

function pixelStripe(): string {
  const colors = [
    "#E51300",
    COLOR.orange,
    COLOR.tangerine,
    "#FF9C00",
    COLOR.yellow,
    "#FFE000",
  ];
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse"><tr>${colors
    .map(
      (color) =>
        `<td style="height:9px;background:${color};font-size:0;line-height:0">&nbsp;</td>`,
    )
    .join("")}</tr></table>`;
}
