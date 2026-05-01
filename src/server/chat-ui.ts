export function renderChatApp(agentName: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(agentName)} Chat</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #eef2f5;
        --panel: #ffffff;
        --panel-soft: #f7f9fb;
        --ink: #18212b;
        --muted: #65717e;
        --line: #d8e0e7;
        --accent: #0f766e;
        --accent-ink: #ffffff;
        --danger: #b42318;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: var(--bg);
        color: var(--ink);
      }
      .app {
        display: grid;
        grid-template-columns: minmax(220px, 300px) minmax(0, 1fr);
        min-height: 100vh;
      }
      aside {
        border-right: 1px solid var(--line);
        background: var(--panel);
        padding: 14px;
        overflow-y: auto;
      }
      main {
        display: grid;
        grid-template-rows: auto minmax(0, 1fr) auto;
        min-height: 100vh;
      }
      header, .composer {
        background: rgba(255,255,255,0.94);
        border-bottom: 1px solid var(--line);
        padding: 12px 16px;
      }
      .composer {
        border-top: 1px solid var(--line);
        border-bottom: 0;
      }
      h1 {
        margin: 0;
        font-size: 1rem;
        line-height: 1.3;
      }
      .status {
        color: var(--muted);
        font-size: 0.82rem;
        margin-top: 3px;
      }
      button, textarea, input {
        font: inherit;
      }
      button {
        border: 0;
        border-radius: 8px;
        background: var(--accent);
        color: var(--accent-ink);
        padding: 9px 12px;
        cursor: pointer;
      }
      button.secondary {
        background: var(--panel-soft);
        color: var(--ink);
        border: 1px solid var(--line);
      }
      .session {
        width: 100%;
        text-align: left;
        background: transparent;
        color: var(--ink);
        border: 1px solid transparent;
        padding: 9px 10px;
        margin-top: 6px;
      }
      .session.active {
        background: var(--panel-soft);
        border-color: var(--line);
      }
      .messages {
        overflow-y: auto;
        padding: 18px;
      }
      .message {
        max-width: 860px;
        margin: 0 auto 12px;
        padding: 12px 14px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel);
      }
      .message.user {
        background: #edf7f5;
      }
      .role {
        color: var(--muted);
        font-size: 0.78rem;
        margin-bottom: 6px;
        text-transform: uppercase;
      }
      .content {
        line-height: 1.55;
      }
      .content pre {
        overflow-x: auto;
        background: #101820;
        color: #f6f8fa;
        padding: 12px;
        border-radius: 8px;
      }
      .composer form {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 10px;
        max-width: 980px;
        margin: 0 auto;
      }
      textarea {
        min-height: 74px;
        resize: vertical;
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 10px 12px;
      }
      .tools {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        max-width: 980px;
        margin: 8px auto 0;
      }
      .attachments {
        max-width: 980px;
        margin: 8px auto 0;
        color: var(--muted);
        font-size: 0.82rem;
      }
      @media (max-width: 760px) {
        .app { grid-template-columns: 1fr; }
        aside { max-height: 220px; border-right: 0; border-bottom: 1px solid var(--line); }
        main { min-height: calc(100vh - 220px); }
      }
    </style>
  </head>
  <body>
    <div class="app" data-testid="chat-app">
      <aside>
        <button id="newSession" class="secondary" type="button">New Chat</button>
        <div id="sessions"></div>
      </aside>
      <main>
        <header>
          <h1 id="title">${escapeHtml(agentName)} Chat</h1>
          <div id="status" class="status">Ready</div>
        </header>
        <section id="messages" class="messages" aria-live="polite"></section>
        <section class="composer">
          <form id="composer">
            <textarea id="message" placeholder="Send a message"></textarea>
            <button type="submit">Send</button>
          </form>
          <div class="tools">
            <input id="fileInput" type="file" multiple />
            <button id="pushButton" class="secondary" type="button">Enable Notifications</button>
          </div>
          <div id="attachments" class="attachments"></div>
        </section>
      </main>
    </div>
    <script>
      const state = {
        sessions: [],
        activeSessionId: localStorage.getItem('codex-phantom.chat.activeSessionId') || '',
        attachments: []
      };
      const channel = 'BroadcastChannel' in window ? new BroadcastChannel('codex-phantom.chat') : null;
      channel?.addEventListener('message', (event) => {
        if (event.data?.type === 'sessions.changed') loadSessions();
      });
      window.addEventListener('storage', (event) => {
        if (event.key === 'codex-phantom.chat.refresh') loadSessions();
      });

      function broadcastSessionsChanged() {
        localStorage.setItem('codex-phantom.chat.refresh', String(Date.now()));
        channel?.postMessage({ type: 'sessions.changed' });
      }

      async function loadSessions() {
        const response = await fetch('/chat/sessions');
        const data = await response.json();
        state.sessions = data.sessions || [];
        if (!state.activeSessionId && state.sessions[0]) {
          state.activeSessionId = state.sessions[0].sessionId;
        }
        renderSessions();
        if (state.activeSessionId) await loadSession(state.activeSessionId);
      }

      async function loadSession(sessionId) {
        state.activeSessionId = sessionId;
        localStorage.setItem('codex-phantom.chat.activeSessionId', sessionId);
        const response = await fetch('/chat/sessions/' + encodeURIComponent(sessionId));
        if (!response.ok) return;
        const data = await response.json();
        document.getElementById('title').textContent = data.session.title || data.session.conversationId || 'Chat';
        const messages = [];
        for (const run of data.runs || []) {
          for (const item of run.transcript || []) messages.push(item);
        }
        renderMessages(messages);
        renderSessions();
      }

      function renderSessions() {
        const root = document.getElementById('sessions');
        root.innerHTML = '';
        for (const session of state.sessions) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'session' + (session.sessionId === state.activeSessionId ? ' active' : '');
          button.textContent = session.title || session.conversationId || session.sessionId;
          button.addEventListener('click', () => loadSession(session.sessionId));
          root.appendChild(button);
        }
      }

      function renderMessages(messages) {
        const root = document.getElementById('messages');
        root.innerHTML = '';
        for (const message of messages) appendMessage(message.role, message.content);
      }

      function appendMessage(role, content) {
        const root = document.getElementById('messages');
        const item = document.createElement('article');
        item.className = 'message ' + role;
        item.innerHTML = '<div class="role"></div><div class="content"></div>';
        item.querySelector('.role').textContent = role;
        item.querySelector('.content').innerHTML = renderMarkdown(content || '');
        root.appendChild(item);
        root.scrollTop = root.scrollHeight;
        return item;
      }

      function renderMarkdown(text) {
        const escaped = escapeHtml(text);
        return escaped
          .replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre><code>$1</code></pre>')
          .replace(/^### (.*)$/gm, '<h3>$1</h3>')
          .replace(/^## (.*)$/gm, '<h2>$1</h2>')
          .replace(/^# (.*)$/gm, '<h1>$1</h1>')
          .replace(/\\*\\*(.*?)\\*\\*/g, '<strong>$1</strong>')
          .replace(/\\*(.*?)\\*/g, '<em>$1</em>')
          .replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
          .replace(/\\n/g, '<br />');
      }

      function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, (char) => ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;'
        })[char]);
      }

      document.getElementById('fileInput').addEventListener('change', (event) => {
        state.attachments = Array.from(event.target.files || []).map((file) => ({
          name: file.name,
          contentType: file.type || 'application/octet-stream',
          sizeBytes: file.size
        }));
        document.getElementById('attachments').textContent = state.attachments.map((file) => file.name).join(', ');
      });

      document.getElementById('pushButton').addEventListener('click', async () => {
        if (!('Notification' in window)) {
          document.getElementById('status').textContent = 'Notifications unavailable';
          return;
        }
        const result = await Notification.requestPermission();
        document.getElementById('status').textContent = 'Notifications: ' + result;
      });

      document.getElementById('newSession').addEventListener('click', () => {
        state.activeSessionId = '';
        localStorage.removeItem('codex-phantom.chat.activeSessionId');
        document.getElementById('title').textContent = '${escapeJs(agentName)} Chat';
        renderMessages([]);
        renderSessions();
      });

      document.getElementById('composer').addEventListener('submit', async (event) => {
        event.preventDefault();
        const input = document.getElementById('message');
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        appendMessage('user', text);
        const assistant = appendMessage('assistant', '');
        document.getElementById('status').textContent = 'Running';
        const response = await fetch('/chat/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: state.activeSessionId || undefined,
            conversationId: state.activeSessionId ? undefined : 'web-chat',
            message: text,
            attachments: state.attachments
          })
        });
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let assistantText = '';
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          buffer += decoder.decode(next.value, { stream: true });
          const chunks = buffer.split('\\n\\n');
          buffer = chunks.pop() || '';
          for (const chunk of chunks) {
            const line = chunk.split('\\n').find((item) => item.startsWith('data: '));
            if (!line) continue;
            const event = JSON.parse(line.slice(6));
            if (event.rawEvent?.type === 'text_delta') {
              assistantText += event.rawEvent.delta;
              assistant.querySelector('.content').innerHTML = renderMarkdown(assistantText);
            }
            if (event.type === 'run.completed') {
              state.activeSessionId = event.sessionId || state.activeSessionId;
              if (state.activeSessionId) localStorage.setItem('codex-phantom.chat.activeSessionId', state.activeSessionId);
              assistant.querySelector('.content').innerHTML = renderMarkdown(event.payload.outputText || assistantText);
            }
            if (event.type === 'request.completed') {
              document.getElementById('status').textContent = 'Ready';
              broadcastSessionsChanged();
            }
            if (event.type === 'request.failed') {
              document.getElementById('status').textContent = event.payload.message || 'Request failed';
            }
          }
        }
        state.attachments = [];
        document.getElementById('attachments').textContent = '';
        await loadSessions();
      });

      loadSessions();
    </script>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[char] ?? char));
}

function escapeJs(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
