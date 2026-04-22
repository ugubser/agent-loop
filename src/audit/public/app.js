// ---------------------------------------------------------------------------
// Agent Loop Audit UI
// ---------------------------------------------------------------------------

let allSessions = [];
let activeSessionId = null;
let activeEventSource = null;
let sessionListRefreshTimer = null;

// --- Boot ---
document.addEventListener("DOMContentLoaded", () => {
  loadSessions();
  document.getElementById("search").addEventListener("input", renderSessionList);
  // Refresh session list every 5s to pick up new/changed sessions
  sessionListRefreshTimer = setInterval(loadSessions, 5000);
});

// --- Session list ---

async function loadSessions() {
  const res = await fetch("/api/sessions");
  allSessions = await res.json();
  renderSessionList();
}

function renderSessionList() {
  const filter = document.getElementById("search").value.toLowerCase();
  const list = document.getElementById("session-list");
  list.innerHTML = "";

  const filtered = allSessions.filter((s) => {
    const hay = `${s.id} ${s.skillName} ${s.taskPreview ?? ""}`.toLowerCase();
    return hay.includes(filter);
  });

  for (const s of filtered) {
    const li = document.createElement("li");
    if (s.id === activeSessionId) li.classList.add("active");
    li.innerHTML = `
      <div class="session-item-header">
        <span class="session-skill">${esc(s.skillName)}</span>
        <span class="badge badge-${s.status}">${s.status}</span>
      </div>
      <div class="session-meta">
        <span class="session-id">${s.shortId ?? s.id.slice(0, 8)}</span>
        <span>${relTime(s.startedAt)}</span>
        <span>iter ${s.iteration}</span>
        <span>${formatTokens(s.tokenUsage?.input ?? 0)} in</span>
      </div>
      <div class="session-task">${esc(s.taskPreview ?? "")}</div>
    `;
    li.addEventListener("click", () => loadSession(s.id));
    list.appendChild(li);
  }
}

// --- Session detail ---

async function loadSession(id) {
  // Close previous SSE stream
  if (activeEventSource) {
    activeEventSource.close();
    activeEventSource = null;
  }

  activeSessionId = id;
  renderSessionList(); // update active highlight

  const res = await fetch(`/api/sessions/${id}`);
  const { state, transcript, systemPrompt } = await res.json();

  document.getElementById("empty-state").hidden = true;
  const detail = document.getElementById("session-detail");
  detail.hidden = false;

  renderHeader(state, systemPrompt);
  renderTimeline(state, transcript);

  // Scroll main panel to top
  document.getElementById("main-panel").scrollTop = 0;

  // Connect SSE for live updates
  connectSSE(id, state);
}

function connectSSE(id, initialState) {
  const es = new EventSource(`/api/sessions/${id}/stream`);
  activeEventSource = es;

  es.addEventListener("transcript", (event) => {
    // Append new timeline entry
    try {
      const entry = JSON.parse(event.data);
      const timeline = document.getElementById("timeline");
      const el = buildTimelineEntry(entry);
      timeline.appendChild(el);

      // Auto-scroll if user is near the bottom
      const main = document.getElementById("main-panel");
      const nearBottom = main.scrollHeight - main.scrollTop - main.clientHeight < 200;
      if (nearBottom) {
        el.scrollIntoView({ behavior: "smooth", block: "end" });
      }
    } catch { /* ignore parse errors */ }
  });

  es.addEventListener("state", (event) => {
    // Update header with new state
    try {
      const state = JSON.parse(event.data);
      // Preserve systemPrompt from initial load
      const sp = document.querySelector(".system-prompt-body");
      const systemPrompt = sp ? sp.textContent : "";
      renderHeader(state, systemPrompt);
    } catch { /* ignore */ }
  });

  es.onerror = () => {
    // Reconnect handled automatically by EventSource
  };
}

function renderHeader(state, systemPrompt) {
  const dur = ((new Date(state.updatedAt) - new Date(state.startedAt)) / 1000).toFixed(0);
  const tu = state.tokenUsage ?? {};
  const pct = tu.total ? ((tu.input / (state.config?.session?.maxContext ?? tu.total)) * 100).toFixed(1) : 0;

  document.getElementById("session-header").innerHTML = `
    <div class="header-title">
      <h2>${esc(state.skillName)}</h2>
      <span class="badge badge-${state.status}">${state.status}${state.reason ? ` (${state.reason})` : ""}</span>
    </div>
    <div class="header-meta">
      <span><span class="label">ID</span> ${state.id}</span>
      <span><span class="label">Model</span> ${esc(state.config?.model?.model ?? "?")}</span>
      <span><span class="label">Started</span> ${fmtTime(state.startedAt)}</span>
      <span><span class="label">Duration</span> ${dur}s</span>
      <span><span class="label">Iterations</span> ${state.iteration}</span>
      <span><span class="label">Tokens</span> ${formatTokens(tu.input)} in / ${formatTokens(tu.output)} out</span>
    </div>
    <div class="token-bar"><div class="token-bar-fill" style="width:${Math.min(pct, 100)}%"></div></div>
    ${systemPrompt ? `
    <details class="system-prompt">
      <summary>System Prompt / Skill Instructions (${formatChars(systemPrompt.length)})</summary>
      <div class="system-prompt-body">${esc(systemPrompt)}</div>
    </details>` : ""}
  `;
}

// --- Timeline rendering ---

function renderTimeline(state, transcript) {
  const el = document.getElementById("timeline");
  el.innerHTML = "";

  // Extract system prompt from the first checkpoint or state
  for (const entry of transcript) {
    el.appendChild(buildTimelineEntry(entry));
  }
}

function buildTimelineEntry(entry) {
  const { type, timestamp, iteration, data } = entry;
  const time = timestamp ? timestamp.slice(11, 19) : "";
  const iter = iteration != null ? `i=${iteration}` : "";

  if (type === "llm_request") {
    const d = data || {};
    const msgCount = Array.isArray(d.messages) ? d.messages.length : 0;
    const toolCount = Array.isArray(d.tools) ? d.tools.length : 0;
    const sysLen = (d.system ?? "").length;
    const preview = `model=${d.model ?? "?"} msgs=${msgCount} tools=${toolCount} system=${formatChars(sysLen)}`;
    return makeEntry("tl-request", iter, time, "LLM REQUEST", preview, data);
  }
  if (type === "llm_response") {
    const d = data || {};
    const blocks = Array.isArray(d.content) ? d.content : [];
    const parts = blocks.map((b) => {
      if (b.type === "text") return `text(${(b.text ?? "").length})`;
      if (b.type === "tool_use") return `call:${b.name}`;
      return b.type;
    });
    const preview = `stop=${d.stopReason ?? "?"} tokens=${d.usage?.total ?? "?"} [${parts.join(", ")}]`;
    return makeEntry("tl-response", iter, time, "LLM RESPONSE", preview, data);
  }
  if (type === "status_change") {
    return makeEntry("tl-status", iter, time, "STATUS", statusPreview(data), data);
  }
  if (type === "error") {
    return makeEntry("tl-error", iter, time, "ERROR", JSON.stringify(data).slice(0, 120), data);
  }
  if (type === "compaction") {
    return makeEntry("tl-compaction", iter, time, "COMPACT", JSON.stringify(data).slice(0, 120), data);
  }

  // Messages
  const msg = data;
  if (!msg || !msg.role) {
    return makeEntry("tl-status", iter, time, type.toUpperCase(), JSON.stringify(data).slice(0, 120), data);
  }

  if (msg.role === "user") {
    const { preview, size } = userPreview(msg);
    const cls = type === "tool_result" ? "tl-user" : "tl-user";
    return makeEntry(cls, iter, time, "USER", preview, msg, size);
  }

  if (msg.role === "assistant") {
    const { preview, size } = assistantPreview(msg);
    return makeEntry("tl-assistant", iter, time, "ASSISTANT", preview, msg, size);
  }

  return makeEntry("tl-status", iter, time, msg.role?.toUpperCase() ?? "?", JSON.stringify(data).slice(0, 120), data);
}

function makeEntry(cls, iter, time, typeLabel, preview, data, size) {
  const details = document.createElement("details");
  details.className = `tl-entry ${cls}`;

  const sizeStr = size ? `${formatChars(size)}` : "";

  const summary = document.createElement("summary");
  summary.innerHTML = `
    <span class="tl-iter">${esc(iter)}</span>
    <span class="tl-time">${esc(time)}</span>
    <span class="tl-type">${esc(typeLabel)}</span>
    <span class="tl-preview">${esc(preview)}</span>
    ${sizeStr ? `<span class="tl-size">${sizeStr}</span>` : ""}
  `;
  details.appendChild(summary);

  // Lazy render body on first open
  let rendered = false;
  details.addEventListener("toggle", () => {
    if (details.open && !rendered) {
      rendered = true;
      const body = document.createElement("div");
      body.className = "tl-body";
      body.innerHTML = renderBody(data, cls);
      details.appendChild(body);
    }
  });

  return details;
}

// --- Preview extractors ---

function userPreview(msg) {
  if (typeof msg.content === "string") {
    return { preview: msg.content.slice(0, 150), size: msg.content.length };
  }
  if (Array.isArray(msg.content)) {
    const parts = [];
    let totalSize = 0;
    for (const b of msg.content) {
      if (b.type === "tool_result") {
        const c = b.content ?? "";
        totalSize += typeof c === "string" ? c.length : JSON.stringify(c).length;
        const snippet = typeof c === "string" ? c.slice(0, 60) : JSON.stringify(c).slice(0, 60);
        parts.push(`[result ${b.tool_use_id?.slice(0, 8) ?? "?"}] ${snippet}`);
      } else if (b.type === "text") {
        totalSize += (b.text ?? "").length;
        parts.push(b.text?.slice(0, 80) ?? "");
      }
    }
    return { preview: parts.join(" | "), size: totalSize };
  }
  return { preview: JSON.stringify(msg.content).slice(0, 120), size: 0 };
}

function assistantPreview(msg) {
  if (typeof msg.content === "string") {
    return { preview: msg.content.slice(0, 150), size: msg.content.length };
  }
  if (Array.isArray(msg.content)) {
    const parts = [];
    let totalSize = 0;
    for (const b of msg.content) {
      if (b.type === "text") {
        totalSize += (b.text ?? "").length;
        parts.push(b.text?.slice(0, 80) ?? "");
      } else if (b.type === "tool_use") {
        const argStr = JSON.stringify(b.input ?? {});
        totalSize += argStr.length;
        parts.push(`CALL ${b.name}(${argStr.slice(0, 60)})`);
      }
    }
    return { preview: parts.join(" | "), size: totalSize };
  }
  return { preview: JSON.stringify(msg.content).slice(0, 120), size: 0 };
}

function statusPreview(data) {
  if (data?.status) {
    return `${data.status}${data.reason ? ` (${data.reason})` : ""}`;
  }
  return JSON.stringify(data).slice(0, 120);
}

// --- Body rendering ---

function renderBody(data, cls) {
  // For message types, render content blocks with proper formatting
  if (data && data.role && data.content) {
    return renderMessageBody(data);
  }
  // For llm_request, render system prompt as text + rest as JSON
  if (cls === "tl-request" && data && data.system) {
    return `
      <div class="tl-section">
        <div class="tl-section-label">System Prompt (${formatChars(data.system.length)})</div>
        <pre class="tl-text-content">${simpleMarkdown(data.system)}</pre>
      </div>
      <div class="tl-section">
        <div class="tl-section-label">Messages (${(data.messages ?? []).length})</div>
        <pre>${highlightJson(data.messages)}</pre>
      </div>
      ${data.tools ? `<div class="tl-section">
        <div class="tl-section-label">Tools (${data.tools.length})</div>
        <pre>${highlightJson(data.tools)}</pre>
      </div>` : ""}
    `;
  }
  // For llm_response, render content blocks nicely
  if (cls === "tl-response" && data && Array.isArray(data.content)) {
    let html = "";
    for (const block of data.content) {
      if (block.type === "text" && block.text) {
        html += `<div class="tl-section">
          <div class="tl-section-label">Text</div>
          <pre class="tl-text-content">${simpleMarkdown(block.text)}</pre>
        </div>`;
      } else if (block.type === "tool_use") {
        html += `<div class="tl-section">
          <div class="tl-section-label">Tool Call: ${esc(block.name)}</div>
          <pre>${highlightJson(block)}</pre>
        </div>`;
      } else {
        html += `<pre>${highlightJson(block)}</pre>`;
      }
    }
    if (data.usage) {
      html += `<div class="tl-section">
        <div class="tl-section-label">Usage</div>
        <pre>${highlightJson(data.usage)}</pre>
      </div>`;
    }
    return html;
  }
  // Default: JSON
  return `<pre>${highlightJson(data)}</pre>`;
}

function renderMessageBody(msg) {
  if (typeof msg.content === "string") {
    return `<pre class="tl-text-content">${simpleMarkdown(msg.content)}</pre>`;
  }
  if (!Array.isArray(msg.content)) {
    return `<pre>${highlightJson(msg)}</pre>`;
  }
  let html = "";
  for (const block of msg.content) {
    if (block.type === "text" && block.text) {
      html += `<div class="tl-section">
        <div class="tl-section-label">Text</div>
        <pre class="tl-text-content">${simpleMarkdown(block.text)}</pre>
      </div>`;
    } else if (block.type === "tool_use") {
      html += `<div class="tl-section">
        <div class="tl-section-label">Tool Call: ${esc(block.name)}</div>
        <pre>${highlightJson(block.input)}</pre>
      </div>`;
    } else if (block.type === "tool_result") {
      const content = block.content ?? "";
      // Try to parse as JSON for syntax highlighting
      let rendered;
      try {
        const parsed = JSON.parse(content);
        rendered = highlightJson(parsed);
      } catch {
        rendered = simpleMarkdown(content);
      }
      html += `<div class="tl-section">
        <div class="tl-section-label">Tool Result ${block.is_error ? "(ERROR)" : ""} <span class="tl-size">${formatChars(content.length)}</span></div>
        <pre class="tl-text-content">${rendered}</pre>
      </div>`;
    } else {
      html += `<pre>${highlightJson(block)}</pre>`;
    }
  }
  return html;
}

/** Render text with newlines and basic markdown formatting */
function simpleMarkdown(text) {
  let s = escHtml(text);
  // Code blocks: ```...```
  s = s.replace(/```(\w*)\n([\s\S]*?)```/g, '<code class="md-codeblock">$2</code>');
  // Headings: ### ...
  s = s.replace(/^(#{1,4}) (.+)$/gm, (_, h, t) => `<strong class="md-heading md-h${h.length}">${t}</strong>`);
  // Bold: **...**
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Inline code: `...`
  s = s.replace(/`([^`]+)`/g, '<code class="md-inline">$1</code>');
  // List items: - ...
  s = s.replace(/^- (.+)$/gm, '<span class="md-li">\u2022 $1</span>');
  return s;
}

// --- JSON syntax highlighting ---

function highlightJson(obj) {
  const json = JSON.stringify(obj, null, 2);
  if (!json) return "";
  return json.replace(
    /("(?:\\.|[^"\\])*")\s*:/g,
    '<span class="json-key">$1</span>:'
  ).replace(
    /:\s*("(?:\\.|[^"\\])*")/g,
    (match, str) => `: <span class="json-string">${escHtml(str)}</span>`
  ).replace(
    /:\s*(\d+(?:\.\d+)?)/g,
    ': <span class="json-number">$1</span>'
  ).replace(
    /:\s*(true|false)/g,
    ': <span class="json-bool">$1</span>'
  ).replace(
    /:\s*(null)/g,
    ': <span class="json-null">$1</span>'
  );
}

// --- Utilities ---

function esc(s) {
  if (!s) return "";
  const d = document.createElement("div");
  d.textContent = String(s);
  return d.innerHTML;
}

function escHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function relTime(iso) {
  if (!iso) return "";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function fmtTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString();
}

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatChars(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M chars`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K chars`;
  return `${n} chars`;
}
