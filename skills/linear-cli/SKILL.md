---
name: linear-cli
description: Manage Linear issues via the harness `linear` CLI (GraphQL + LINEAR_API_KEY)
when_to_use: When asked to create/view/update Linear issues, search tickets, list teams, or comment on issues
---

# Linear (harness CLI)

Auth is already configured via **`LINEAR_API_KEY`** in the agent environment.
Do **not** ask the user for a token. Do **not** print the key.

Workspace: **xai-linear** (SpaceXAI). Viewer: Christian Eilers.

## Check

```bash
linear whoami
linear teams
```

## Common commands

```bash
# Me
linear whoami

# Teams (JSON array of {id,key,name})
linear teams

# Recent issues (optional team key + limit)
linear issues --limit 10
linear issues XCHAT --limit 20

# View by UUID or key (e.g. ENG-123)
linear issue view ENG-123

# Create
linear issue create --title "Short title" --team TEAMKEY --description "$(cat <<'EOF'
## Summary
...
EOF
)"

# Update
linear issue update ISSUE_ID --title "New" --state "In Progress" --description "..."

# Comment
linear issue comment ISSUE_ID --body "Shipped in PR #42"

# Search
linear search "missing messages sync"

# Raw GraphQL when needed
linear gql '{ viewer { id name } }'
linear gql 'query($t:String!){ searchIssues(term:$t,first:10){ nodes { identifier title url } } }' '{"t":"xchat"}'
```

## Rules

1. Prefer `linear …` over raw `curl` (key is already in env).
2. Never echo `$LINEAR_API_KEY` or paste tokens into chat/DMs.
3. For multi-line markdown, use a heredoc file then `"$(cat /tmp/…)"`.
4. After create, paste the issue **url** + **identifier** back to the user.
5. If a team key is unknown, `linear teams | jq` and pick the closest match — ask only if ambiguous.

## Fallback curl (only if `linear` missing)

```bash
curl -sS https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ viewer { id name email } }"}'
```
