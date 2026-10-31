# API Reference

This is the complete Espresso API reference that gitGost consumes to display repositories and explore their code, branches, tags, and commits.

## Base URL

```
https://espresso.livrasand.com
```

All endpoints return `application/json` except Git smart-HTTP endpoints and `/raw` (file content).

## Authentication

Most browsing endpoints (`/api/gg/*` and their short aliases) accept an optional session via the header:

```
X-ZKP-Token: <session-token>
```

- If a valid token is sent, the request is authenticated as that account.
- If not sent (or invalid), the request is treated as anonymous. Anonymous browsing works only in trusted-network mode (no API key configured on the server).
- Management endpoints (`/api/nodes/*`) always require a valid `X-ZKP-Token` and, in production, the `X-Espresso-Key` header.

The token is obtained from the Espresso dashboard (valid for 24 hours).

## Error Codes

| Code | Meaning |
|------|---------|
| 400 | Invalid request (missing or malformed parameters) |
| 401 | Session token required or invalid |
| 403 | Access denied to this node |
| 404 | Resource not found (repository, file, branch, etc.) |
| 429 | Rate limit exceeded |
| 502 | RPC error with the storage node |
| 503 | Node offline |

Typical error body:

```json
{ "error": "repo not found on any online node" }
```

---

## 1. Repository Browsing

All endpoints in this group receive `:owner` (account name) and `:repo` (repository name). `:repo` is automatically URL-decoded.

### 1.1 Directory Tree

```
GET /api/gg/repos/:owner/:repo/tree
GET /:owner/:repo/tree
```

Lists the contents of a directory inside the repository.

**Query params**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | No | Path of the directory inside the repo. Empty = root. |

**Response (200)**

```json
{
  "path": "",
  "entries": [
    { "name": "README.md", "type": "file", "size": 1234 },
    { "name": "src", "type": "dir" },
    { "name": ".gitignore", "type": "file", "size": 56 }
  ]
}
```

**Example**

```bash
curl "https://espresso.livrasand.com/api/gg/repos/account/my-repo/tree?path=src"
```

### 1.2 Raw File Content

```
GET /api/gg/repos/:owner/:repo/raw
GET /:owner/:repo/raw
```

Returns the content of a file in the repository.

**Query params**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Path of the file inside the repo. |

**Response (200)**

Raw file content (`text/plain`).

**Example**

```bash
curl "https://espresso.livrasand.com/api/gg/repos/account/my-repo/raw?path=README.md"
```

### 1.3 Repository Info

```
GET /api/gg/repos/:owner/:repo/info
GET /:owner/:repo/info
```

Returns basic repository metadata.

**Response (200)**

```json
{ "name": "my-repo", "size": 1048576 }
```

### 1.4 Branches

```
GET /api/gg/repos/:owner/:repo/branches
GET /:owner/:repo/branches
```

**Response (200)**

```json
{ "branches": ["main", "develop", "feature-x"], "commits": [] }
```

### 1.5 Tags

```
GET /api/gg/repos/:owner/:repo/tags
GET /:owner/:repo/tags
```

**Response (200)**

```json
{ "tags": ["v1.0.0", "v1.1.0"] }
```

### 1.6 Topics

```
GET /api/gg/repos/:owner/:repo/topics
GET /:owner/:repo/topics
```

Returns the topics (discovery categories/tags) of the repository. Espresso does not persist per-repository topics yet, so it returns an empty list until topic storage is added.

**Response (200)**

```json
{ "topics": [] }
```

### 1.7 Commits

```
GET /api/gg/repos/:owner/:repo/commits
GET /:owner/:repo/commits
```

**Response (200)**

```json
{ "commits": ["abc123...", "def456..."] }
```

---

## 2. Git smart-HTTP (clone / fetch / push)

Allows cloning, fetching, and pushing on repositories stored in ESP32 nodes.

```
GET  /:owner/:repo.git/info/refs?service=git-upload-pack
POST /:owner/:repo.git/git-upload-pack
GET  /:owner/:repo.git/info/refs?service=git-receive-pack
POST /:owner/:repo.git/git-receive-pack
```

**Authentication:** add the `X-ZKP-Token` header to Git HTTP requests:

```bash
git -c http.extraHeader="X-ZKP-Token: $ESP_TOK" clone \
  https://espresso.livrasand.com/<account>/my-repo.git
```

The `<account>` segment is cosmetic: the node is resolved from the session token.

---

## 3. Node and Repository Management (requires session)

These endpoints operate on a specific node identified by `:nodeId` (uppercase).

### 3.1 List Nodes

```
GET /api/nodes
```

**Response (200)**

```json
{ "nodes": [ { "id": "NODE123", "account": "...", "name": "...", "online": true, "repositories": [ { "name": "my-repo", "size": 1234 } ], ... } ] }
```

### 3.2 List Repositories of a Node

```
GET /api/nodes/:nodeId/repos
```

### 3.3 Create Repository (with optional boilerplate)

```
POST /api/nodes/:nodeId/repos
```

**Body**

```json
{ "name": "my-repo", "description": "Desc", "readme": "yes", "gitignore": "Node", "license": "MIT" }
```

### 3.4 Create Bare Repository

```
POST /api/nodes/:nodeId/repo/create
```

**Body**

```json
{ "name": "my-repo" }
```

### 3.5 Delete Repository

```
POST /api/nodes/:nodeId/repo/delete
```

**Body**

```json
{ "repo": "my-repo" }
```

### 3.6 List References (branches/tags/commits) of a Repo

```
GET /api/nodes/:nodeId/refs/:repo
```

### 3.7 Read/Write/List Node Filesystem (inside a repo)

```
POST /api/nodes/:nodeId/fs/read   { "repo": "...", "path": "...", "offset": 0, "len": 8192 }
POST /api/nodes/:nodeId/fs/write  { "repo": "...", "path": "...", "data_b64": "...", "offset": 0 }
POST /api/nodes/:nodeId/fs/list   { "repo": "...", "path": "" }
```

---

## 4. Quick curl Examples

```bash
# Session token
export ESP_TOK="<your-token>"

# Repository info
curl -s "https://espresso.livrasand.com/api/gg/repos/account/my-repo/info" | jq

# Root directory tree
curl -s "https://espresso.livrasand.com/api/gg/repos/account/my-repo/tree?path=" | jq

# File content
curl -s "https://espresso.livrasand.com/api/gg/repos/account/my-repo/raw?path=README.md"

# Branches
curl -s -H "X-ZKP-Token: $ESP_TOK" "https://espresso.livrasand.com/api/gg/repos/account/my-repo/branches" | jq

# Tags
curl -s -H "X-ZKP-Token: $ESP_TOK" "https://espresso.livrasand.com/api/gg/repos/account/my-repo/tags" | jq

# Topics
curl -s -H "X-ZKP-Token: $ESP_TOK" "https://espresso.livrasand.com/api/gg/repos/account/my-repo/topics" | jq

# Commits
curl -s -H "X-ZKP-Token: $ESP_TOK" "https://espresso.livrasand.com/api/gg/repos/account/my-repo/commits" | jq

# Clone
git -c http.extraHeader="X-ZKP-Token: $ESP_TOK" clone \
  https://espresso.livrasand.com/account/my-repo.git
```

## Implementation

The `/api/gg/*` endpoints are implemented in `packages/node-server/src/nodes/api.ts` (`makeGGHandlers`) and routed in `packages/node-server/src/router.ts`. Each request is forwarded to the paired storage node via RPC over the poll inbox (no WebSockets, no open ports).
