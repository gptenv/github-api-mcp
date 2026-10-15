import { unzipSync } from "fflate";
/**
 * GitHub API MCP — dynamic REST OpenAPI tools + GraphQL schema tools.
 * Secrets: ACCESS_KEY (required), GITHUB_TOKEN (required).
 * The generic REST and GraphQL tools remain available even if discovery is unavailable.
 */
interface Env {
  ACCESS_KEY: string;
  GITHUB_TOKEN: string;
  GITHUB_API_VERSION?: string;
  MCP_TOOL_PAGE_SIZE?: string;
}
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Tool = { name: string; description: string; inputSchema: Record<string, unknown> };
const API = "https://api.github.com";
const GQL = "https://api.github.com/graphql";
const SPEC_URL = "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json";
const GRAPHQL_INTROSPECTION = `query MCPRootSchema {
  __schema {
    queryType { fields(includeDeprecated: true) { name description args { name description defaultValue type { kind name ofType { kind name ofType { kind name } } } } type { kind name ofType { kind name ofType { kind name } } } } }
    mutationType { fields(includeDeprecated: true) { name description args { name description defaultValue type { kind name ofType { kind name ofType { kind name } } } } type { kind name ofType { kind name ofType { kind name } } } } }
  }
}`;
const BASE_SCHEMA = { type: "object", properties: {}, additionalProperties: true } as const;
let restCache: { at: number; tools: Tool[] } | undefined;
let gqlCache: { at: number; tools: Tool[] } | undefined;
const CACHE_MS = 30 * 60 * 1000;

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
}
function textResult(value: unknown, isError = false) {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return { content: [{ type: "text", text: s.length > 900_000 ? s.slice(0, 900_000) + "\n[TRUNCATED: use pagination or narrower query]" : s }], ...(isError ? { isError: true } : {}) };
}
function safePath(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || /(^|\/)\.\.?($|\/)/.test(path) || /%2f|%5c/i.test(path)) throw new Error("Invalid API path");
  return path;
}
function toToolName(method: string, path: string, operationId?: string): string {
  const source = operationId || path.replace(/\{([^}]+)\}/g, "by_$1").replace(/^\//, "").replace(/\//g, "_");
  const clean = source.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
  return ("github_" + method.toLowerCase() + "_" + clean).slice(0, 120);
}
function schemaForParameters(params: any[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of params || []) {
    const s = p.schema || {};
    properties[p.name] = { type: s.type || (s.enum ? "string" : "string"), description: p.description || s.description || "", ...(s.enum ? { enum: s.enum } : {}), ...(s.items ? { items: s.items } : {}) };
    if (p.required) required.push(p.name);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: true };
}
async function getRestTools(): Promise<Tool[]> {
  if (restCache && Date.now() - restCache.at < CACHE_MS) return restCache.tools;
  try {
    const r = await fetch(SPEC_URL, { headers: { accept: "application/vnd.github+json" }, cf: { cacheTtl: 1800, cacheEverything: true } as any });
    if (!r.ok) throw new Error("OpenAPI fetch failed: " + r.status);
    const spec: any = await r.json();
    const tools: Tool[] = [];
    for (const [path, item] of Object.entries<any>(spec.paths || {})) {
      for (const [method, op] of Object.entries<any>(item)) {
        if (!["get", "post", "put", "patch", "delete", "head"].includes(method)) continue;
        const params = [...(item.parameters || []), ...(op.parameters || [])];
        const properties: Record<string, unknown> = {};
        for (const p of params) {
          const s = p.schema || {};
          properties[p.name] = { type: s.type || "string", description: p.description || "", ...(s.enum ? { enum: s.enum } : {}), ...(s.items ? { items: s.items } : {}) };
        }
        if (method !== "get" && method !== "head" && method !== "delete") properties.body = { type: "object", description: "JSON request body for this GitHub API operation; consult GitHub docs for the endpoint schema", additionalProperties: true };
        properties.query = { type: "object", description: "Optional query-string parameters not already supplied as path parameters", additionalProperties: true };
        const required = params.filter((p: any) => p.required).map((p: any) => p.name);
        const opId = op.operationId || path;
        const summary = op.summary || op.description || opId;
        tools.push({
          name: toToolName(method, path, op.operationId),
          description: `GitHub REST: ${method.toUpperCase()} ${path}. ${String(summary).slice(0, 500)}. Uses GitHub's current API version and authenticated token. Path parameters are named fields; optional query parameters go in query; request payload goes in body.`,
          inputSchema: { type: "object", properties, ...(required.length ? { required } : []), additionalProperties: true }
        });
      }
    }
    // Preserve every endpoint by including generic fallback, even when the spec omits a route.
    tools.push(restFallbackTool());
    restCache = { at: Date.now(), tools };
    return tools;
  } catch {
    return [restFallbackTool()];
  }
}
function restFallbackTool(): Tool {
  return { name: "github_rest_request", description: "Universal GitHub REST fallback. Invoke any GitHub REST route, including routes missing from OpenAPI. Provide method, path (for example /repos/OWNER/REPO/actions/runs/RUN_ID/logs), query object, and optional JSON body. Binary responses are returned as base64 when within the response limit.", inputSchema: { type: "object", properties: { method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] }, path: { type: "string", description: "Path under api.github.com, starting with /; never include a hostname" }, query: { type: "object", additionalProperties: true }, body: {}, accept: { type: "string" } }, required: ["method", "path"], additionalProperties: false } };
}
function unwrapType(t: any): any { while (t?.ofType) t = t.ofType; return t || {}; }
async function getGraphqlTools(env: Env): Promise<Tool[]> {
  if (gqlCache && Date.now() - gqlCache.at < CACHE_MS) return gqlCache.tools;
  try {
    const r = await fetch(GQL, { method: "POST", headers: ghHeaders(env, "application/json"), body: JSON.stringify({ query: GRAPHQL_INTROSPECTION }) });
    const payload: any = await r.json();
    const schema = payload.data?.__schema;
    if (!schema) throw new Error("GraphQL introspection unavailable");
    const tools: Tool[] = [];
    for (const [kind, root] of [["query", schema.queryType], ["mutation", schema.mutationType]] as any[]) {
      if (!root?.fields) continue;
      for (const f of root.fields) {
        const properties: Record<string, unknown> = {};
        const required: string[] = [];
        for (const a of f.args || []) {
          const t = unwrapType(a.type);
          const type = t.name === "Int" || t.name === "Float" ? "number" : t.name === "Boolean" ? "boolean" : t.name === "String" || t.name === "ID" ? "string" : "string";
          properties[a.name] = { type, description: a.description || `GraphQL argument ${a.name} (${t.name || "input object"}); complex inputs may be supplied as JSON strings or via github_graphql_request.` };
          if (a.type?.kind === "NON_NULL") required.push(a.name);
        }
        properties.selection = { type: "string", description: "Optional GraphQL selection set, e.g. { id name url }; nested fields and advanced directives are best expressed with github_graphql_request." };
        const rootName = f.name;
        tools.push({
          name: `github_graphql_${kind}_${rootName}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 120),
          description: `GitHub GraphQL ${kind} root field ${rootName}. ${(f.description || "").slice(0, 300)}. For complex nested selections, input objects, fragments, aliases, directives, or combinations, use github_graphql_request for the complete GraphQL language.`,
          inputSchema: { type: "object", properties, ...(required.length ? { required } : []), additionalProperties: true }
        });
      }
    }
    tools.push(graphqlFallbackTool(), { name: "github_graphql_introspect_schema", description: "Inspect GitHub GraphQL schema types, fields, arguments, input objects, enums, interfaces, unions, and deprecations using introspection. Supply a GraphQL introspection query or a type name to inspect.", inputSchema: { type: "object", properties: { type_name: { type: "string", description: "Optional type name to inspect, such as Repository, Issue, PullRequest, ActionsWorkflowRun, or CreateIssueInput" }, query: { type: "string", description: "Optional arbitrary introspection query; overrides type_name" } }, additionalProperties: false } });
    gqlCache = { at: Date.now(), tools };
    return tools;
  } catch {
    return [graphqlFallbackTool(), { name: "github_graphql_introspect_schema", description: "Run GraphQL schema introspection for GitHub types and fields.", inputSchema: { type: "object", properties: { type_name: { type: "string" }, query: { type: "string" } } } }];
  }
}
function actionsLogsTool(): Tool {
  return {
    name: "github_actions_read_logs",
    description: "Download and inspect real GitHub Actions logs for an entire workflow run or a single job. Automatically follows GitHub's temporary log-archive redirect, decompresses the ZIP, and supports listing log files, reading line ranges, and searching across all files. Use small line ranges for large logs.",
    inputSchema: { type: "object", properties: {
      owner: { type: "string" }, repo: { type: "string" },
      run_id: { type: "string", description: "Workflow run ID; use this OR job_id" },
      job_id: { type: "string", description: "Workflow job ID; use this OR run_id" },
      action: { type: "string", enum: ["list", "read", "search"] },
      file: { type: "string", description: "Exact archive filename for action=read" },
      start_line: { type: "integer", minimum: 1 }, end_line: { type: "integer", minimum: 1 },
      pattern: { type: "string", description: "Literal or case-insensitive regex pattern for action=search" },
      max_matches: { type: "integer", minimum: 1, maximum: 200 }
    }, required: ["owner", "repo", "action"], additionalProperties: false }
  };
}
async function inspectActionsLogs(args: any, env: Env): Promise<unknown> {
  const owner = String(args.owner || "");
  const repo = String(args.repo || "");
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("Invalid owner or repository name");
  if (!!args.run_id === !!args.job_id) throw new Error("Supply exactly one of run_id or job_id");
  const id = String(args.run_id || args.job_id);
  if (!/^\d+$/.test(id)) throw new Error("Run/job ID must be numeric");
  const endpoint = args.job_id
    ? `/repos/${owner}/${repo}/actions/jobs/${id}/logs`
    : `/repos/${owner}/${repo}/actions/runs/${id}/logs`;
  const response = await fetch(API + endpoint, { headers: { ...ghHeaders(env), accept: "application/vnd.github+json, application/zip" }, redirect: "follow" });
  if (!response.ok) throw new Error(`GitHub log download failed (${response.status}): ${(await response.text()).slice(0, 2000)}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 25 * 1024 * 1024) throw new Error("Log archive exceeds 25 MiB compressed limit; fetch individual job logs instead");
  const files = unzipSync(bytes);
  const entries = Object.entries(files).map(([name, data]) => ({ name, text: new TextDecoder("utf-8", { fatal: false }).decode(data) })).filter(x => !x.name.endsWith("/"));
  const action = String(args.action);
  if (action === "list") return { source: args.run_id ? "workflow-run" : "job", id, files: entries.map(f => ({ name: f.name, lines: f.text.split("\n").length, bytes: new TextEncoder().encode(f.text).length })) };
  if (action === "read") {
    const f = entries.find(x => x.name === args.file);
    if (!f) throw new Error("Log file not found; call action=list and supply the exact file name");
    const lines = f.text.split("\n");
    const start = Math.max(1, Number(args.start_line || 1));
    const end = Math.min(lines.length, Math.max(start, Number(args.end_line || start + 199)));
    return { file: f.name, total_lines: lines.length, start_line: start, end_line: end, text: lines.slice(start - 1, end).join("\n") };
  }
  if (action === "search") {
    const pattern = String(args.pattern || "");
    if (!pattern) throw new Error("pattern is required for action=search");
    let re: RegExp;
    try { re = new RegExp(pattern, "i"); } catch { re = new RegExp(pattern.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&"), "i"); }
    const matches: Array<{ file: string; line: number; text: string }> = [];
    const max = Math.min(200, Math.max(1, Number(args.max_matches || 100)));
    for (const f of entries) {
      const lines = f.text.split("\n");
      for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) {
        matches.push({ file: f.name, line: i + 1, text: lines[i].slice(0, 2000) });
        if (matches.length >= max) return { match_count: matches.length, truncated: true, matches };
      }
    }
    return { match_count: matches.length, truncated: false, matches };
  }
  throw new Error("Unsupported log action");
}
function graphqlFallbackTool(): Tool {
  return { name: "github_graphql_request", description: "Execute any GitHub GraphQL query or mutation with variables and operationName. This is the complete-coverage fallback for all GraphQL fields, nested fields, input objects, enums, fragments, aliases, directives, pagination, and functionality not available in REST.", inputSchema: { type: "object", properties: { query: { type: "string" }, variables: { type: "object", additionalProperties: true }, operationName: { type: "string" } }, required: ["query"], additionalProperties: false } };
}
function ghHeaders(env: Env, accept = "application/vnd.github+json"): HeadersInit {
  return { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept, "x-github-api-version": env.GITHUB_API_VERSION || "2022-11-28", "user-agent": "github-api-mcp-cloudflare-worker", "content-type": "application/json" };
}
async function executeTool(name: string, args: any, env: Env): Promise<unknown> {
  if (name === "github_actions_read_logs") return inspectActionsLogs(args, env);
  if (name === "github_rest_request" || name.startsWith("github_get_") || name.startsWith("github_post_") || name.startsWith("github_put_") || name.startsWith("github_patch_") || name.startsWith("github_delete_") || name.startsWith("github_head_")) {
    const tools = await getRestTools();
    const generated = tools.find(t => t.name === name);
    if (!generated) throw new Error("Unknown REST tool; refresh tool catalogue");
    const method = name === "github_rest_request" ? String(args.method || "GET").toUpperCase() : name.slice("github_".length).split("_")[0].toUpperCase();
    // Operation-specific tools carry the route template as hidden metadata encoded in description.
    let path = args.path;
    const pathParamNames = new Set<string>();
    if (name !== "github_rest_request") {
      const match = generated.description.match(/GitHub REST: [A-Z]+ (\\S+)\\./);
      path = match?.[1];
      if (!path) throw new Error("Could not resolve generated route");
      for (const [key, value] of Object.entries(args)) {
        if (["body", "query", "accept", "method", "path"].includes(key)) continue;
        if (path.includes(`{${key}}`)) {
          pathParamNames.add(key);
          path = path.replaceAll(`{${key}}`, encodeURIComponent(String(value)));
        }
      }
      if (/\\{[^}]+\\}/.test(path)) throw new Error("Missing required path parameter(s): " + path.match(/\\{[^}]+\\}/g)?.join(", "));
    }
    path = safePath(String(path || ""));
    const url = new URL(path, API);
    if (url.origin !== API) throw new Error("Only api.github.com routes are permitted");
    for (const [k, v] of Object.entries(args.query || {})) {
      if (Array.isArray(v)) for (const x of v) url.searchParams.append(k, String(x));
      else if (v !== undefined && v !== null) url.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    if (name !== "github_rest_request") {
      for (const [k, v] of Object.entries(args)) {
        if (["body", "query", "accept", "method", "path"].includes(k) || pathParamNames.has(k)) continue;
        if (v !== undefined && v !== null) url.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
      }
    }
    const response = await fetch(url.toString(), { method, headers: ghHeaders(env, args.accept), ...(args.body !== undefined ? { body: JSON.stringify(args.body) } : {}) });
    const contentType = response.headers.get("content-type") || "";
    if (response.status === 204) return { status: 204, ok: response.ok };
    const data = contentType.includes("json") ? await response.json() : contentType.includes("text") ? await response.text() : { base64: btoa(String.fromCharCode(...new Uint8Array(await response.arrayBuffer()))), contentType };
    return { status: response.status, ok: response.ok, headers: { link: response.headers.get("link"), etag: response.headers.get("etag"), contentType }, data };
  }
  if (name === "github_graphql_request" || name.startsWith("github_graphql_query_") || name.startsWith("github_graphql_mutation_")) {
    let query = args.query;
    let variables = args.variables || {};
    if (name !== "github_graphql_request") {
      const field = name.replace(/^github_graphql_(query|mutation)_/, "");
      const rootType = name.includes("_mutation_") ? "mutation" : "query";
      const argPairs = Object.entries(args).filter(([k]) => !["selection", "variables"].includes(k));
      const declarations = argPairs.map(([k, v]) => `$${k}: ${typeof v === "number" ? "Int" : typeof v === "boolean" ? "Boolean" : "String"}`).join(", ");
      const uses = argPairs.map(([k]) => `${k}: $${k}`).join(", ");
      const selection = args.selection || (rootType === "query" ? "{ __typename }" : "{ clientMutationId }");
      query = `${rootType === "mutation" ? "mutation" : "query"} MCPGenerated${declarations ? `(${declarations})` : ""} { ${field}${uses ? `(${uses})` : ""} ${selection} }`;
      variables = Object.fromEntries(argPairs);
    }
    const response = await fetch(GQL, { method: "POST", headers: ghHeaders(env), body: JSON.stringify({ query, variables, operationName: args.operationName }) });
    return { status: response.status, ...(await response.json() as object) };
  }
  if (name === "github_graphql_introspect_schema") {
    let query = args.query;
    if (!query) query = args.type_name ? `query { __type(name: ${JSON.stringify(args.type_name)}) { kind name description fields(includeDeprecated: true) { name description isDeprecated deprecationReason args { name description type { kind name ofType { kind name } } } type { kind name ofType { kind name } } } inputFields { name description defaultValue type { kind name ofType { kind name } } } enumValues(includeDeprecated: true) { name description isDeprecated deprecationReason } possibleTypes { kind name } interfaces { kind name } } }` : GRAPHQL_INTROSPECTION;
    const response = await fetch(GQL, { method: "POST", headers: ghHeaders(env), body: JSON.stringify({ query }) });
    return { status: response.status, ...(await response.json() as object) };
  }
  throw new Error("Unknown tool: " + name);
}
function authenticate(req: Request, env: Env): boolean {
  const expected = env.ACCESS_KEY;
  if (!expected) return false;
  const auth = req.headers.get("authorization") || "";
  const supplied = auth.startsWith("Bearer ") ? auth.slice(7) : req.headers.get("x-api-key") || "";
  if (!supplied || supplied.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < supplied.length; i++) diff |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
function rpcError(id: unknown, code: number, message: string) { return { jsonrpc: "2.0", id: id ?? null, error: { code, message } }; }
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return json({ ok: true, service: "github-api-mcp", version: "3.0.0", authRequired: true });
    if (!authenticate(request, env)) return json({ error: "Unauthorized" }, 401, { "www-authenticate": "Bearer" });
    if (url.pathname.startsWith("/git/")) {
      const match = url.pathname.match(/^\\/git\\/([A-Za-z0-9_.-]+)\\/([A-Za-z0-9_.-]+\\.git)(\\/.*)?$/);
      if (!match) return json({ error: "Expected /git/OWNER/REPO.git/..." }, 400);
      const owner = match[1], repository = match[2], suffix = match[3] || "";
      const service = url.searchParams.get("service");
      const isInfoRefs = suffix === "/info/refs" && request.method === "GET" && service === "git-upload-pack";
      const isUploadPack = suffix === "/git-upload-pack" && request.method === "POST";
      if (!isInfoRefs && !isUploadPack) return json({ error: "Read-only Git Smart HTTP only; git-upload-pack is supported, pushes are disabled" }, 405);
      const upstream = new URL(`https://github.com/${owner}/${repository}${suffix}`);
      if (isInfoRefs) upstream.searchParams.set("service", "git-upload-pack");
      const headers = new Headers();
      headers.set("authorization", "Basic " + btoa("x-access-token:" + env.GITHUB_TOKEN));
      headers.set("user-agent", "github-api-mcp-cloudflare-worker");
      for (const name of ["accept", "content-type", "git-protocol"]) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
      }
      const upstreamResponse = await fetch(upstream.toString(), { method: request.method, headers, ...(request.method === "POST" ? { body: request.body } : {}), redirect: "manual" });
      if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) return json({ error: "GitHub returned a redirect; clone the canonical repository URL instead", status: upstreamResponse.status, location: upstreamResponse.headers.get("location") }, 502);
      const outHeaders = new Headers();
      for (const name of ["content-type", "cache-control", "expires", "pragma", "vary"]) {
        const value = upstreamResponse.headers.get(name);
        if (value) outHeaders.set(name, value);
      }
      outHeaders.set("cache-control", "no-store");
      return new Response(upstreamResponse.body, { status: upstreamResponse.status, headers: outHeaders });
    }
    if (url.pathname === "/mcp" && request.method === "POST") {
      let rpc: any;
      try { rpc = await request.json(); } catch { return json(rpcError(null, -32700, "Parse error"), 400); }
      const id = rpc.id;
      if (rpc.method === "notifications/initialized" || (rpc.method?.startsWith("notifications/") && id === undefined)) return new Response(null, { status: 202 });
      if (rpc.method === "initialize") return json({ jsonrpc: "2.0", id, result: { protocolVersion: rpc.params?.protocolVersion || "2025-03-26", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "github-api-mcp", version: "3.0.0" } } });
      if (rpc.method === "ping") return json({ jsonrpc: "2.0", id, result: {} });
      if (rpc.method === "tools/list") {
        const [rest, gql] = await Promise.all([getRestTools(), getGraphqlTools(env)]);
        const all = [...rest, ...gql, actionsLogsTool()].sort((a, b) => a.name.localeCompare(b.name));
        const pageSize = Math.min(100, Math.max(1, Number(env.MCP_TOOL_PAGE_SIZE || 80)));
        const offset = Math.max(0, Number.parseInt(rpc.params?.cursor || "0", 10) || 0);
        return json({ jsonrpc: "2.0", id, result: { tools: all.slice(offset, offset + pageSize), ...(offset + pageSize < all.length ? { nextCursor: String(offset + pageSize) } : {}) } });
      }
      if (rpc.method === "tools/call") {
        try { return json({ jsonrpc: "2.0", id, result: textResult(await executeTool(rpc.params?.name, rpc.params?.arguments || {}, env)) }); }
        catch (e) { return json({ jsonrpc: "2.0", id, result: textResult({ error: e instanceof Error ? e.message : String(e) }, true) }); }
      }
      if (id === undefined) return new Response(null, { status: 202 });
      return json(rpcError(id, -32601, "Method not found"), 404);
    }
    return json({ error: "Not found", mcp: "/mcp" }, 404);
  }
};