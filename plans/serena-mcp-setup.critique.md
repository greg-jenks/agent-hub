# Critique: Serena MCP Setup Plan

**Verdict: Needs fixes before execution — 1 critical, 2 important, 3 minor**

---

## Findings

### 🔴 Critical: `ide` context has `single_project: true` — breaks multi-repo workflow

- **File**: Plan Tasks 1, 2, 5 (MCP config + AGENTS.md guidance)
- **Issue**: The plan proposes `--context ide` with no `--project` flag, expecting agents to call `activate_project` dynamically to switch between repos. But the actual `ide` context YAML (`ide.yml`) sets `single_project: true`, which **always disables `activate_project`**. The AGENTS.md guidance (Task 5) explicitly tells agents to "call `activate_project` with the current repo path" — but that tool won't exist at runtime.
- **Evidence**: Verified in `serena/resources/config/contexts/ide.yml`:
  ```yaml
  single_project: true
  # "The `activate_project` tool is always disabled in this case,
  #  as project switching cannot be allowed."
  ```
- **Impact**: Agents cannot switch between projects. They'd be stuck with no active project (since no `--project` flag is passed at startup), making symbol tools useless. Or if `--project` is passed, they're locked to one repo per session.
- **Fix options** (pick one):
  1. **Create a custom context** based on `ide` but with `single_project: false`: Run `serena context create --from-internal ide -n opencode-multi`, then edit the custom context to set `single_project: false`. Use `--context opencode-multi` in both MCP configs. This preserves the tool exclusions while allowing multi-repo switching.
  2. **Use `--project-from-cwd`** instead of dynamic activation: Pass `--project-from-cwd` which auto-detects the project from CWD. But this only works if Serena's CWD matches the active repo, which may not be the case with OpenCode's working directory.
  3. **Accept single-project mode**: Pass `--project <path>` at startup and limit each Serena session to one repo. Re-evaluate if multi-repo is really needed per session.

  **Recommendation**: Option 1. Create a custom `opencode-multi` context. This is the cleanest fix and preserves the plan's multi-repo intent.

---

### 🔴→🟡 Important: Plan mischaracterizes what `ide` context actually excludes

- **File**: Plan Background section ("Why `ide` Context") and Risk #1
- **Issue**: The plan states `ide` context "**disables** Serena's `read_file`, `create_text_file`, `execute_shell_command`, `list_dir`, etc." But the actual `ide.yml` only excludes **4 tools**: `create_text_file`, `read_file`, `execute_shell_command`, `prepare_for_new_conversation`. Tools like `list_dir`, `find_file`, `replace_content`, and `search_for_pattern` are **NOT excluded** and remain active — these all duplicate OpenCode's built-in `Read`, `Glob`, `Edit`, and `Grep` tools.
- **Impact**: More tool duplication than expected. The "~20 tools" estimate may be accurate by count, but the plan understates which tools overlap. Risk #1 (tool count explosion) is worse than described because the duplicate tools remain.
- **Fix**: 
  - Update the Background section to accurately list the 4 excluded tools
  - In the custom context (from Critical fix above), add `list_dir`, `find_file`, `replace_content`, and `search_for_pattern` to `excluded_tools` to truly eliminate duplicates
  - Update the tool count estimate: After exclusions, Serena would expose ~14-16 tools (symbol tools + memory + project mgmt + onboarding + initial_instructions + config)
  - Consider also excluding `initial_instructions` (Serena's own system prompt injection, which may conflict with AGENTS.md)

---

### 🟡 Important: `.serena/` gitignore strategy is ambiguous

- **File**: Task 3 (Per-Project Setup)
- **Issue**: Task 3 says "Add `.serena/` entries to each repo's `.gitignore` if not already covered, OR gitignore just the cache/index files while versioning `project.yml`". The coder needs a concrete decision, not an "OR". For the 4 team repos (survey-management-*), adding `.gitignore` entries requires a commit + PR that affects other developers.
- **Fix**: Make a concrete decision. Recommended approach:
  - For **personal repos** (`agent-hub`, `learnings-mcp`): Add `.serena/` to `.gitignore` (entire directory)
  - For **team repos** (survey-management-*, survey-fielding-*): Add only `.serena/` to your **global gitignore** (`~/.gitignore_global` or `git config --global core.excludesfile`) to avoid polluting team repos. Don't commit `.serena/` entries to team repos' `.gitignore` without team buy-in
  - Alternatively, Serena auto-creates `.serena/.gitignore` on project setup — verify this covers caches/memories and only let `project.yml` through

---

### 🟢 Minor: Background "Key Tools" table lists optional tools as default-available

- **File**: Plan Background, "Key Tools Serena Provides" table
- **Issue**: The table lists `replace_lines`, `delete_lines`, `insert_at_line` under "Line-Level Editing" as if they're standard tools. But these are **optional tools** (not enabled by default) — verified via `serena tools list --only-optional`. They would need to be added to `included_optional_tools` in each `project.yml` to be available.
- **Fix**: Either add these to `project.yml` template's `included_optional_tools`, or add a note in the table that these require explicit opt-in. Since agents already have `Edit` for line-level editing, these optional tools may not be worth enabling.

---

### 🟢 Minor: Task 6 Copilot CLI instruction file location is underspecified

- **File**: Task 6 (Agent-Specific Instructions)
- **Issue**: Task 6 says Copilot CLI coder guidance goes in "`~/.copilot/` or `~/.github/copilot-instructions.md`". But `~/.github/copilot-instructions.md` doesn't exist on this machine. The GitHub Copilot CLI reads instructions from a specific location that isn't documented clearly here. The coder needs a concrete file path.
- **Fix**: Specify the exact file. For GitHub Copilot CLI (gh copilot), global instructions are typically in `~/.copilot/instructions.md` or the MCP config's description field. Verify by checking `gh copilot --help` or Copilot CLI docs. If no global instruction file exists, consider whether this task is needed (Copilot CLI already gets the agent-hub AGENTS.md via repo-level `.github/copilot-instructions.md`).

---

### 🟢 Minor: Task 7 git autocrlf may not need changing

- **File**: Task 7 (Windows line ending config)
- **Issue**: The plan says to check `core.autocrlf` and set it to `true` if not set. This is a global git setting that could affect all repos. If the current setting is intentional (e.g., `input` for cross-platform repos), blindly setting `true` could cause line-ending issues in team repos.
- **Fix**: Check the current value first and only change if it's unset. If it's `input` or `false`, document why changing to `true` is safe (or isn't). Add a validation step to confirm Serena-edited files don't introduce CRLF/LF mismatches.

---

## What Looks Good

- **Overall structure**: Clean 4-phase approach with clear task separation and dependency diagram
- **Risk analysis**: Thorough — covers tool explosion, memory overlap, multiple instances, startup time, and git concerns
- **AGENTS.md guidance (Task 5 content)**: The "Instead of... / Use Serena's..." table is excellent for agent guidance. The memory system distinction is clearly documented.
- **Config format**: Both OpenCode and Copilot CLI JSON formats match the existing patterns in the actual config files (verified against `opencode.json` and `~/.copilot/mcp-config.json`)
- **`--open-web-dashboard false`**: Correct flag name and format (verified via `serena start-mcp-server --help`)
- **Global `serena_config.yml` ignored paths**: Comprehensive list matching the existing repo ecosystems
- **Validation checklist**: Concrete smoke tests that would catch the critical bug (agent would fail on `activate_project`)

---

## Verdict

- [ ] Ready to merge
- [x] **Needs fixes** (must address findings #1 and #2 before execution)
- [ ] Needs redesign

### Must fix:
1. **Critical**: Resolve `single_project: true` conflict — create a custom context or restructure the approach
2. **Important**: Accurately list excluded tools and add remaining duplicates to exclusion list

### Should address:
3. Concrete `.serena/` gitignore decision (team vs personal repos)

### Nice to fix:
4. Clarify optional vs default tools in the Background table
5. Specify exact Copilot CLI instruction file path
6. Add guard rails to Task 7 for existing `core.autocrlf` settings
