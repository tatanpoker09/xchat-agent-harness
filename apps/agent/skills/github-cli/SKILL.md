---
name: github-cli
description: GitHub CLI workflows for PRs, issues, and repo management
when_to_use: When asked to review PRs, create PRs, check CI status, manage issues, or interact with GitHub
---

# GitHub CLI

Use the `bash` tool to run `gh` commands. The GitHub CLI (`gh`) is authenticated and available.

## Common Workflows

### Review a Pull Request

1. Get PR overview:
   ```
   gh pr view <number> --json title,body,author,baseRefName,headRefName,state,additions,deletions,changedFiles
   ```

2. Read the diff:
   ```
   gh pr diff <number>
   ```

3. Check CI status:
   ```
   gh pr checks <number>
   ```

4. List review comments:
   ```
   gh api repos/{owner}/{repo}/pulls/<number>/comments --jq '.[] | "\(.path):\(.line) - \(.body)"'
   ```

5. Post a review:
   ```
   gh pr review <number> --comment --body "Your review comments here"
   ```
   Or approve:
   ```
   gh pr review <number> --approve --body "LGTM"
   ```
   Or request changes:
   ```
   gh pr review <number> --request-changes --body "Please fix..."
   ```

### Create a Pull Request

1. Check current branch status:
   ```
   gh pr list --head $(git branch --show-current)
   ```

2. Create the PR:
   ```
   gh pr create --title "Title" --body "Description" --base main
   ```

### Manage Issues

- List open issues: `gh issue list`
- View an issue: `gh issue view <number>`
- Create an issue: `gh issue create --title "Title" --body "Description"`
- Close an issue: `gh issue close <number>`
- Add labels: `gh issue edit <number> --add-label "bug"`

### Check CI / Actions

- View recent runs: `gh run list --limit 5`
- View a specific run: `gh run view <run-id>`
- View logs: `gh run view <run-id> --log-failed`
- Re-run failed jobs: `gh run rerun <run-id> --failed`

### Repository Info

- View repo: `gh repo view`
- List branches: `gh api repos/{owner}/{repo}/branches --jq '.[].name'`
- Compare branches: `gh api repos/{owner}/{repo}/compare/main...<branch> --jq '.ahead_by, .behind_by'`

## Tips

- Use `--json` flag with `--jq` for structured output when you need specific fields.
- For large diffs, pipe through `head -200` to avoid overwhelming output.
- Always check CI status before approving a PR.
- When reviewing, read the PR description first to understand intent before looking at code.
