# GitHub API MCP for Perplexity

Cloudflare Worker exposing a remote MCP server with dynamically generated, semantically named tools for GitHub REST operations and GitHub GraphQL root fields. It includes universal REST/GraphQL fallbacks so new routes and schema features remain callable.

## Coverage

- **REST:** Loads GitHub's official OpenAPI description and generates a named MCP tool for each documented HTTP operation. The catalogue is paginated using MCP `nextCursor`. The universal `github_rest_request` invokes any `api.github.com` REST route, including routes absent from the specification. Supported methods: GET, POST, PUT, PATCH, DELETE, HEAD.
- **GraphQL:** Introspects the live GitHub GraphQL schema and creates semantic tools for each root Query and Mutation field. `github_graphql_request` accepts arbitrary queries and mutations, variables and operationName; use it for nested fields, input objects, fragments, aliases, directives, connections and GraphQL-only functionality. `github_graphql_introspect_schema` inspects types, fields, arguments, enums, input objects, interfaces and unions.
- **Actions logs:** `github_actions_read_logs` downloads a workflow-run or job log ZIP through GitHub's temporary redirect, decompresses it, and supports `list`, `read` with line ranges, and `search` across files. Archives above 25 MiB compressed are rejected; use job-level logs to narrow the request.
- **Git metadata and all REST routes:** `github_rest_request` covers workflow runs/jobs, artifacts, reruns, branches, tags, refs, commits, Git objects, compare endpoints and any other REST route, including routes omitted from OpenAPI.
- **Clone/fetch:** The read-only `/git/OWNER/REPO.git` proxy supports Git Smart HTTP `git-upload-pack`, enabling a real history-preserving clone/fetch. Push/receive-pack is blocked. Example:

  ```bash
  export WORKER_URL='https://github-api-mcp.<your-account-subdomain>.workers.dev'
  export ACCESS_KEY='your-worker-access-key'
  git -c http.extraheader="Authorization: Bearer ${ACCESS_KEY}" clone "${WORKER_URL}/git/OWNER/REPO.git"
  ```

  The Worker authenticates upstream using its secret `GITHUB_TOKEN`; your GitHub token is not exposed to Git. Use the canonical owner/repository name because upstream redirects are rejected for safety. Repository snapshots are also available through GitHub archive REST routes.

GraphQL isn't a REST route list: arbitrary GraphQL execution plus schema introspection is what provides broad coverage beyond REST. Generated root-field tools improve discovery; the generic executor preserves access to the full query language. Tool pagination depends on the client honoring MCP `nextCursor`; if it does not, the generic tools remain available on the first page.

## Deploy

Requirements: Node.js 20+, npm, a Cloudflare account, and a GitHub fine-grained PAT or GitHub App token.

```bash
npm install
npx wrangler login
openssl rand -hex 32
npx wrangler secret put ACCESS_KEY
npx wrangler secret put GITHUB_TOKEN
npm run typecheck
npm test
npm run deploy
```

Enter a random generated value as `ACCESS_KEY` and your GitHub token as `GITHUB_TOKEN`. Never commit secrets. Restrict the token to the repositories and permissions you need. The Worker endpoint is:

`https://github-api-mcp.<your-account-subdomain>.workers.dev/mcp`

Requests require `Authorization: Bearer <ACCESS_KEY>` or `X-API-Key: <ACCESS_KEY>`. `GET /health` is public and contains no secrets.

## Smoke tests

```bash
export WORKER_URL='https://github-api-mcp.<your-account-subdomain>.workers.dev'
export ACCESS_KEY='your-worker-access-key'
curl -fsS "$WORKER_URL/health"
curl -sS -H "Authorization: Bearer $ACCESS_KEY" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke-test","version":"1"}}}' \
  "$WORKER_URL/mcp"
curl -sS -H "Authorization: Bearer $ACCESS_KEY" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' "$WORKER_URL/mcp"
curl -sS -H "Authorization: Bearer $ACCESS_KEY" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"github_rest_request","arguments":{"method":"GET","path":"/repos/octocat/Hello-World"}}}' "$WORKER_URL/mcp"
curl -sS -H "Authorization: Bearer $ACCESS_KEY" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"github_graphql_request","arguments":{"query":"query { viewer { login } }"}}}' "$WORKER_URL/mcp"
```

## Important security and operational notes

- Fixed upstream origin; the caller cannot specify an arbitrary host.
- GitHub token remains in a Cloudflare secret and is never returned to the caller.
- GitHub token permissions, rate limits, endpoint-specific media types, and API versioning apply.
- OpenAPI and GraphQL introspection are fetched at runtime and cached in Worker isolate memory.
- This repository has not yet been deployed to the target Cloudflare account or tested against live private repositories. Run the suite and live smoke tests before production use.

## License

MIT.
