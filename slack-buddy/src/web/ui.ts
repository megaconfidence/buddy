export function renderApp(nonce: string) {
  return `
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>Slack Buddy — Your DevRel radar</title>
    <style nonce="${nonce}">
      :root {
        --paper: #f7f6f2;
        --ink: #252824;
        --muted: #6b716b;
        --line: #dddfd7;
        --accent: #4e6348;
        --wash: #e8eee3;
        --purple: #776391;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        background: var(--paper);
        color: var(--ink);
        font:
          15px/1.55 system-ui,
          -apple-system,
          BlinkMacSystemFont,
          "Segoe UI",
          sans-serif;
      }
      button,
      input,
      textarea,
      select {
        font: inherit;
      }
      button {
        cursor: pointer;
      }
      button:disabled {
        opacity: 0.55;
        cursor: wait;
      }
      a {
        color: var(--accent);
      }
      [hidden] {
        display: none !important;
      }
      .shell {
        max-width: 1440px;
        margin: auto;
        display: grid;
        grid-template-columns: 240px 1fr;
        min-height: 100vh;
      }
      .sidebar {
        padding: 38px 25px;
        border-right: 1px solid var(--line);
        display: flex;
        flex-direction: column;
        gap: 40px;
      }
      .brand {
        font-size: 21px;
        letter-spacing: -0.6px;
        font-weight: 700;
      }
      .brand span {
        display: inline-grid;
        place-items: center;
        background: var(--ink);
        color: white;
        width: 30px;
        height: 30px;
        border-radius: 9px;
        margin-right: 9px;
        font-size: 17px;
      }
      .eyebrow {
        text-transform: uppercase;
        letter-spacing: 1.8px;
        font-size: 11px;
        font-weight: 700;
        color: var(--muted);
      }
      .nav {
        display: grid;
        gap: 8px;
      }
      .nav button {
        text-align: left;
        border: 0;
        background: transparent;
        padding: 12px 14px;
        color: var(--muted);
        border-radius: 8px;
      }
      .nav button[aria-selected="true"] {
        background: var(--wash);
        color: var(--ink);
        font-weight: 650;
      }
      .side-bottom {
        margin-top: auto;
        color: var(--muted);
        font-size: 12px;
      }
      .side-bottom button {
        margin-top: 15px;
      }
      .main {
        padding: 42px 6vw 60px;
        min-width: 0;
      }
      .topbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 18px;
        padding-bottom: 27px;
        border-bottom: 1px solid var(--line);
        margin-bottom: 36px;
      }
      .status-dot {
        display: inline-block;
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: #6d895f;
        margin-right: 8px;
      }
      .tag {
        font-size: 12px;
        display: inline-block;
        border-radius: 20px;
        padding: 4px 11px;
        background: var(--wash);
        color: var(--accent);
      }
      h1 {
        font-family: Georgia, serif;
        font-size: 46px;
        line-height: 1.12;
        font-weight: 400;
        letter-spacing: -1.4px;
        margin: 16px 0;
      }
      h2 {
        font-family: Georgia, serif;
        font-size: 26px;
        font-weight: 400;
        letter-spacing: -0.5px;
        margin: 0 0 12px;
      }
      h3 {
        font-size: 17px;
        line-height: 1.4;
        margin: 10px 0;
      }
      p {
        margin: 0 0 14px;
      }
      .muted {
        color: var(--muted);
      }
      .intro {
        max-width: 670px;
        font-size: 16px;
        color: var(--muted);
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 12px;
        margin: 25px 0;
      }
      .button {
        border: 1px solid var(--line);
        background: transparent;
        padding: 10px 17px;
        border-radius: 7px;
        color: var(--ink);
        font-weight: 600;
      }
      .button.primary {
        background: var(--ink);
        border-color: var(--ink);
        color: white;
      }
      .button.small {
        font-size: 12px;
        padding: 6px 10px;
      }
      .button:hover:not(:disabled) {
        border-color: var(--accent);
      }
      input,
      textarea,
      select {
        border: 1px solid var(--line);
        border-radius: 7px;
        padding: 11px 12px;
        background: white;
        color: var(--ink);
        max-width: 100%;
      }
      input:focus,
      textarea:focus,
      select:focus,
      button:focus-visible {
        outline: 2px solid var(--purple);
        outline-offset: 3px;
      }
      textarea {
        width: 100%;
        min-height: 120px;
        resize: vertical;
      }
      label {
        display: block;
        font-weight: 600;
        font-size: 13px;
        margin: 16px 0 6px;
      }
      label.check {
        display: flex;
        gap: 10px;
        align-items: flex-start;
        font-weight: 400;
      }
      label.check input {
        margin-top: 5px;
      }
      .focus-strip {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin: 25px 0;
      }
      .focus-strip .tag {
        background: #eae5ef;
        color: #635275;
      }
      .lanes {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 14px;
        margin-top: 32px;
      }
      .lane {
        border: 1px solid var(--line);
        padding: 22px;
        border-radius: 9px;
      }
      .lane .number {
        font-family: Georgia, serif;
        font-size: 28px;
        color: #9b9f94;
        margin-bottom: 15px;
      }
      .lane p {
        font-size: 13px;
        color: var(--muted);
      }
      .notice {
        padding: 14px 18px;
        border: 1px solid #d7d1bb;
        background: #f2eedf;
        border-radius: 8px;
        margin-bottom: 22px;
      }
      .notice.error {
        border-color: #d7b5b0;
        background: #f5e8e5;
        color: #743c35;
      }
      .notice.success {
        background: var(--wash);
        border-color: #c7d5be;
      }
      .busy {
        display: flex;
        gap: 13px;
        align-items: center;
        padding: 20px 0;
        color: var(--muted);
      }
      .spinner {
        width: 18px;
        height: 18px;
        border: 2px solid var(--line);
        border-top-color: var(--accent);
        border-radius: 50%;
        animation: spin 1s linear infinite;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
      .results {
        margin-top: 32px;
      }
      .result-heading {
        display: flex;
        gap: 15px;
        justify-content: space-between;
        align-items: center;
        border-top: 1px solid var(--line);
        padding-top: 24px;
      }
      .cards {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 16px;
        margin: 15px 0 28px;
      }
      .card {
        background: #fff;
        border: 1px solid var(--line);
        border-radius: 9px;
        padding: 23px;
        overflow-wrap: anywhere;
      }
      .card p {
        font-size: 14px;
      }
      .card .next {
        background: var(--paper);
        padding: 12px;
        border-radius: 5px;
        font-size: 13px;
        margin-top: 15px;
      }
      .sources {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        margin-top: 14px;
        font-size: 12px;
      }
      .card details {
        font-size: 12px;
        margin: 12px 0;
        color: var(--muted);
      }
      .card blockquote {
        margin: 10px 0;
        padding-left: 12px;
        border-left: 2px solid var(--line);
        white-space: pre-wrap;
      }
      .feedback-row {
        border-top: 1px solid var(--line);
        padding-top: 12px;
        margin-top: 18px;
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }
      .coverage {
        border: 1px solid var(--line);
        padding: 16px;
        border-radius: 8px;
        margin: 20px 0;
        font-size: 13px;
      }
      .coverage ul {
        padding-left: 20px;
      }
      .settings-block {
        border-top: 1px solid var(--line);
        padding: 25px 0;
      }
      .priority-row {
        display: grid;
        grid-template-columns: 1fr 2fr auto;
        gap: 10px;
        align-items: end;
        margin-bottom: 12px;
      }
      .form-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 22px;
      }
      .form-grid input {
        width: 100%;
      }
      .settings-note {
        font-size: 12px;
        color: var(--muted);
        margin-top: 7px;
      }
      .quick-questions {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        margin-top: 12px;
      }
      .run {
        display: flex;
        justify-content: space-between;
        gap: 20px;
        padding: 17px 0;
        border-bottom: 1px solid var(--line);
        font-size: 13px;
      }
      .run strong {
        display: block;
      }
      .run small {
        color: var(--muted);
      }
      .login-wrap {
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 30px;
      }
      .login-card {
        max-width: 440px;
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 38px;
        background: white;
      }
      .login-card h1 {
        font-size: 34px;
      }
      .login-card input {
        width: 100%;
      }
      .login-card .button {
        width: 100%;
        margin-top: 20px;
      }
      .footer-note {
        font-size: 12px;
        color: var(--muted);
        margin-top: 35px;
      }
      .formats {
        display: flex;
        gap: 16px;
        flex-wrap: wrap;
      }
      .formats label {
        margin: 0;
      }
      .research-box {
        background: white;
        border: 1px solid var(--line);
        padding: 22px;
        border-radius: 9px;
      }
      .result-context {
        font-size: 12px;
        color: var(--muted);
      }
      @media (max-width: 950px) {
        .shell {
          grid-template-columns: 190px 1fr;
        }
        .main {
          padding: 32px;
        }
        .sidebar {
          padding: 30px 16px;
        }
        .cards {
          grid-template-columns: 1fr;
        }
        .lanes {
          grid-template-columns: 1fr;
        }
        .lane .number {
          display: none;
        }
      }
      @media (max-width: 650px) {
        .shell {
          display: block;
        }
        .sidebar {
          border-right: 0;
          border-bottom: 1px solid var(--line);
          padding: 18px 20px;
          gap: 18px;
        }
        .nav {
          display: flex;
          overflow: auto;
          gap: 4px;
        }
        .nav button {
          white-space: nowrap;
          padding: 8px 10px;
          font-size: 13px;
        }
        .side-bottom {
          display: none;
        }
        .main {
          padding: 24px 20px;
        }
        .topbar {
          margin-bottom: 25px;
          padding-bottom: 20px;
        }
        h1 {
          font-size: 36px;
        }
        .priority-row {
          grid-template-columns: 1fr;
        }
        .priority-row .button {
          justify-self: start;
        }
        .form-grid {
          grid-template-columns: 1fr;
        }
        .result-heading {
          align-items: flex-start;
          flex-direction: column;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .spinner {
          animation: none;
        }
      }
      .priority-row input,
      .wide {
        width: 100%;
      }
      .actions label {
        margin: 0;
      }
      #mobile-logout {
        display: none;
        white-space: nowrap;
      }
      #today {
        white-space: nowrap;
      }
      @media (max-width: 650px) {
        #mobile-logout {
          display: inline-block;
        }
        .topbar {
          gap: 12px;
        }
      }
    </style>
  </head>
  <body>
    <div id="login" class="login-wrap" hidden>
      <form id="login-form" class="login-card">
        <div class="brand"><span>b</span>slack buddy</div>
        <h1>Your private<br />DevRel radar.</h1>
        <p class="muted">
          Sign in to catch up, look ahead, and find your next content idea.
        </p>
        <div id="login-error" class="notice error" role="alert" hidden></div>
        <label for="password">Owner access key</label
        ><input
          id="password"
          type="password"
          autocomplete="current-password"
          required
          maxlength="256"
        /><button class="button primary" type="submit">Sign in</button>
        <p class="footer-note">
          Use your app's owner access key, not your Mistral API key.
        </p>
      </form>
    </div>
    <div id="app" class="shell" hidden>
      <aside class="sidebar">
        <div class="brand"><span>b</span>slack buddy</div>
        <nav class="nav" aria-label="Main navigation">
          <button data-tab="briefing" aria-selected="true">Your briefing</button
          ><button data-tab="research" aria-selected="false">
            Ask & explore</button
          ><button data-tab="priorities" aria-selected="false">
            Priorities</button
          ><button data-tab="activity" aria-selected="false">Activity</button>
        </nav>
        <div class="side-bottom">
          <span class="status-dot"></span>Private · Just for you<br />Context
          from your approved Slack connection.<br /><button
            id="logout"
            class="button small"
          >
            Sign out
          </button>
        </div>
      </aside>
      <main class="main">
        <header class="topbar">
          <span class="eyebrow">A little context. A clearer day.</span
          ><span id="today" class="muted"></span
          ><button id="mobile-logout" class="button small">Sign out</button>
        </header>
        <div
          id="notice"
          class="notice"
          role="status"
          aria-live="polite"
          hidden
        ></div>
        <section id="panel-briefing">
          <span class="eyebrow">Your daily perspective</span>
          <h1>Know what matters.<br />See what’s next.</h1>
          <p class="intro">
            A focused view of developer signals, upcoming changes, and content
            opportunities — with the sources to follow through.
          </p>
          <div id="focus-tags" class="focus-strip"></div>
          <div class="actions">
            <button id="generate" class="button primary">
              Generate my briefing <span aria-hidden="true">↗</span></button
            ><label for="days" class="muted">Look back</label
            ><select id="days">
              <option value="1">24 hours</option>
              <option value="3">3 days</option>
              <option value="7">7 days</option>
            </select>
          </div>
          <div id="empty-lanes" class="lanes">
            <div class="lane">
              <div class="number">01</div>
              <h3>Your radar</h3>
              <p>
                What changed, what developers are asking, and why it matters to
                your work.
              </p>
            </div>
            <div class="lane">
              <div class="number">02</div>
              <h3>Coming soon</h3>
              <p>
                Plans, launches, and dates to prepare for — with uncertainty
                made clear.
              </p>
            </div>
            <div class="lane">
              <div class="number">03</div>
              <h3>Content opportunities</h3>
              <p>
                Specific angles and audiences, grounded in real developer
                conversations.
              </p>
            </div>
          </div>
        </section>
        <section id="panel-research" hidden>
          <span class="eyebrow">Follow your curiosity</span>
          <h1>A question worth exploring.</h1>
          <p class="intro">
            Ask a focused question. Buddy searches your joined channels and
            brings back source-linked findings. Follow-up questions use this
            session’s context and fresh searches.
          </p>
          <form id="research-form" class="research-box">
            <label for="question">What would you like to understand?</label
            ><textarea
              id="question"
              maxlength="1500"
              required
              placeholder="What questions are developers asking about OCR, and which could make a useful tutorial?"
            ></textarea>
            <div class="actions">
              <button class="button primary" type="submit">
                Explore in Slack ↗</button
              ><span class="settings-note"
                >Up to 7 days of recent activity</span
              >
            </div>
          </form>
          <div class="quick-questions">
            <button
              class="button small"
              data-question="What OCR developer questions could make a useful tutorial?"
            >
              OCR content ideas</button
            ><button
              class="button small"
              data-question="What is coming soon for Vibe, and what should a DevRel prepare?"
            >
              What’s next for Vibe?
            </button>
          </div>
        </section>
        <section id="panel-priorities" hidden>
          <span class="eyebrow">Make it your own</span>
          <h1>Focus without tunnel vision.</h1>
          <p class="intro">
            Give your priorities extra attention while keeping a separate radar
            for broader DevRel developments.
          </p>
          <form id="settings-form">
            <div class="settings-block">
              <h2>Focus areas</h2>
              <p class="muted">
                Use a short name and concrete search keywords. The first keyword
                is searched every briefing. Extra keywords rotate through the
                remaining search budget.
              </p>
              <div id="priority-rows"></div>
              <button id="add-priority" class="button small" type="button">
                + Add a focus area
              </button>
            </div>
            <div class="settings-block">
              <h2>The wider radar</h2>
              <label for="radar">Topics to keep in view</label
              ><input id="radar" class="wide" required />
              <p class="settings-note">
                Comma-separated keywords. Buddy rotates these across briefings
                so focus areas do not take all the attention.
              </p>
              <label class="check"
                ><input id="private-channels" type="checkbox" /><span
                  >Include private channels I belong to<br /><span
                    class="settings-note"
                    >Joined public channels are always included. Your current
                    memberships are used at search time; DMs stay
                    excluded.</span
                  ></span
                ></label
              ><label class="check"
                ><input id="public-discovery" type="checkbox" /><span
                  >Explore other accessible public channels</span
                ></label
              >
            </div>
            <div class="settings-block">
              <h2>Content you like to create</h2>
              <div id="formats" class="formats"></div>
            </div>
            <div class="settings-block">
              <h2>Morning delivery</h2>
              <div class="form-grid">
                <div>
                  <label for="timezone">Timezone</label
                  ><input id="timezone" required />
                </div>
                <div>
                  <label for="hour">Briefing hour (0–23)</label
                  ><input id="hour" type="number" min="0" max="23" required />
                </div>
              </div>
              <label class="check"
                ><input id="daily" type="checkbox" /><span
                  >Generate and send my daily briefing to me in Slack</span
                ></label
              >
              <p id="schedule-note" class="settings-note"></p>
            </div>
            <div class="settings-block">
              <h2>Your feedback</h2>
              <p class="muted">
                Feedback records a topic preference, not a copy of the Slack
                message.
              </p>
              <div id="feedback-list"></div>
            </div>
            <button class="button primary" type="submit">
              Save preferences
            </button>
          </form>
        </section>
        <section id="panel-activity" hidden>
          <span class="eyebrow">A transparent process</span>
          <h1>Recent activity.</h1>
          <p class="intro">
            Run status, coverage, and delivery. Retrieved Slack text and
            generated briefings aren’t archived here.
          </p>
          <div id="runs"></div>
        </section>
        <div id="busy" class="busy" role="status" aria-live="polite" hidden>
          <span class="spinner" aria-hidden="true"></span
          ><span
            >Searching your sources and preparing a grounded briefing. This may
            take a minute or two.</span
          >
        </div>
        <section id="results" class="results" hidden></section>
        <p class="footer-note">
          A focused briefing, not an exhaustive Slack archive. Verify plans and
          publication readiness at the source.
        </p>
      </main>
    </div>
    <script nonce="${nonce}">
      ${SCRIPT}
    </script>
  </body>
</html>
`;
}

const SCRIPT = String.raw`
const $ = (id) => document.getElementById(id);
let state = null,
  current = null,
  busy = false,
  activeTab = "briefing",
  researchHistory = [],
  sessionEpoch = 0;
const el = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
};
function notice(text, error = false) {
  $("notice").textContent = text;
  $("notice").className = "notice " + (error ? "error" : "success");
  $("notice").hidden = false;
}
async function api(path, body) {
  const r = await fetch("/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await r.json();
  if (r.status === 401) {
    showLogin();
    throw Error(data.error || "Please sign in.");
  }
  if (!r.ok) throw Error(data.error || "Request failed.");
  return data;
}
function showLogin() {
  sessionEpoch++;
  researchHistory = [];
  current = null;
  state = null;
  $("results").replaceChildren();
  $("question").value = "";
  $("runs").replaceChildren();
  $("notice").hidden = true;
  $("empty-lanes").hidden = false;
  $("app").hidden = true;
  $("login").hidden = false;
}
function setBusy(value) {
  busy = value;
  $("busy").hidden = !value;
  document
    .querySelectorAll(
      "#generate,#research-form button,#settings-form button,#settings-form input,#days",
    )
    .forEach((n) => (n.disabled = value));
  if (!value && state) $("daily").disabled = !state.scheduledAvailable;
}
function tab(name) {
  activeTab = name;
  for (const n of ["briefing", "research", "priorities", "activity"])
    $("panel-" + n).hidden = n !== name;
  document
    .querySelectorAll("[data-tab]")
    .forEach((b) =>
      b.setAttribute("aria-selected", String(b.dataset.tab === name)),
    );
  $("results").hidden = !current || !["briefing", "research"].includes(name);
  $("notice").hidden = true;
}
document
  .querySelectorAll("[data-tab]")
  .forEach((b) => b.addEventListener("click", () => tab(b.dataset.tab)));
async function load() {
  state = await api("state");
  $("login").hidden = true;
  $("app").hidden = false;
  paintSettings();
  paintRuns();
}
$("today").textContent = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
}).format(new Date());
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = e.currentTarget.querySelector("button");
  button.disabled = true;
  try {
    await api("login", { password: $("password").value });
    $("password").value = "";
    $("login-error").hidden = true;
    await load();
  } catch (err) {
    $("login-error").textContent = err.message;
    $("login-error").hidden = false;
  } finally {
    button.disabled = false;
  }
});
async function logout() {
  try {
    await api("logout", {});
    showLogin();
  } catch (e) {
    notice(e.message, true);
  }
}
$("logout").addEventListener("click", logout);
$("mobile-logout").addEventListener("click", logout);
function priorityRow(p = { name: "", keywords: [] }) {
  const row = el("div", undefined, "priority-row");
  const a = el("div"),
    b = el("div");
  const name = el("input"),
    words = el("input");
  name.value = p.name;
  name.required = true;
  name.maxLength = 60;
  name.setAttribute("aria-label", "Focus area name");
  words.value = p.keywords.join(", ");
  words.required = true;
  words.setAttribute("aria-label", "Search keywords, comma-separated");
  a.append(el("label", "Focus area"), name);
  b.append(el("label", "Keywords"), words);
  const remove = el("button", "Remove", "button small");
  remove.type = "button";
  remove.addEventListener("click", () => {
    if ($("priority-rows").children.length > 1) row.remove();
  });
  row.append(a, b, remove);
  $("priority-rows").append(row);
}
$("add-priority").addEventListener("click", () => {
  if ($("priority-rows").children.length < 5) priorityRow();
});
function paintSettings() {
  const s = state.settings;
  $("focus-tags").replaceChildren(
    ...s.priorities.map((p) => el("span", p.name, "tag")),
    el("span", "+ broader DevRel radar", "tag"),
  );
  $("priority-rows").replaceChildren();
  s.priorities.forEach(priorityRow);
  $("radar").value = s.radarKeywords.join(", ");
  $("private-channels").checked = s.includePrivateChannels;
  $("public-discovery").checked = s.publicDiscovery;
  $("timezone").value = s.timezone;
  $("hour").value = s.digestHour;
  $("daily").checked = s.dailyDelivery;
  $("daily").disabled = !state.scheduledAvailable;
  $("schedule-note").textContent = state.scheduledAvailable
    ? "Delivery goes to your configured Slack account. The hourly check starts on the hour, with generation time afterward."
    : "Automatic delivery is off until scheduled access is enabled for this connector. You can generate and send a briefing yourself.";
  $("formats").replaceChildren();
  for (const f of ["tutorial", "demo", "blog", "video", "workshop", "social"]) {
    const label = el("label", undefined, "check");
    const input = el("input");
    input.type = "checkbox";
    input.value = f;
    input.checked = s.contentFormats.includes(f);
    label.append(input, document.createTextNode(f));
    $("formats").append(label);
  }
  $("feedback-list").replaceChildren();
  for (const [i, f] of s.feedback.entries()) {
    const row = el("div", undefined, "run");
    row.append(
      el("span", f.value + " " + f.dimension + " emphasis: " + f.topic),
    );
    const remove = el("button", "Remove", "button small");
    remove.type = "button";
    remove.addEventListener("click", () => {
      state.settings.feedback = state.settings.feedback.filter(
        (entry) => entry !== f,
      );
      row.remove();
      notice("Save preferences to apply this change.");
    });
    row.append(remove);
    $("feedback-list").append(row);
  }
  if (!s.feedback.length)
    $("feedback-list").append(
      el("p", "No saved feedback yet.", "settings-note"),
    );
}
$("settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const rows = [...$("priority-rows").children];
  const settings = {
    ...state.settings,
    priorities: rows.map((row) => {
      const inputs = row.querySelectorAll("input");
      return {
        name: inputs[0].value.trim(),
        keywords: inputs[1].value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      };
    }),
    radarKeywords: $("radar")
      .value.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    contentFormats: [...$("formats").querySelectorAll("input:checked")].map(
      (n) => n.value,
    ),
    includePrivateChannels: $("private-channels").checked,
    publicDiscovery: $("public-discovery").checked,
    timezone: $("timezone").value.trim(),
    digestHour: Number($("hour").value),
    dailyDelivery: $("daily").checked,
  };
  try {
    const updated = await api("settings", { version: state.version, settings });
    Object.assign(state, updated);
    paintSettings();
    notice("Preferences saved. Your next briefing will use these choices.");
  } catch (err) {
    notice(err.message, true);
  }
});
function paintRuns() {
  $("runs").replaceChildren();
  if (!state.runs.length) {
    $("runs").append(el("p", "Your first briefing starts here.", "muted"));
    return;
  }
  for (const run of state.runs) {
    const row = el("div", undefined, "run");
    const left = el("div");
    left.append(
      el("strong", run.kind === "research" ? "Research" : "DevRel briefing"),
      el("small", new Date(run.started_at).toLocaleString()),
    );
    const right = el("div");
    right.append(
      el("span", run.status + (run.partial ? " · partial coverage" : "")),
      el("br"),
      el(
        "small",
        run.request_count +
          " requests · " +
          run.result_count +
          " matches · delivery: " +
          run.delivery_status,
      ),
    );
    row.append(left, right);
    $("runs").append(row);
  }
}
async function generate(question) {
  if (busy) return;
  const epoch = sessionEpoch;
  setBusy(true);
  $("notice").hidden = true;
  try {
    const result = await api("generate", {
      requestId: crypto.randomUUID(),
      days: question ? 7 : Number($("days").value),
      ...(question
        ? { question, conversation: researchHistory.slice(-6) }
        : {}),
    });
    if (epoch !== sessionEpoch) return;
    current = result;
    if (question)
      researchHistory = [
        ...researchHistory,
        { role: "user", content: question },
        {
          role: "assistant",
          content: current.briefing.items
            .map((i) => i.title + ": " + i.summary)
            .join("\n")
            .slice(0, 2500),
        },
      ].slice(-6);
    renderResults();
    const refreshed = await api("state");
    if (epoch !== sessionEpoch) return;
    state.runs = refreshed.runs;
    paintRuns();
  } catch (err) {
    notice(err.message, true);
  } finally {
    setBusy(false);
  }
}
$("generate").addEventListener("click", () => generate());
$("research-form").addEventListener("submit", (e) => {
  e.preventDefault();
  generate($("question").value.trim());
});
document.querySelectorAll("[data-question]").forEach((b) =>
  b.addEventListener("click", () => {
    $("question").value = b.dataset.question;
    $("question").focus();
  }),
);
async function feedback(item, dimension, value) {
  const topic = prompt(
    "Which topic should this preference apply to? Use a short topic, not copied Slack text.",
    state.settings.priorities.find((p) =>
      (item.title + " " + item.summary)
        .toLowerCase()
        .includes(p.name.toLowerCase()),
    )?.name || "",
  );
  if (!topic) return;
  try {
    const settings = {
      ...state.settings,
      feedback: [
        ...state.settings.feedback.filter(
          (f) => !(f.topic === topic && f.dimension === dimension),
        ),
        { topic, dimension, value },
      ].slice(-30),
    };
    Object.assign(
      state,
      await api("settings", { version: state.version, settings }),
    );
    paintSettings();
    notice("Saved your " + dimension + " preference for " + topic + ".");
  } catch (err) {
    notice(err.message, true);
  }
}
function renderResults() {
  const root = $("results");
  root.replaceChildren();
  root.hidden = false;
  $("empty-lanes").hidden = true;
  const head = el("div", undefined, "result-heading");
  const title = el("div");
  title.append(
    el(
      "h2",
      activeTab === "research" ? "What the sources say" : "Your briefing",
    ),
    el(
      "p",
      current.metrics.requests +
        " requests · " +
        current.metrics.matches +
        " matches · " +
        Math.round(current.metrics.durationMs / 1000) +
        " seconds",
      "result-context",
    ),
  );
  const send = el("button", "Send this briefing to me in Slack", "button");
  send.addEventListener("click", async () => {
    send.disabled = true;
    try {
      const payload = {
        briefing: current.briefing,
        window: current.window,
        partial: current.metrics.partial,
      };
      await api("send", {
        runId: current.runId,
        token: current.deliveryToken,
        payload,
      });
      send.textContent = "Sent to Slack";
      notice("The briefing was sent to your Slack account.");
    } catch (err) {
      notice(err.message, true);
      send.textContent = "Check delivery in Activity";
    }
    try {
      state.runs = (await api("state")).runs;
      paintRuns();
    } catch {}
  });
  head.append(title, send);
  root.append(head, el("p", current.briefing.overview, "muted"));
  const sections = {
    attention: "Needs your attention",
    radar: "Your radar",
    upcoming: "Coming soon",
    content: "Content opportunities",
  };
  for (const [section, name] of Object.entries(sections)) {
    const items = current.briefing.items.filter((i) => i.section === section);
    if (!items.length) continue;
    root.append(el("h2", name));
    const grid = el("div", undefined, "cards");
    for (const item of items) {
      const card = el("article", undefined, "card");
      card.append(
        el(
          "span",
          section === "content" ? "Confirm before publishing" : item.certainty,
          "tag",
        ),
        el("h3", item.title),
        el("p", item.summary),
        el("p", item.why, "muted"),
      );
      if (section === "content")
        card.append(
          el(
            "p",
            [item.audience, item.format].filter(Boolean).join(" · "),
            "muted",
          ),
        );
      if (item.nextStep) card.append(el("div", item.nextStep, "next"));
      const links = el("div", undefined, "sources");
      for (const source of item.sources) {
        try {
          const url = new URL(source.url);
          if (url.protocol !== "https:" || !url.hostname.endsWith(".slack.com"))
            continue;
          const a = el("a", "#" + source.channelName + " ↗");
          a.href = url.href;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          links.append(a);
        } catch {}
      }
      card.append(links);
      const detail = el("details");
      detail.append(
        el("summary", "Supporting excerpt"),
        el("blockquote", item.evidence),
      );
      card.append(detail);
      const buttons = el("div", undefined, "feedback-row");
      for (const [label, dimension, value] of [
        ["Relevant", "relevance", "more"],
        ["Less of this", "relevance", "less"],
        ["Good content idea", "content", "more"],
      ]) {
        const b = el("button", label, "button small");
        b.addEventListener("click", () => feedback(item, dimension, value));
        buttons.append(b);
      }
      card.append(buttons);
      grid.append(card);
    }
    root.append(grid);
  }
  const coverage = el("details", undefined, "coverage");
  coverage.append(
    el(
      "summary",
      current.metrics.partial
        ? "Partial coverage — see what was searched"
        : "Search coverage",
    ),
  );
  const list = el("ul");
  for (const c of current.coverage)
    list.append(
      el(
        "li",
        c.label +
          " (" +
          c.scope +
          "): " +
          c.matches +
          " matches · " +
          c.status +
          (c.reason ? " — " + c.reason : ""),
      ),
    );
  coverage.append(
    list,
    el(
      "p",
      "Searches are bounded and keyword-based. New channel memberships enter the search scope automatically; not every message in every channel is read.",
    ),
  );
  root.append(coverage);
}
load().catch((e) => {
  showLogin();
  if (!/sign in/i.test(e.message)) {
    $("login-error").textContent = e.message;
    $("login-error").hidden = false;
  }
});
`;
