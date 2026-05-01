import { expect, request, test } from "@playwright/test";

const operatorAuth = { Authorization: "Bearer operator-secret" };
const mcpAuth = { Authorization: "Bearer mcp-secret" };

test("operator console covers auth, settings, tools, MCP audit, and jobs", async ({ page, baseURL }) => {
  const blocked = await fetch(`${baseURL}/`);
  expect(blocked.status).toBe(401);
  expect(blocked.headers.get("www-authenticate")).toBe("Basic realm=\"codex-phantom operator\"");

  const api = await request.newContext({ baseURL, extraHTTPHeaders: operatorAuth });
  const mcp = await request.newContext({
    baseURL,
    extraHTTPHeaders: {
      ...mcpAuth,
      "Content-Type": "application/json"
    }
  });

  await page.goto("/");
  await expect(page.getByTestId("console-title")).toContainText("Operator Console");
  await expect(page.getByTestId("health-panel")).toContainText('"ok": true');
  await expect(page.getByTestId("admin-summary-panel")).toContainText('"logging"');

  await page.getByTestId("settings-refresh-input").fill("8");
  await page.getByTestId("settings-conversation-input").fill("e2e-console");
  await page.getByTestId("settings-memory-limit-input").fill("12");
  await page.getByTestId("settings-save-button").click();
  await expect(page.getByTestId("settings-panel")).toContainText('"dashboardRefreshSeconds": 8');
  await expect(page.getByTestId("settings-panel")).toContainText('"chatDefaultConversationId": "e2e-console"');

  await page.getByTestId("tool-id-input").fill("e2e.brief");
  await page.getByTestId("tool-description-input").fill("E2E brief tool");
  await page.getByTestId("tool-template-input").fill("E2E brief for {{topic}}");
  await page.getByTestId("tool-schema-input").fill('{"type":"object","properties":{"topic":{"type":"string"}}}');
  await page.getByTestId("tool-register-button").click();
  await expect(page.getByTestId("tools-panel")).toContainText('"approvalState": "pending"');

  await page.getByTestId("approve-tool-id-input").fill("e2e.brief");
  await page.getByTestId("approve-tool-actor-input").fill("playwright");
  await page.getByTestId("approve-tool-notes-input").fill("console coverage");
  await page.getByTestId("approve-tool-button").click();
  await expect(page.getByTestId("governance-panel")).toContainText('"approvalState": "approved"');
  await expect(page.getByTestId("tools-panel")).toContainText('"id": "e2e.brief"');

  const scheduleResponse = await api.post("/scheduler/jobs", {
    data: {
      name: "e2e-future-job",
      message: "verify console jobs panel",
      scheduledAt: "2099-01-01T00:00:00.000Z"
    }
  });
  expect(scheduleResponse.ok()).toBe(true);

  const mcpResponse = await mcp.post("/mcp", {
    data: { method: "tools/list" }
  });
  expect(mcpResponse.ok()).toBe(true);

  await page.reload();
  await expect(page.getByTestId("jobs-panel")).toContainText("e2e-future-job");
  await expect(page.getByTestId("mcp-audit-panel")).toContainText('"method": "tools/list"');

  await api.dispose();
  await mcp.dispose();
});
