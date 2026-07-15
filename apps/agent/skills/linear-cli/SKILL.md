---
name: linear-cli
description: Manage Linear issues from the command line using the linear cli. This skill allows automating linear management.
allowed-tools: Bash(linear:*), Bash(curl:*)
---

# Linear CLI

A CLI to manage Linear issues from the command line, with git and jj integration.

## Prerequisites

The `linear` command must be available on PATH. To check:

```bash
linear --help
```

If not installed globally, you can run it via bunx:

```bash
bunx @zwarunek/linear-cli --help
```

All subsequent commands can be prefixed with `bunx @zwarunek/linear-cli` in place of `linear`.

## Best Practices for Content Arguments

When working with issue descriptions, comment bodies, or document content that contains markdown or multi-line text, **use heredoc or file-based approaches** to avoid shell escaping issues:

```bash
# Write markdown to a temporary file, then pass inline
cat > /tmp/description.md <<'EOF'
## Summary

- First item
- Second item

## Details

This is a detailed description with proper formatting.
EOF

# Read the file content into the flag
linear issue create --title "My Issue" --description "$(cat /tmp/description.md)"

# Or for comments
linear issue comment add ENG-123 "$(cat /tmp/comment.md)"
```

**Why:** Passing multi-line content directly as shell arguments can cause escaping issues with newlines and special characters.

**For simple, single-line content**, inline flags work fine:

```bash
linear issue create --title "Fix login bug" --description "The login form crashes on submit"
linear issue comment add ENG-123 "This is fixed in the latest release"
```

## Available Commands

Compact command list, generated from `linear --help`:

```bash
linear auth
linear auth login
linear auth logout
linear auth list
linear auth default
linear auth token
linear auth whoami
linear auth migrate

linear issue
linear issue list
linear issue view
linear issue create
linear issue update
linear issue delete
linear issue start
linear issue id
linear issue title
linear issue url
linear issue describe
linear issue commits
linear issue pull-request
linear issue comment
linear issue comment add
linear issue comment list
linear issue comment update
linear issue comment delete
linear issue attach
linear issue link
linear issue relation
linear issue relation add
linear issue relation list
linear issue relation delete

linear team
linear team list
linear team create
linear team delete
linear team id
linear team autolinks
linear team members

linear project
linear project list
linear project view
linear project create
linear project update
linear project delete

linear project-update
linear project-update list
linear project-update create

linear cycle
linear cycle list
linear cycle view

linear milestone
linear milestone list
linear milestone view
linear milestone create
linear milestone update
linear milestone delete

linear initiative
linear initiative list
linear initiative view
linear initiative create
linear initiative update
linear initiative delete
linear initiative archive
linear initiative unarchive
linear initiative add-project
linear initiative remove-project

linear initiative-update
linear initiative-update list
linear initiative-update create

linear label
linear label list
linear label create
linear label delete

linear user
linear user list
linear user search

linear document
linear document list
linear document view
linear document create
linear document update
linear document delete

linear config

linear schema

linear api
```

## Reference Documentation

- [auth](${CLAUDE_SKILL_DIR}/references/auth.md)
- [issue](${CLAUDE_SKILL_DIR}/references/issue.md)
- [team](${CLAUDE_SKILL_DIR}/references/team.md)
- [project](${CLAUDE_SKILL_DIR}/references/project.md)
- [project-update](${CLAUDE_SKILL_DIR}/references/project-update.md)
- [cycle](${CLAUDE_SKILL_DIR}/references/cycle.md)
- [milestone](${CLAUDE_SKILL_DIR}/references/milestone.md)
- [initiative](${CLAUDE_SKILL_DIR}/references/initiative.md)
- [initiative-update](${CLAUDE_SKILL_DIR}/references/initiative-update.md)
- [label](${CLAUDE_SKILL_DIR}/references/label.md)
- [user](${CLAUDE_SKILL_DIR}/references/user.md)
- [document](${CLAUDE_SKILL_DIR}/references/document.md)
- [config](${CLAUDE_SKILL_DIR}/references/config.md)
- [schema](${CLAUDE_SKILL_DIR}/references/schema.md)
- [api](${CLAUDE_SKILL_DIR}/references/api.md)

## Command Aliases

Several commands have shorter aliases:

| Command | Alias |
|---------|-------|
| `linear team` | `linear t` |
| `linear project` | `linear p` |
| `linear project-update` | `linear pu` |
| `linear cycle` | `linear cy` |
| `linear milestone` | `linear m` |
| `linear initiative` | `linear init` |
| `linear initiative-update` | `linear iu` |
| `linear label` | `linear l` |
| `linear user` | `linear u` |

## Configuration

The CLI reads configuration from `.linear.toml` files (searched upward from cwd) and `~/.config/linear/linear.toml` (global).

```toml
team_id = "uuid-or-key"
workspace = "workspace-name"
```

Environment variables override config:
- `LINEAR_API_KEY` - API key (bypasses credential store)
- `LINEAR_TEAM_ID` - Default team
- `LINEAR_WORKSPACE` - Default workspace

## Authentication

API key resolution order:
1. `LINEAR_API_KEY` environment variable
2. `api_key` in `.linear.toml`
3. Workspace from `.linear.toml` -> credential store lookup
4. Default workspace from credential store

Credentials stored in `~/.config/linear/credentials.toml` with optional keyring integration (macOS Keychain, Linux libsecret).

## Using the Linear GraphQL API Directly

**Prefer the CLI for all supported operations.** The `api` command should only be used as a fallback for queries not covered by the CLI.

### Check the schema for available types and fields

```bash
linear schema --output "${TMPDIR:-/tmp}/linear-schema.graphql"
grep -i "cycle" "${TMPDIR:-/tmp}/linear-schema.graphql"
grep -A 30 "^type Issue " "${TMPDIR:-/tmp}/linear-schema.graphql"
```

### Make a GraphQL request

**Important:** GraphQL queries containing non-null type markers (e.g. `String!`) must be passed via heredoc stdin to avoid shell escaping issues with the `!` character.

```bash
# Simple query (no type markers)
linear api '{ viewer { id name email } }'

# Query with variables — use heredoc to avoid escaping issues
linear api --variable teamId=abc123 <<'GRAPHQL'
query($teamId: String!) { team(id: $teamId) { name } }
GRAPHQL

# Pipe to jq for filtering
linear api '{ issues(first: 5) { nodes { identifier title } } }' | jq '.data.issues.nodes[].title'

# Auto-paginate through all results
linear api --paginate '{ issues(first: 50) { nodes { identifier title } pageInfo { hasNextPage endCursor } } }'
```

### Advanced: Using curl directly

For cases where you need full HTTP control, use `linear auth token`:

```bash
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $(linear auth token)" \
  -d '{"query": "{ viewer { id } }"}'
```
