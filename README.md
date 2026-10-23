# Aztec MCP Server

An MCP (Model Context Protocol) server that provides local access to Aztec documentation, examples, and source code through cloned repositories. Optionally augments with **semantic search** over the full Aztec knowledge base when an API key is configured.

## Features

- **Version Support**: Clone specific Aztec release tags (e.g., `v6.0.0`)
- **Lightweight v6 Sync**: Clones only selected paths from `aztec-node`, pinned to the `labs` commit recorded in the requested `aztec-packages` release. Protocol and Noir sources are optional.
- **Fast Code Search**: Search Noir contracts and TypeScript files using ripgrep (with fallback)
- **Documentation Search**: Search Aztec documentation locally; with an API key, semantic vector search across the full corpora (framework docs, examples, Noir stdlib, TypeScript SDK, protocol circuits)
- **Error Lookup**: Static catalog (Solidity / circuit / TX / AVM errors) plus optional semantic fallback for unrecognized errors when an API key is configured
- **Example Discovery**: List and read Aztec contract examples
- **Version-sync Gate**: When using the hosted semantic backend, the server detects mismatches between your local release and the indexed corpus and refuses to query across versions unless explicitly overridden

## API Key (optional, recommended)

The MCP server runs in two modes:

| Mode                 | How to enable                       | What you get                                                                                                                                                            |
| -------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Local (default)**  | No setup                            | Ripgrep search over cloned markdown + code; static error catalog                                                                                                        |
| **Semantic (recommended)** | Set `API_KEY` env var | Vector search over all 12 indexed Aztec corpora (developer docs, network docs, Aztec.nr, examples, aztec.js, CLI, TypeScript API, e2e tests, protocol circuits, L1 contracts, Noir docs, Noir stdlib); semantic error fallback; version-sync gate |

### Getting a key

1. Join the Aztec/Noir Discord: <https://discord.gg/xMud5StFyA>
2. Run `/mcp-key` in any channel — the bot DMs you a personal API key (UUID) ephemerally.
3. Paste the key into your MCP client config under `env.API_KEY` (see [Configuration](#configuration)).

Keys are free, persistent (re-running `/mcp-key` returns the same key), and revocable via `/forget-me`.

## Installation

### With npx (recommended)

```bash
npx -y @aztec/mcp-server@latest
```

> **Always pin `@latest`.** npx caches packages aggressively — without `@latest`, you can end up running an old version indefinitely. The `@latest` tag forces npx to check the registry for the current release every run. The server also self-reports an upgrade-available warning at startup if it detects a newer version on npm (see `aztec_status` output).

### Global install

```bash
npm install -g @aztec/mcp-server@latest
aztec-mcp
```

To update later: `npm install -g @aztec/mcp-server@latest` (or just rely on the `npx -y @aztec/mcp-server@latest` form, which always fetches current).

## Configuration

### Claude Code Plugin

Add to your `.mcp.json`. The minimal config is just the command; add `env.API_KEY` to enable semantic search.

```json
{
  "mcpServers": {
    "aztec-mcp": {
      "command": "npx",
      "args": ["-y", "@aztec/mcp-server@latest"],
      "env": {
        "API_KEY": "<your key from /mcp-key in the Noir Discord>"
      }
    }
  }
}
```

| Env var               | Default                              | Purpose                                                                                                              |
| --------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `API_KEY`             | unset                                | Personal API key from `/mcp-key` in the Noir Discord (<https://discord.gg/xMud5StFyA>). Unset → local-only mode. |
| `API_URL`             | `https://aztec.adjacentpossible.dev` | DocsGPT backend the semantic search hits. Override to point at a self-hosted instance.                              |
| `REQUEST_TIMEOUT`     | `60000`                              | Semantic-search request timeout (ms).                                                                               |
| `AZTEC_DEFAULT_VERSION` | `v6.0.0`                             | Default version tag for `aztec_sync_repos`.                                                                         |
| `AZTEC_MCP_REPOS_DIR` | `~/.aztec-mcp/repos/`                | Where local clones live.                                                                                            |

## Available Tools

### `aztec_sync_repos`

Clone or update Aztec repositories locally. **Run this first** to enable other tools.

```
Default for v6:
- aztec-node: SDK, Aztec.nr, contract examples, playground, and documentation

Optional:
- aztec-packages: protocol, proving-system TypeScript, and L1 sources
- noir: language docs, standard library, and tooling
```

**Parameters:**

- `version` (string): Aztec version tag to clone (e.g., `v6.0.0`). Defaults to latest supported version.
- `force` (boolean): Force re-clone even if repos exist
- `repos` (string[]): For v6, select optional `aztec-packages` and/or `noir` sources. `aztec-node` is always included to keep SDK and documentation aligned with the release. Older versions retain their legacy repository configuration.

**Example - Clone specific version:**

```
aztec_sync_repos({ version: "v6.0.0" })
```

The default sync uses a temporary, shallow, blob-filtered Git fetch to read the release's `labs` and Noir gitlinks. It then removes that temporary Git data and makes one persistent shallow, partial, sparse checkout of `https://github.com/aztec-labs-eng/aztec-node` at the pinned commit.

To include protocol/L1 and Noir sources:

```
aztec_sync_repos({ version: "v6.0.0", repos: ["aztec-packages", "noir"] })
```

The `v6.0.0` release pins `aztec-node` at `1b6de149f4fe1cde3c5fb876d3822289f490cd2a`. That checkout has no exact `v6.0.0` documentation snapshot, so local documentation search uses its unversioned docs and reports the commit as provenance. It does not substitute an older snapshot.

Sync metadata records the release and active checkout commits. Searches exclude leftover repositories from previous releases. Optional sources remain active on a same-version resync if their commits still match; when changing versions, specify the optional sources again. Interrupted v6 syncs block version-sensitive searches until sync succeeds, and retries preserve the requested optional repositories. Downgrading to a legacy release requires a full sync (omit `repos`) to avoid mixing releases. Existing installs should run `aztec_sync_repos` with the version above to migrate.

The companion repositories `aztec-examples`, `aztec-starter`, and `demo-wallet` are not offered for v6 because matching release tags are unavailable. Contract examples come from the pinned `aztec-node` checkout.

### `aztec_status`

Check the status of cloned repositories.


### `aztec_network_status`

Probe a local Aztec sandbox / node / PXE / L1 RPC for reachability, latency, and a structured
ready|degraded|down taxonomy agents can branch on. Complements `aztec_status` (cloned repos only).

| Argument | Required | Description |
|----------|----------|-------------|
| `urls` | No | RPC base URLs to probe (defaults: `:8080` PXE, `:8081` node, `:8545` L1) |
| `roles` | No | `pxe` / `node` / `l1` / `custom` aligned with `urls` |
| `timeoutMs` | No | Per-request timeout (default 3000) |

### `aztec_search_code`

Search Aztec contract code and source files. Supports regex patterns.

**Parameters:**

- `query` (string, required): Search query (supports regex)
- `filePattern` (string): File glob pattern (default: `*.nr`)
- `repo` (string): Specific repo to search
- `maxResults` (number): Maximum results (default: 30)

**Example:**

```
aztec_search_code({ query: "PrivateSet", filePattern: "*.nr" })
```

### `aztec_search_docs`

Search Aztec documentation. Local ripgrep by default; semantic vector search when `API_KEY` is set.

**Parameters:**

- `query` (string, required): Documentation search query
- `section` (string): Docs section, applies to local search only (tutorials, concepts, developers, reference)
- `maxResults` (number): Maximum results (default: 20 local; 5 semantic, max 20)
- `chunks` (number, semantic only): Number of result chunks (1-20). If omitted, `maxResults` is used.
- `useLocalFallback` (boolean, semantic only): If the semantic backend fails, fall back to local ripgrep. Default `false` so backend errors surface clearly.
- `allowVersionMismatch` (boolean, semantic only): Override the version-sync gate. Default `false`. The gate refuses to search when your local release version differs from the corpus version the backend has indexed, including release-candidate suffixes (`rc.1` and `rc.6` are distinct).

### `aztec_list_examples`

List available Aztec contract examples.

**Parameters:**

- `category` (string): Filter by category (token, nft, defi, escrow, crowdfund)

### `aztec_read_example`

Read the source code of an Aztec contract example.

**Parameters:**

- `name` (string, required): Example contract name

### `aztec_read_file`

Read any file from cloned repositories.

**Parameters:**

- `path` (string, required): File path relative to repos directory

### `aztec_lookup_error`

Diagnose any Aztec error by message, error code, or hex signature. Returns root cause and suggested fix from a static catalog covering Solidity errors, TX validation errors, circuit codes, AVM errors, and operator FAQ. With `API_KEY` set, falls back to semantic documentation search when the static catalog has no hit.

**Parameters:**

- `query` (string, required): Error message, numeric code (e.g., `2002`), or hex signature (e.g., `0xa5b2ba17`)
- `category` (string): Filter (`contract`, `circuit`, `tx-validation`, `l1`, `avm`, `sequencer`, `operator`, `general`)
- `maxResults` (number): Default 10
- `allowVersionMismatch` (boolean, semantic only): Override the version-sync gate for the semantic fallback. Has no effect when the static catalog already matched.

## Configuration Options

### Storage Location

Repositories are cloned to `~/.aztec-mcp/repos/` by default.

Override with the `AZTEC_MCP_REPOS_DIR` environment variable:

```json
{
  "mcpServers": {
    "aztec-mcp": {
      "command": "npx",
      "args": ["-y", "@aztec/mcp-server@latest"],
      "env": {
        "AZTEC_MCP_REPOS_DIR": "/custom/path"
      }
    }
  }
}
```

### Default Aztec Version

Set the default Aztec version with the `AZTEC_DEFAULT_VERSION` environment variable:

```json
{
  "mcpServers": {
    "aztec-mcp": {
      "command": "npx",
      "args": ["-y", "@aztec/mcp-server@latest"],
      "env": {
        "AZTEC_DEFAULT_VERSION": "v6.0.0"
      }
    }
  }
}
```

## Development

```bash
# Clone the repo
git clone https://github.com/aztecprotocol/mcp-server
cd mcp-server

# Install dependencies
npm install

# Build
npm run build

npm test

node test.mjs

# Run locally
node dist/index.js
```

## Requirements

- Node.js 18+
- Git
- ripgrep (optional, for faster searching)

## Cloned Repositories

| Repository | v6 use | Checkout |
| --- | --- | --- |
| [aztec-node](https://github.com/aztec-labs-eng/aztec-node) | Default: SDK, Aztec.nr, contracts, docs | Shallow, partial, sparse; pinned by the release's `labs` gitlink |
| [aztec-packages](https://github.com/AztecProtocol/aztec-packages) | Optional: protocol and L1 sources | Shallow, partial, sparse; pinned to the release commit |
| [noir](https://github.com/noir-lang/noir) | Optional: language documentation and tooling | Shallow, partial, sparse; pinned by the release's Noir gitlink |

Versions before v6 retain the existing monorepo and companion repository configuration.

## License

MIT
