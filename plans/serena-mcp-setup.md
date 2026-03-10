# Plan: Serena MCP Setup — IDE-Level Code Intelligence for Agents

> **Revision 2** — Updated after reviewer critique (serena-mcp-setup.critique.md).
> Fixes: custom context replaces `ide`, accurate tool exclusion list, concrete gitignore strategy,
> optional tools clarified, Copilot CLI instruction path specified, autocrlf guard rails added.

## Goal

Add Serena as an MCP server to OpenCode and Copilot CLI, configure per-project settings for key repositories, and update agent instructions so agents use Serena's symbol-level tools effectively.

## Background

### What Serena Is

Serena is an MCP server that gives LLM agents **IDE-like code intelligence** powered by Language Server Protocol (LSP). Instead of agents reading entire files, grepping for text, and doing string replacements, Serena provides **semantic, symbol-level tools** — the same capabilities that power VSCode's go-to-definition, find-references, and intellisense.

The core value: agents stop being "text editors with AI" and become "IDE users with AI." This matters most in **large codebases** where token efficiency and precision are critical.

### Key Tools Serena Provides (After Exclusions)

| Category | Tools | What It Does |
|----------|-------|--------------|
| **Symbol Navigation** | `find_symbol`, `find_referencing_symbols`, `get_symbols_overview` | Find classes/functions/variables by name, find all references, get file-level symbol outlines |
| **Symbol-Level Editing** | `replace_symbol_body`, `insert_before_symbol`, `insert_after_symbol`, `rename_symbol` | Edit code at the semantic level — replace a function body, insert before/after a class, rename across codebase |
| **Line-Level Editing** *(optional, not enabled by default)* | `replace_lines`, `delete_lines`, `insert_at_line` | Would require `included_optional_tools` in `project.yml`. Not needed — agents already have `Edit` for line-level work. |
| **Memory System** | `write_memory`, `read_memory`, `list_memories`, `edit_memory`, `delete_memory`, `rename_memory` | Per-project persistent knowledge in `.serena/memories/` as Markdown |
| **Project Management** | `activate_project`, `onboarding`, `check_onboarding_performed`, `get_current_config` | Switch between projects, auto-learn project structure, inspect active config |

### Why a Custom `opencode-multi` Context (Not `ide`)

The built-in `ide` context has two problems for our setup:

1. **`single_project: true`** — This disables `activate_project`, making multi-repo switching impossible. Since our agents work across 6+ repos, we need `single_project: false`.

2. **Incomplete tool exclusions** — `ide` only excludes 4 tools (`create_text_file`, `read_file`, `execute_shell_command`, `prepare_for_new_conversation`). It leaves `list_dir`, `find_file`, `replace_content`, `search_for_pattern`, and `initial_instructions` active — all of which duplicate OpenCode's built-in tools or conflict with AGENTS.md.

**Solution**: A custom context `opencode-multi` (already created at `~/.serena/contexts/opencode-multi.yml`) that:
- Sets `single_project: false` to enable `activate_project`
- Excludes 9 tools that duplicate host agent capabilities
- Keeps ~17 unique tools (symbol nav, symbol editing, memory, project management)

### Configuration Layers

```
CLI args (--context, --mode, --project)       <- highest precedence
Per-project: .serena/project.yml              <- languages, initial_prompt, tools
Global: ~/.serena/serena_config.yml           <- defaults, modes, ignored_paths
Custom context: ~/.serena/contexts/*.yml      <- our opencode-multi context
Mode: built-in (interactive, editing, etc.)   <- refines behavior/prompts
```

### Current State

- Serena installed via `uv` from git (version 0.1.4, cached at `C:\Users\gjenks\AppData\Local\uv\cache\`)
- Custom context `opencode-multi` created at `~/.serena/contexts/opencode-multi.yml` ✅
- No `.serena/project.yml` in any repo
- Neither `opencode.json` nor Copilot `mcp-config.json` include Serena
- Serena docs and config template reviewed in full

---

## Tasks

### Phase 1: MCP Server Configuration

#### Task 1: Add Serena to OpenCode's MCP config

**File**: `~/.config/opencode/opencode.json`

Add a `serena` entry to the `mcp` object:

```json
"serena": {
  "type": "local",
  "command": ["uvx", "--from", "git+https://github.com/oraios/serena", "serena", "start-mcp-server", "--context", "opencode-multi", "--open-web-dashboard", "false"],
  "enabled": true
}
```

**Rationale**:
- `--context opencode-multi` uses our custom context with `single_project: false` and comprehensive tool exclusions
- `--open-web-dashboard false` prevents a browser window popup on every agent session start
- No `--project` flag — agents work across multiple repos and call `activate_project` dynamically
- No `--mode` flags — default modes (`interactive`, `editing`) are correct for our workflow

#### Task 2: Add Serena to Copilot CLI's MCP config

**File**: `~/.copilot/mcp-config.json`

Add a `serena` entry to the `mcpServers` object:

```json
"serena": {
  "tools": ["*"],
  "command": "uvx",
  "args": [
    "--from", "git+https://github.com/oraios/serena",
    "serena", "start-mcp-server",
    "--context", "opencode-multi",
    "--open-web-dashboard", "false"
  ],
  "source": "user"
}
```

**Rationale**: Same as Task 1 but in Copilot CLI's JSON format (separate `command` and `args`).

---

### Phase 2: Per-Project Setup

#### Task 3: Create `.serena/project.yml` for key repositories

Create a `.serena/project.yml` in each of these repos. The file should use the project template structure from Serena's docs.

**Repos and their language configs:**

| Repo | Path | Languages | Notes |
|------|------|-----------|-------|
| `survey-management-api` | `C:\Users\gjenks\Repos\survey-management-api` | `python` | FastAPI backend, main work repo |
| `survey-management-web` | `C:\Users\gjenks\Repos\survey-management-web` | `typescript` | React frontend |
| `survey-fielding-api` | `C:\Users\gjenks\Repos\survey-fielding-api` | `python` | Survey fielding backend |
| `survey-fielding-web` | `C:\Users\gjenks\Repos\survey-fielding-web` | `typescript` | Survey fielding frontend |
| `agent-hub` | `C:\Users\gjenks\Repos\agent-hub` | `typescript` | Dashboard + Express server |
| `learnings-mcp` | `C:\Users\gjenks\Repos\learnings-mcp` | `python` | MCP server for learnings DB |

**Minimal `project.yml` template** (customize `project_name` and `languages` per repo):

```yaml
project_name: "<repo-name>"

languages:
- <language>

ignore_all_files_in_gitignore: true
ignored_paths: []
read_only: false
excluded_tools: []
included_optional_tools: []
encoding: utf-8
```

**Approach**: Use `uvx --from git+https://github.com/oraios/serena serena project create` in each repo directory. This auto-detects the language and creates the config. Alternatively, create the files manually using the template above.

**Gitignore strategy** (concrete decision):
- **Personal repos** (`agent-hub`, `learnings-mcp`): Add `.serena/` to the repo's `.gitignore` (entire directory)
- **Team repos** (survey-management-*, survey-fielding-*): Do NOT modify the repo's `.gitignore`. Instead, add `.serena/` to the **global gitignore** (`~/.gitignore_global`). This avoids polluting team repos without team buy-in.
  - Ensure global gitignore is configured: `git config --global core.excludesfile ~/.gitignore_global`
  - Add `.serena/` to `~/.gitignore_global`

**Note**: Serena auto-creates `.serena/.gitignore` during project setup that ignores caches/memories but allows `project.yml` through. For personal repos where we gitignore the whole `.serena/`, this is irrelevant. For team repos, the global gitignore covers everything.

#### Task 4: Index projects (optional, recommended for large repos)

Run in each project directory:

```shell
uvx --from git+https://github.com/oraios/serena serena project index
```

This pre-caches symbol information from the language servers so the first tool call isn't slow. Most important for the larger repos (`survey-management-api`, `survey-management-web`).

**Skip for now**: This can be done later. Serena works without indexing — it just means the first symbol query will be slower.

---

### Phase 3: Agent Instructions

#### Task 5: Add Serena usage section to global AGENTS.md

**File**: `~/.config/opencode/AGENTS.md`

Add a new section (suggested location: after §10 QMD, before §11 Agent Message Bus — renumber §11→§14, §12→§15). Content:

```markdown
## 11) Serena — IDE-Level Code Intelligence
Use the `serena` MCP tools to get semantic, symbol-level code understanding powered by LSP.

### When to use Serena:
- **Finding code**: Use `find_symbol` instead of `Grep` when looking for classes, functions,
  or variables — it searches by symbol type, not just text
- **Understanding file structure**: Use `get_symbols_overview` instead of `Read` to see
  what a file defines without reading every line
- **Impact analysis**: Use `find_referencing_symbols` before refactoring to find all callers/usages
- **Codebase-wide renames**: Use `rename_symbol` for LSP-powered, accurate renames
- **Editing by symbol**: Use `replace_symbol_body` to replace a function/class body
  without needing to match exact strings

### Project activation:
- At the start of a session, activate the project:
  call `activate_project` with the current repo path or project name
- On first activation of a new project, Serena will run onboarding automatically
  (creates memories about project structure, build system, etc.)
- After onboarding, start a new conversation to avoid context window bloat

### How Serena tools relate to built-in tools:
| Instead of... | Use Serena's... | Why |
|---|---|---|
| `Grep` for "class MyClass" | `find_symbol(name="MyClass", type="class")` | Finds by symbol type, not text |
| `Read` entire file to understand it | `get_symbols_overview(file_path="...")` | Shows structure, saves tokens |
| `Grep` for all usages of a function | `find_referencing_symbols(...)` | LSP-accurate, finds real usages |
| `Edit` to rename everywhere | `rename_symbol(...)` | Automated, codebase-wide |
| `Edit` to replace a function body | `replace_symbol_body(...)` | No exact string matching needed |

### Memory system:
Serena has its own per-project memory system (`.serena/memories/`).
This is separate from the `learnings` MCP:
- **Serena memories**: per-project, auto-created by onboarding, read by Serena
- **Learnings MCP**: cross-project, manually curated, semantically searched
Use both — they serve different purposes.

### Excluded tools (handled by host agent):
These Serena tools are disabled via the `opencode-multi` context because they
duplicate built-in capabilities: `create_text_file`, `read_file`, `execute_shell_command`,
`list_dir`, `find_file`, `replace_content`, `search_for_pattern`,
`prepare_for_new_conversation`, `initial_instructions`.
```

#### Task 6: Add Serena guidance to agent-specific instruction files

**Planner** (`~/.config/opencode/agents/planner.md`): No changes needed — planner doesn't write code.

**Reviewer** (`~/.config/opencode/agents/reviewer.md`): Add guidance to use `find_referencing_symbols` and `get_symbols_overview` during code review for impact analysis.

**Refactor** (`~/.config/opencode/agents/refactor.md`): Add guidance to prefer `rename_symbol` for renames and `replace_symbol_body` for function-level rewrites.

**Copilot CLI / GitHub Copilot**: The `agent-hub` repo has `AGENTS.md` which Copilot CLI reads. Add a brief Serena section there. For global Copilot instructions, check if `~/.github/copilot-instructions.md` exists — if not, the repo-level AGENTS.md is sufficient. Do NOT create a new global Copilot instructions file unless one already exists.

---

### Phase 4: Global Config Tweaks

#### Task 7: Verify Windows line ending config

Serena writes system-native line endings. **Check the current value first — do not blindly override.**

```shell
git config --global core.autocrlf
```

- If **unset**: Set to `true` — `git config --global core.autocrlf true`
- If **`true`**: No action needed
- If **`input` or `false`**: **Do not change.** This was likely set intentionally for cross-platform compatibility. Instead, test Serena-edited files to verify line endings are consistent with the repo's existing convention. If mismatches occur, address per-repo with `.gitattributes`.

#### Task 8: Customize `serena_config.yml` after first run

After the first Serena MCP server start (which auto-creates `~/.serena/serena_config.yml`), update these settings:

```yaml
web_dashboard: True
web_dashboard_open_on_launch: False

ignored_paths:
  - node_modules
  - __pycache__
  - .git
  - dist
  - build
  - "*.pyc"
  - .pytest_cache
  - .mypy_cache
  - .ruff_cache

default_modes:
  - interactive
  - editing
```

**Note**: The `--open-web-dashboard false` CLI flag overrides `web_dashboard_open_on_launch` at runtime, so this is belt-and-suspenders.

---

## Implementation Order

```
Task 7  ──── Phase 4a (check autocrlf first, before any Serena edits)
          │
Task 1  ──┐
Task 2  ──┤── Phase 1 (parallel, independent)
          │
Task 3  ──┤── Phase 2 (depends on Phase 1 being done so we can test)
Task 4  ──┘   (optional, can defer)
          │
Task 5  ──┤── Phase 3 (can be done in parallel with Phase 2)
Task 6  ──┘
          │
Task 8  ──── Phase 4b (do after first Serena run)
```

## Pre-completed Work

These items were done during planning and do NOT need to be repeated by the coder:

- ✅ Custom context `opencode-multi` created at `~/.serena/contexts/opencode-multi.yml`
  - `single_project: false` (enables `activate_project`)
  - 9 tools excluded (duplicates + unnecessary)
  - Custom prompt referencing host agent's built-in tools
- ✅ Serena installed via `uv` from git

## Risks / Open Questions

### 1. Tool Count
Adding Serena brings ~17 tools (after exclusions in `opencode-multi` context). Combined with existing MCP servers (learnings ~15, qmd ~6, shortcut ~50+), we'll have ~88+ tools. This affects:
- Token usage (all tool descriptions sent in every request)
- Model confusion (too many similar-sounding tools)

**Mitigation**: `opencode-multi` context aggressively excludes duplicates (9 excluded vs ide's 4). Monitor for issues. If problematic, use `excluded_tools` in `project.yml` to further reduce per-project.

### 2. Memory System Overlap
Serena has its own memory system (`.serena/memories/`) and we already have `learnings-mcp`. They serve different purposes:
- Serena memories: per-project, auto-created by onboarding, file-system based
- Learnings MCP: cross-project, manually curated, vector-search based

**Decision**: Use both. Document the distinction in AGENTS.md (Task 5).

### 3. Multiple Serena Instances
If both OpenCode and Copilot CLI run simultaneously, each spawns its own Serena MCP server with its own language servers. This:
- Uses more memory (2x language servers)
- May cause dashboard port conflicts (24282, 24283, etc.)

**Mitigation**: Dashboard auto-open is disabled via CLI flag. Memory usage is acceptable for modern machines.

### 4. Language Server Startup Time
LSP servers take a few seconds to start. First tool call after project activation may be slow (~5-10s).

**Mitigation**: Pre-indexing (Task 4) helps. After first activation, servers stay running for the session.

### 5. `.serena/` in Git
Handled by the concrete gitignore strategy in Task 3:
- Personal repos: `.serena/` in repo `.gitignore`
- Team repos: `.serena/` in global `~/.gitignore_global`

### 6. Per-Agent Tool Restrictions Not Possible
OpenCode shares MCP servers across all agents. We can't give Reviewer read-only Serena and Coder full Serena through the same config.

**Mitigation**: Use agent instruction files (Task 6) to guide which tools each agent should prefer. Trust the instructions over hard restrictions.

## Validation

After completing all tasks:

1. **Smoke test OpenCode**: Start an OpenCode session, ask agent to `"activate project survey-management-api using serena"` — onboarding should run
2. **Test symbol lookup**: Ask agent to `find_symbol` for a known class — should return accurate results
3. **Test symbol overview**: Ask agent to `get_symbols_overview` on a file — should return structured symbol list
4. **Test Copilot CLI**: Same tests in a Copilot CLI session
5. **Check dashboard** (optional): Navigate to `http://localhost:24282/dashboard/` while Serena is running
6. **Verify no tool conflicts**: Confirm agents aren't confused between Serena's tools and built-in tools
7. **Verify tool count**: In a session, count active Serena tools — should be ~17, not ~26
