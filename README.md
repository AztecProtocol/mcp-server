# Aztec MCP Server

An MCP (Model Context Protocol) server that provides local access to Aztec documentation, examples, and source code through cloned repositories.

## Features

- **Version Support**: Clone specific Aztec release tags (e.g., `v4.0.0-devnet.2-patch.1`)
- **Local Repository Cloning**: Automatically clones Aztec repositories with sparse checkout for efficiency
- **Fast Code Search**: Search Noir contracts and TypeScript files using ripgrep (with fallback)
- **Documentation Search**: Search Aztec documentation by section
- **Example Discovery**: List and read Aztec contract examples

## Installation

### With npx (recommended)

```bash
npx @aztec/mcp-server
```

### Global install

```bash
npm install -g @aztec/mcp-server
aztec-mcp
```

## Configuration

### Claude Code Plugin

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "aztec-mcp": {
      "command": "npx",
      "args": ["--prefer-online", "-y", "@aztec/mcp-server@latest"]
    }
  }
}
```

## Available Tools

### `aztec_sync_repos`

Clone or update Aztec repositories locally. **Run this first** to enable other tools.

```
Clones:
- aztec-packages (docs, aztec-nr, noir-contracts) - sparse checkout
- aztec-examples (full)
- aztec-starter (full)
```

**Parameters:**

- `version` (string): Aztec version tag to clone (e.g., `v4.0.0-devnet.2-patch.1`). Defaults to latest supported version.
- `force` (boolean): Force re-clone even if repos exist
- `repos` (string[]): Specific repos to sync

**Example - Clone specific version:**

```
aztec_sync_repos({ version: "v4.0.0-devnet.2-patch.1" })
```

### `aztec_status`

Check the status of cloned repositories.

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

Search Aztec documentation.

**Parameters:**

- `query` (string, required): Documentation search query
- `section` (string): Docs section (tutorials, concepts, developers, reference)
- `maxResults` (number): Maximum results (default: 20)

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

## Configuration Options

### Storage Location

Repositories are cloned to `~/.aztec-mcp/repos/` by default.

Override with the `AZTEC_MCP_REPOS_DIR` environment variable:

```json
{
  "mcpServers": {
    "aztec-mcp": {
      "command": "npx",
      "args": ["--prefer-online", "-y", "@aztec/mcp-server"],
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
      "args": ["--prefer-online", "-y", "@aztec/mcp-server"],
      "env": {
        "AZTEC_DEFAULT_VERSION": "v3.0.0-devnet.6-plugin.1"
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

# Run locally
node dist/index.js
```

## Requirements

- Node.js 18+
- Git
- ripgrep (optional, for faster searching)

## Cloned Repositories

| Repository                                                        | Description       | Checkout                               |
| ----------------------------------------------------------------- | ----------------- | -------------------------------------- |
| [aztec-packages](https://github.com/AztecProtocol/aztec-packages) | Main monorepo     | Sparse: docs, aztec-nr, noir-contracts |
| [aztec-examples](https://github.com/AztecProtocol/aztec-examples) | Official examples | Full                                   |
| [aztec-starter](https://github.com/AztecProtocol/aztec-starter)   | Starter template  | Full                                   |

## License

MIT
