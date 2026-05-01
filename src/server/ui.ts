export function renderOperatorConsole(agentName: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(agentName)} Console</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f4f1ea;
        --surface: rgba(255,255,255,0.88);
        --ink: #15202b;
        --muted: #5a6772;
        --accent: #0d6b63;
        --border: rgba(21,32,43,0.12);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "IBM Plex Sans", "Avenir Next", sans-serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(13,107,99,0.16), transparent 30%),
          linear-gradient(135deg, #f7f3eb, #e9efe9);
        min-height: 100vh;
      }
      .shell {
        max-width: 1180px;
        margin: 0 auto;
        padding: 32px 20px 48px;
      }
      h1 { margin: 0 0 6px; font-size: 2.1rem; }
      p { color: var(--muted); margin: 0; }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
        gap: 16px;
        margin-top: 24px;
      }
      .panel {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 18px;
        backdrop-filter: blur(8px);
        padding: 18px;
        box-shadow: 0 14px 34px rgba(0,0,0,0.06);
      }
      .panel h2 { margin: 0 0 12px; font-size: 1rem; text-transform: uppercase; letter-spacing: 0.08em; }
      pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        font-size: 0.85rem;
        color: var(--ink);
      }
      textarea, input, button {
        width: 100%;
        font: inherit;
      }
      textarea, input {
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 12px 14px;
        margin-bottom: 10px;
        background: rgba(255,255,255,0.95);
      }
      button {
        background: var(--accent);
        color: white;
        border: none;
        border-radius: 999px;
        padding: 12px 16px;
        cursor: pointer;
      }
      .wide { grid-column: 1 / -1; }
    </style>
  </head>
  <body>
    <div class="shell">
      <h1 data-testid="console-title">${escapeHtml(agentName)} Operator Console</h1>
      <p>Live view over health, runs, jobs, and a direct chat test surface.</p>
      <div class="grid">
        <section class="panel">
          <h2>Health</h2>
          <pre id="health" data-testid="health-panel">Loading...</pre>
        </section>
        <section class="panel">
          <h2>Admin Summary</h2>
          <pre id="adminSummary" data-testid="admin-summary-panel">Loading...</pre>
        </section>
        <section class="panel">
          <h2>Diagnostics</h2>
          <pre id="diagnostics">Loading...</pre>
        </section>
        <section class="panel">
          <h2>Metrics</h2>
          <pre id="metrics">Loading...</pre>
        </section>
        <section class="panel wide">
          <h2>Chat</h2>
          <input id="conversationId" placeholder="conversationId" value="operator-console" />
          <textarea id="message" rows="5" placeholder="Ask the agent to do something concrete."></textarea>
          <button id="send">Send message</button>
          <pre id="chatOutput">No messages sent yet.</pre>
        </section>
        <section class="panel">
          <h2>Sessions</h2>
          <pre id="sessions">Loading...</pre>
        </section>
        <section class="panel">
          <h2>Runs</h2>
          <pre id="runs">Loading...</pre>
        </section>
        <section class="panel">
          <h2>Jobs</h2>
          <pre id="jobs" data-testid="jobs-panel">Loading...</pre>
        </section>
        <section class="panel">
          <h2>MCP Audit</h2>
          <pre id="mcpAudit" data-testid="mcp-audit-panel">Loading...</pre>
        </section>
        <section class="panel wide">
          <h2>Memory</h2>
          <pre id="memory">Loading...</pre>
        </section>
        <section class="panel wide">
          <h2>Timeline</h2>
          <pre id="timeline">Loading...</pre>
        </section>
        <section class="panel wide">
          <h2>Operator Settings</h2>
          <input id="settingsRefresh" data-testid="settings-refresh-input" placeholder="dashboard refresh seconds" value="5" />
          <input id="settingsConversation" data-testid="settings-conversation-input" placeholder="default conversation id" value="operator-console" />
          <input id="settingsMemoryLimit" data-testid="settings-memory-limit-input" placeholder="memory timeline limit" value="20" />
          <button id="saveSettings" data-testid="settings-save-button">Save settings</button>
          <pre id="settings" data-testid="settings-panel">Loading...</pre>
        </section>
        <section class="panel wide">
          <h2>Dynamic Tools</h2>
          <input id="toolId" data-testid="tool-id-input" placeholder="tool id (for example project.brief)" />
          <input id="toolDescription" data-testid="tool-description-input" placeholder="description" />
          <textarea id="toolTemplate" data-testid="tool-template-input" rows="3" placeholder="response template, for example Brief for {{topic}}"></textarea>
          <textarea id="toolSchema" data-testid="tool-schema-input" rows="4" placeholder='input schema JSON, for example {"type":"object","properties":{"topic":{"type":"string"}}}'></textarea>
          <button id="registerTool" data-testid="tool-register-button">Register dynamic tool</button>
          <pre id="tools" data-testid="tools-panel">Loading...</pre>
        </section>
        <section class="panel wide">
          <h2>Tool Governance</h2>
          <input id="approveToolId" data-testid="approve-tool-id-input" placeholder="tool id to approve" />
          <input id="approveToolActor" data-testid="approve-tool-actor-input" placeholder="approved by" value="operator-console" />
          <input id="approveToolNotes" data-testid="approve-tool-notes-input" placeholder="approval notes" />
          <button id="approveTool" data-testid="approve-tool-button">Approve tool</button>
          <pre id="governance" data-testid="governance-panel">Loading...</pre>
        </section>
        <section class="panel wide">
          <h2>Channels</h2>
          <input id="channelId" placeholder="channel id (for example slack)" />
          <input id="channelEnabled" placeholder="enabled: true or false" value="true" />
          <button id="saveChannel">Save channel</button>
          <pre id="channels">Loading...</pre>
        </section>
        <section class="panel wide">
          <h2>Slack Delivery</h2>
          <input id="slackChannel" placeholder="Slack channel id" />
          <textarea id="slackText" rows="3" placeholder="Message text"></textarea>
          <button id="sendSlack">Send Slack message</button>
          <pre id="slackResult">No Slack messages sent yet.</pre>
        </section>
        <section class="panel wide">
          <h2>Channel Deliveries</h2>
          <pre id="deliveries">Loading...</pre>
        </section>
      </div>
    </div>
    <script>
      async function loadJson(path, targetId) {
        const response = await fetch(path);
        const data = await response.json();
        document.getElementById(targetId).textContent = JSON.stringify(data, null, 2);
      }

      async function refresh() {
        await Promise.all([
          loadJson('/health', 'health'),
          loadJson('/admin/summary', 'adminSummary'),
          loadJson('/admin/diagnostics', 'diagnostics'),
          loadJson('/metrics', 'metrics'),
          loadJson('/sessions', 'sessions'),
          loadJson('/runs', 'runs'),
          loadJson('/scheduler/jobs', 'jobs'),
          loadJson('/admin/mcp/audit', 'mcpAudit'),
          loadJson('/memory', 'memory'),
          loadJson('/admin/timeline', 'timeline'),
          loadJson('/admin/settings', 'settings'),
          loadJson('/tools/dynamic', 'tools'),
          loadJson('/admin/tools/governance', 'governance'),
          loadJson('/admin/channels', 'channels'),
          loadJson('/admin/channels/deliveries', 'deliveries')
        ]);
      }

      document.getElementById('send').addEventListener('click', async () => {
        const chatOutput = document.getElementById('chatOutput');
        chatOutput.textContent = 'Waiting for response stream...';
        const response = await fetch('/chat/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversationId: document.getElementById('conversationId').value,
            message: document.getElementById('message').value
          })
        });
        const text = await response.text();
        chatOutput.textContent = text;
        await refresh();
      });

      document.getElementById('registerTool').addEventListener('click', async () => {
        const schemaText = document.getElementById('toolSchema').value.trim();
        const response = await fetch('/tools/dynamic', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: document.getElementById('toolId').value,
            description: document.getElementById('toolDescription').value,
            responseTemplate: document.getElementById('toolTemplate').value,
            inputSchema: schemaText ? JSON.parse(schemaText) : undefined
          })
        });
        const data = await response.json();
        document.getElementById('tools').textContent = JSON.stringify(data, null, 2);
        await refresh();
      });

      document.getElementById('approveTool').addEventListener('click', async () => {
        const response = await fetch('/admin/tools/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            toolId: document.getElementById('approveToolId').value,
            approvedBy: document.getElementById('approveToolActor').value,
            notes: document.getElementById('approveToolNotes').value
          })
        });
        const data = await response.json();
        document.getElementById('governance').textContent = JSON.stringify(data, null, 2);
        await refresh();
      });

      document.getElementById('saveChannel').addEventListener('click', async () => {
        const enabled = document.getElementById('channelEnabled').value.trim().toLowerCase() === 'true';
        const response = await fetch('/admin/channels', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: document.getElementById('channelId').value,
            enabled
          })
        });
        const data = await response.json();
        document.getElementById('channels').textContent = JSON.stringify(data, null, 2);
        await refresh();
      });

      document.getElementById('saveSettings').addEventListener('click', async () => {
        const response = await fetch('/admin/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            dashboardRefreshSeconds: Number(document.getElementById('settingsRefresh').value),
            chatDefaultConversationId: document.getElementById('settingsConversation').value,
            memoryTimelineLimit: Number(document.getElementById('settingsMemoryLimit').value)
          })
        });
        const data = await response.json();
        document.getElementById('settings').textContent = JSON.stringify(data, null, 2);
        await refresh();
      });

      document.getElementById('sendSlack').addEventListener('click', async () => {
        const response = await fetch('/channels/slack/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            channel: document.getElementById('slackChannel').value,
            text: document.getElementById('slackText').value
          })
        });
        const data = await response.json();
        document.getElementById('slackResult').textContent = JSON.stringify(data, null, 2);
        await refresh();
      });

      async function refreshLoop() {
        try {
          const response = await fetch('/admin/settings');
          const data = await response.json();
          const seconds = data && data.settings && typeof data.settings.dashboardRefreshSeconds === 'number'
            ? data.settings.dashboardRefreshSeconds
            : 5;
          await refresh();
          setTimeout(refreshLoop, seconds * 1000);
        } catch (error) {
          document.getElementById('health').textContent = String(error);
          setTimeout(refreshLoop, 5000);
        }
      }

      refreshLoop();
    </script>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
