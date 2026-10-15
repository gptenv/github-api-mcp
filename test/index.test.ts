import { describe, it, expect } from "vitest";
import worker from "../src/index";

const env = { ACCESS_KEY: "test-key", GITHUB_TOKEN: "fake-token", MCP_TOOL_PAGE_SIZE: "80" };
const makeRequest = (path: string, body?: unknown, key = "test-key") => new Request("https://worker.example" + path, {
  method: body ? "POST" : "GET",
  headers: { ...(body ? { "content-type": "application/json" } : {}), authorization: "Bearer " + key },
  ...(body ? { body: JSON.stringify(body) } : {})
});

describe("GitHub API MCP Worker", () => {
  it("serves public health", async () => {
    const r = await worker.fetch(new Request("https://worker.example/health"), env as any);
    expect(r.status).toBe(200);
    expect((await r.json() as any).ok).toBe(true);
  });
  it("rejects bad access keys", async () => {
    const r = await worker.fetch(makeRequest("/mcp", { jsonrpc: "2.0", id: 1, method: "initialize" }, "wrong"), env as any);
    expect(r.status).toBe(401);
  });
  it("implements MCP initialize", async () => {
    const r = await worker.fetch(makeRequest("/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }), env as any);
    expect((await r.json() as any).result.serverInfo.name).toBe("github-api-mcp");
  });
  it("rejects invalid REST paths", async () => {
    const r = await worker.fetch(makeRequest("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "github_rest_request", arguments: { method: "GET", path: "//evil.example/" } } }), env as any);
    expect((await r.json() as any).result.isError).toBe(true);
  });
});
