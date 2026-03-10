# Plan: `slack-cr` Skill — Slack-First Change Request Drafting

## Status: Ready for Coder (Tasks 1-5) | Phase 2 Unblocked (repo access obtained)

## Goal

Build a `slack-cr` skill that drafts Change Request form content for the Slack-first CR workflow in `#info-change`, replacing the Shortcut comment-based `shortcut-cr` skill. As a final step, add the ability to post the CR to Slack directly via the CR bot's API.

## Background

### What's Changing

NRC Health's Change Request process is moving from Shortcut comments to a structured Slack workflow. The primary interface shifts from a Shortcut story comment (posted by the agent) to a Slack modal form in `#info-change`.

The existing `shortcut-cr` skill (at `~/.claude/skills/shortcut-cr/`) posts CR comments directly to Shortcut stories and sets custom fields. The new process makes that workflow obsolete.

### Old vs. New Process

| Aspect | Old (Shortcut) | New (Slack) |
|--------|---------------|-------------|
| **Where CR lives** | Comment on Shortcut story | Structured message in `#info-change` |
| **How it's created** | Agent posts comment via Shortcut MCP | Engineer fills Slack modal form |
| **Status tracking** | Shortcut custom fields + workflow states | System-controlled: DRAFT → READY → APPROVED → STARTED → EXECUTED → VERIFIED (+ ROLLED_BACK) |
| **Approval** | Peer replies "Approved" + sets custom field | Non-creator clicks Approve button in Slack |
| **Agent's role** | Posts comment, sets fields, checks readiness | Drafts form content, guides process, eventually posts via API |

### Template Field Changes

**Removed from old template:**
- Verification Plan (was a dedicated section in the Shortcut CR comment — replaced by Testing Plan in the Slack form)

**Added in new template:**
- CR Type (Normal / Emergency)
- Shortcut ID (explicit field linking back to story)
- Testing Plan (new field — distinct from the old Verification Plan)
- Environments (checkbox group: In Dev, In Stage, In Prod)

**Changed:**
- Risk: levels are now **Very Low / Low / Medium / High** (was Low/Medium/High in old template)
- Change Time: now a **date picker** (YYYY-MM-DD date only, no time or timezone)

**Retained (same concept, same content):**
- Name (was "CHANGE REQUEST: title")
- Change Description (was free-text description)
- Change Plan
- Rollback Plan
- Deployment Link(s)

### Current State

- `shortcut-cr` skill exists at `~/.claude/skills/shortcut-cr/` (SKILL.md + 2 reference files)
- No `slack-cr` skill exists yet
- The Slack CR bot is live in `#bot-cr-testing` (will move to `#info-change` when the process officially changes)
- The bot is built by the Care team — they own the repo and deployment
- The bot currently only accepts CRs through its Slack modal form (no API endpoint)

### CR Bot Architecture (discovered from repo analysis)

- **Repo**: `NationalResearchCorporation/change-request-automation` (cloned to `C:\Users\gjenks\Repos\change-request-automation`)
- **Language**: Python 3.12, zero external deps beyond boto3
- **Infra**: API Gateway → SQS Passer Lambda (`sqs-passer/index.py`) → SQS Queue → Main Lambda (`code/index.py`)
- **Storage**: DynamoDB (two tables: CR data keyed by `ts`, CR history keyed by `ts`+`slack_ts`)
- **Secrets**: AWS Secrets Manager (Slack bot token + Shortcut API token)
- **Deploy**: GitHub Actions → zip → VPN → Octopus Deploy
- **Route dispatch**: `pathParameters.proxy` in `process_one_api_event()` — currently handles `create_cr` and `slack/interactions`
- **Adding a new route**: Just add another `if proxy == "api/cr":` block in `process_one_api_event()` — the SQS passer lambda already forwards all API Gateway requests

### CR Bot Data Model (from `extract_modal_values()` in `helpers/misc_helper.py`)

| Field Key | Type | Slack Input |
|---|---|---|
| `name` | string | plain_text_input |
| `type` | string | static_select ("Normal" / "Emergency") |
| `risk` | string | static_select ("Very Low" / "Low" / "Medium" / "High") |
| `description` | string | plain_text_input (multiline) |
| `shortcut_id` | string | plain_text_input |
| `change_plan` | string | plain_text_input (multiline) |
| `testing_plan` | string | plain_text_input (multiline) |
| `rollback_plan` | string | plain_text_input (multiline) |
| `deployment_links` | string | plain_text_input (multiline, one per line) |
| `change_time` | string | datepicker (YYYY-MM-DD) |
| `environments` | list | checkboxes (["dev", "stage", "prod"]) |

Additional fields added by `handle_view_submission()`:
- `user_id` — Slack user ID of the creator
- `ts` — ISO timestamp used as DynamoDB partition key
- `status` — "DRAFT" (initial)
- `slack_ts` — Slack thread reply timestamp (details message)
- `slack_thread_ts` — Slack parent message timestamp (summary message)
- `approver` — Slack user ID of approver (set on approval)

---

## Tasks

### Phase 1: Core Skill (Unblocked — ready for Coder)

#### Task 1: Create `~/.claude/skills/slack-cr/SKILL.md`

The main skill file. YAML frontmatter + single workflow.

**Frontmatter:**

```yaml
---
name: slack-cr
description: Draft Change Request content for NRC Health's Slack-first CR process. Use when preparing production deployments, generating CR form content for #info-change, or guiding engineers through the CR workflow (DRAFT → READY → APPROVED). Requires the Shortcut MCP server (@shortcut/mcp@latest) for fetching story context.
---
```

**Capabilities (3 workflows):**

1. **Draft CR Form Content** (primary)
2. **Guide CR Workflow** (lightweight process guidance)
3. **Post CR to Slack** (Phase 2 — placeholder until API is available)

**Workflow 1: Draft CR Form Content**

Step 1 — Gather context:
- Shortcut story ID is always needed (e.g., `sc-67890`)
- Use `stories-get-by-id` to fetch title, description, labels, current state
- Derive additional context from conversation: git diff, PR description, commit messages
- Ask for anything that can't be inferred (risk level, change time, CR type)

Step 2 — Draft all 12 form fields:

| Field | How to Populate |
|-------|----------------|
| **Name** | Action-oriented title. Derive from story title. Verb phrase: "Add X", "Fix Y", "Update Z". |
| **CR Type** | Default to `Normal`. Only use `Emergency` if engineer explicitly says so. |
| **Risk** | Infer from context using risk guidance (see below). Always confirm with engineer. |
| **Change Description** | 1-3 sentences explaining the business goal. Focus on "why" not "how". Derive from story description or conversation. |
| **Shortcut ID** | The sc-XXXXX number provided by the engineer. |
| **Change Plan** | Numbered deployment steps. List each service/repo. Note deploy order if it matters (e.g., "API must deploy before web"). |
| **Testing Plan** | Steps to verify the change is working correctly after deployment. Include what to check, how to check it, and expected results. |
| **Rollback Plan** | How to undo. Usually: deploy previous version of each service. Note if DB migrations complicate rollback or if change is additive-only. |
| **Deployment Link(s)** | One URL per line. GHA pattern: `https://github.com/nrchealth/<repo>/actions`. Use `[To be added at deployment time]` if not yet available. |
| **Change Time** | Date only (YYYY-MM-DD format, e.g., `2026-03-15`). Use today's date as default if not specified. |
| **Environments** | Checkbox group — select which environments the change has been deployed to: Dev, Stage, Prod. |

Risk level guidance:
- **Very Low**: Trivial change, no risk — typo fix, copy change, config tweak with no behavioral impact
- **Low**: Additive feature, no DB migrations, no breaking changes, limited scope
- **Medium**: Schema changes, multiple services affected, changes to shared components
- **High**: Data migrations, breaking API changes, security-related changes, high-traffic paths

Step 3 — Present for review:
- Show the drafted content as a structured block, field by field
- Ask: "Does this look accurate? Want to adjust anything?"
- Do NOT proceed without engineer confirmation

Step 4 — Output for copy-paste:
- Format the approved content so each field value can be individually copied into the Slack modal
- Tell engineer: "Open the CR form in `#info-change`, paste these values, and click Post."
- If the Post CR workflow (Phase 2) is available, offer to post directly instead

**Workflow 2: Guide CR Workflow**

When asked "what do I do next?" or "how does the CR process work?":

1. Load [references/cr-process.md](references/cr-process.md) for the full process
2. Determine where the engineer is in the process
3. Give specific next-step guidance:

| Current State | What to Do Next |
|---------------|----------------|
| No CR exists | Draft CR content (Workflow 1), then post via Slack form in `#info-change` |
| **DRAFT** | Review the CR content. When ready, click "Mark as Ready" in Slack. Only the creator can do this. |
| **READY** | Get a peer or lead (not you) to click "Approve Change Request" in Slack. |
| **APPROVED** | Click "Start Change Request" when you begin deployment. |
| **STARTED** | Execute the deployment per your change plan. Click "Mark as Executed" when done. "Rollback" is available if something goes wrong. |
| **EXECUTED** | Verify the deployment is working. Click "Mark as Verified" when confirmed. "Rollback" is available if issues are found. |
| **VERIFIED** | Done! CR lifecycle complete. "Rollback" remains available if a late issue is discovered. |
| **ROLLED_BACK** | CR was rolled back. The CR moves back to DRAFT state — edit and re-submit when ready. |

**Workflow 3: Post CR to Slack** (placeholder — Phase 2)

> This workflow is not yet available. It requires an API endpoint on the CR bot (see Phase 2 below).
> For now, use the copy-paste output from Workflow 1.

When available, this workflow will:
1. Take the approved draft from Workflow 1
2. POST to the CR bot's API endpoint
3. Return the Slack message link
4. Always require engineer confirmation before posting

**Shortcut MCP Tools Reference:**

| Tool | Use For |
|------|---------|
| `stories-get-by-id` | Fetch story details for pre-filling CR fields |
| `stories-search` | Find related stories in a batch release |

Note: Unlike the old `shortcut-cr` skill, this skill does NOT update Shortcut custom fields. The Slack CR bot is the system of record.

**Important Rules:**
- **Always require confirmation** before outputting final content or posting
- **Same-version redeployments** with no config changes do NOT need a CR
- **Config/variable changes** DO need a full CR even without code changes
- **Multiple stories in a release batch**: each needs its own CR
- **Never set CR Type to Emergency** unless the engineer explicitly requests it
- **Default to Normal** for CR Type and **Low** for Risk when context is ambiguous — but always confirm

#### Task 2: Create `~/.claude/skills/slack-cr/references/examples.md`

CR form content examples for the new Slack process. Load this file when drafting CR content.

**Example 1: Single-Service Normal CR**

```
Name: Add Amplitude Tracking to Transparency Portal
CR Type: Normal
Risk: Low
Change Description: Add automatic user interaction tracking and session replay capability to the Transparency portal using Amplitude. This enables the product team to analyze user behavior and identify UX friction points.
Shortcut ID: sc-67890
Change Plan:
1. Deploy transparency-portal via GHA to Production
Testing Plan:
1. Verify Amplitude events are firing in the Production Amplitude dashboard
2. Confirm session replay captures user interactions on key pages
3. Verify no console errors related to Amplitude SDK
Rollback Plan:
1. Deploy previous version of transparency-portal via GHA
2. Change is additive only — no DB migrations, safe to roll back
Deployment Link(s):
https://github.com/nrchealth/transparency-portal/actions
Change Time: 2026-03-15
Environments: Dev, Stage
```

**Example 2: Multi-Service Normal CR with Deploy Ordering**

```
Name: Provider Quota Export Feature
CR Type: Normal
Risk: Medium
Change Description: Add ability to export quota data by panel provider with vendor alias filtering and Excel formatting. Requires coordinated API and web deployment.
Shortcut ID: sc-68001
Change Plan:
1. Deploy survey-management-api via GHA to Production (must deploy first — backend dependency)
2. Deploy survey-management-web via GHA to Production
Testing Plan:
1. Navigate to quota management page, verify Export button appears
2. Export quota data with provider filters — verify Excel file downloads correctly
3. Verify vendor alias filtering produces expected results
4. Confirm API health checks pass after deployment
Rollback Plan:
1. Revert survey-management-web to previous version via GHA
2. Revert survey-management-api to previous version via GHA
3. No DB migrations — feature is additive only
Deployment Link(s):
https://github.com/nrchealth/survey-management-api/actions
https://github.com/nrchealth/survey-management-web/actions
Change Time: 2026-03-20
Environments: Dev, Stage
```

**Example 3: Emergency CR**

```
Name: Fix Survey Submission Timeout on High-Volume Accounts
CR Type: Emergency
Risk: High
Change Description: Production hotfix for survey submissions timing out on accounts with >10,000 active respondents. Root cause is an unindexed query in the completion check. Customers are experiencing failed submissions during peak hours.
Shortcut ID: sc-68100
Change Plan:
1. Deploy survey-fielding-api via GHA to Production
Testing Plan:
1. Verify survey submissions complete within 5 seconds on high-volume test account
2. Monitor error rate in CloudWatch for 15 minutes post-deploy
3. Confirm the new index exists in the database
Rollback Plan:
1. Revert survey-fielding-api to previous version via GHA
2. Migration adds an index only — rollback does not remove it (safe)
Deployment Link(s):
[To be added at deployment time]
Change Time: 2026-03-09
Environments: Dev
```

**Writing guidance for each field** (same structure as old examples.md — title guidance, description guidance, change plan guidance, testing plan guidance, rollback guidance, deployment links, change time, risk levels including Very Low).

#### Task 3: Create `~/.claude/skills/slack-cr/references/cr-process.md`

Lightweight process reference for the Slack-first CR workflow.

Contents:
- Overview: Slack is the primary interface for CRs. Channel: `#info-change`.
- CR states: DRAFT → READY → APPROVED → STARTED → EXECUTED → VERIFIED (+ ROLLED_BACK)
- What happens at each state:
  - **DRAFT**: Default after posting. Creator can Edit or Delete. Click "Mark as Ready" to advance.
  - **READY**: Visible to approvers. A peer/lead (not the creator) clicks "Approve Change Request."
  - **APPROVED**: Approval recorded. Click "Start Change Request" to begin deployment.
  - **STARTED**: Deployment in progress. Click "Mark as Executed" when done. "Rollback" available.
  - **EXECUTED**: Awaiting verification. Click "Mark as Verified" to confirm. "Rollback" available.
  - **VERIFIED**: CR lifecycle complete. "Rollback" remains available for late issues.
  - **ROLLED_BACK**: CR was rolled back. Returns to DRAFT state for re-submission.
- Form fields reference (all 12 fields with types and valid values — see data model in Background section)
- CR Type guidance: Normal (default) vs Emergency
- Important rules:
  - Same-version redeployments (no config changes) do NOT need a CR
  - Config/variable changes DO need a full CR even without code changes
  - Each story in a batch release needs its own CR
  - All updates and approvals are tracked automatically in Slack
  - Status is system-controlled — cannot be manually overridden

---

### Phase 2: Slack Posting via CR Bot API (Unblocked — repo access obtained)

#### Task 4: Add API endpoint to CR bot for programmatic CR creation

**Repo**: `NationalResearchCorporation/change-request-automation` (cloned to `C:\Users\gjenks\Repos\change-request-automation`)

**What to build**: A synchronous HTTP endpoint that accepts CR data and creates a DRAFT CR, bypassing the async SQS pipeline that Slack webhooks use.

**⚠️ Architecture constraint**: The current architecture routes ALL API Gateway requests through an SQS passer lambda (`sqs-passer/index.py`) which always returns 200 immediately and dumps the event into SQS. The main lambda processes events asynchronously from SQS and its return value goes to SQS batch reporting, NOT to the HTTP caller. This means:
- Auth responses (401) would never reach the caller
- Validation errors (400) would never reach the caller
- CR data responses would never reach the caller

**Solution**: Bypass SQS for the `api/cr` route by adding a direct Lambda invoke path in the CloudFormation template. API Gateway can invoke the main lambda directly (synchronous Lambda proxy integration) instead of going through the SQS passer. The existing SQS path stays for Slack webhooks (which need the 3-second ack pattern).

**Implementation plan** (estimated ~100-140 lines across 3 files):

1. **Add direct Lambda invoke route in CloudFormation** (`templates/cf.yml`):

   Add a new API Gateway resource `api/cr` that integrates directly with `ChangeRequestLambda` (not the SQS passer). API Gateway resolves specific routes before the `{proxy+}` catch-all, so `POST /api/cr` will go to the main lambda directly while all other routes continue through SQS.

   ```yaml
   # New resources to add (after ProxyMethod, before CrAutomationApiDeployment):

   ApiResource:
     Type: AWS::ApiGateway::Resource
     Properties:
       RestApiId: !Ref CrAutomationApiGateway
       ParentId: !GetAtt CrAutomationApiGateway.RootResourceId
       PathPart: "api"

   ApiCrResource:
     Type: AWS::ApiGateway::Resource
     Properties:
       RestApiId: !Ref CrAutomationApiGateway
       ParentId: !Ref ApiResource
       PathPart: "cr"

   ApiCrMethod:
     Type: AWS::ApiGateway::Method
     Properties:
       HttpMethod: POST
       ResourceId: !Ref ApiCrResource
       RestApiId: !Ref CrAutomationApiGateway
       AuthorizationType: NONE
       Integration:
         Type: AWS_PROXY
         IntegrationHttpMethod: POST
         Uri: !Sub "arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${ChangeRequestLambda.Arn}/invocations"
       MethodResponses:
         - StatusCode: "200"

   MainLambdaApiInvokePermission:
     Type: AWS::Lambda::Permission
     Properties:
       Action: lambda:InvokeFunction
       FunctionName: !Ref ChangeRequestLambda
       Principal: apigateway.amazonaws.com
       SourceArn: !Sub "arn:aws:execute-api:${AWS::Region}:${AWS::AccountId}:${CrAutomationApiGateway}/*/POST/api/cr"
   ```

   Also add `ApiCrMethod` to the `DependsOn` list of `CrAutomationApiDeployment`.

2. **Update `handler()` in `code/index.py`** to detect direct API Gateway invocations vs SQS events, and route `/api/cr` to a dedicated handler. Since the `/api/cr` route uses a specific API Gateway resource (not `{proxy+}`), `pathParameters` won't contain a `proxy` key — so we route based on `event["resource"]` instead:

   ```python
   def handler(event, context):
       # Direct API Gateway invocation (synchronous — bypasses SQS)
       if "httpMethod" in event:
           resource = event.get("resource", "")
           if resource == "/api/cr":
               return handle_api_cr(event)
           # Future direct routes could be added here
           return process_one_api_event(event)

       # SQS batch processing (async — from SQS passer)
       failures = []
       for record in event.get("Records", []):
           msg_id = record.get("messageId", "unknown")
           try:
               original_event = json.loads(record["body"])
               process_one_api_event(original_event)
           except Exception as e:
               print(f"Failed message {msg_id}: {e}")
               failures.append({"itemIdentifier": msg_id})
       return {"batchItemFailures": failures}
   ```

3. **Extract CR creation logic** from `handle_view_submission()` in `code/index.py` (lines 125-141):
   - The "else" branch (new CR creation, not edit) is currently inline
   - Extract into a new function `create_cr_from_values(values, channel_id, slack_token, shortcut_token, field_map)` that:
     - Sets `ts`, `status = "DRAFT"`
     - Calls `insert_into_table()`, `log_event()`, `build_summary_blocks()`
     - Posts to Slack via `post_to_slack()` and `post_to_thread()`
     - Saves timestamps, adds Shortcut comment, sets CR fields
     - Returns `{ "ts": ..., "slack_ts": ..., "status": "DRAFT" }`
   - Update `handle_view_submission()` to call this extracted function

4. **Add `handle_api_cr()` function** in `code/index.py` — a dedicated handler for the REST API path, separate from Slack event processing. This is called from `handler()` (step 2) when `resource == "/api/cr"`:

   ```python
   def handle_api_cr(event):
       # Auth FIRST — before any validation or field access
       auth_header = (event.get("headers") or {}).get("Authorization", "")
       expected_token = os.environ.get("CR_API_TOKEN", "")
       if not expected_token or auth_header != f"Bearer {expected_token}":
           return {"statusCode": 401, "body": json.dumps({"error": "unauthorized"})}

       body = json.loads(event.get("body", "{}"))

       # Validate required fields (user_id is required, not optional)
       required = ["name", "type", "risk", "description", "shortcut_id",
                    "change_plan", "testing_plan", "rollback_plan",
                    "deployment_links", "change_time", "environments", "user_id"]
       missing = [f for f in required if f not in body]
       if missing:
           return {"statusCode": 400, "body": json.dumps({"error": f"Missing fields: {missing}"})}

       # Validate enum values
       if body["type"] not in ("Normal", "Emergency"):
           return {"statusCode": 400, "body": json.dumps({"error": "type must be Normal or Emergency"})}
       if body["risk"] not in ("Very Low", "Low", "Medium", "High"):
           return {"statusCode": 400, "body": json.dumps({"error": "risk must be Very Low, Low, Medium, or High"})}

       # Validate environments is a list with valid values
       if not isinstance(body["environments"], list):
           return {"statusCode": 400, "body": json.dumps({"error": "environments must be a list"})}
       invalid_envs = [e for e in body["environments"] if e not in ("dev", "stage", "prod")]
       if invalid_envs:
           return {"statusCode": 400, "body": json.dumps({"error": f"Invalid environments: {invalid_envs}. Must be dev, stage, or prod"})}

       slack_token = get_bot_credentials()
       shortcut_token = get_shortcut_credentials()
       field_map = get_custom_field_id_name_map(shortcut_token)
       channel_id = os.environ.get("CR_CHANNEL_ID", body.get("channel_id", ""))

       result = create_cr_from_values(body, channel_id, slack_token, shortcut_token, field_map)
       return {"statusCode": 200, "body": json.dumps(result)}
   ```

   Note: `process_one_api_event()` is unchanged — it continues to handle Slack webhook events routed through SQS exactly as before.

5. **Add environment variables to Lambda**:
   - `CR_API_TOKEN` — stored in AWS Secrets Manager (follow existing pattern with `get_bot_credentials()`) or as a Lambda env var via CloudFormation parameter
   - `CR_CHANNEL_ID` — the Slack channel ID for `#info-change` (or `#bot-cr-testing` during development)

Proposed API contract:

```
POST /api/cr
Authorization: Bearer <CR_API_TOKEN>
Content-Type: application/json

{
  "name": "Add Amplitude Tracking to Transparency Portal",
  "type": "Normal",
  "risk": "Low",
  "description": "Add automatic user interaction tracking...",
  "shortcut_id": "sc-67890",
  "change_plan": "1. Deploy transparency-portal via GHA to Production",
  "testing_plan": "1. Verify Amplitude events firing in dashboard",
  "rollback_plan": "1. Deploy previous version...",
  "deployment_links": "https://github.com/nrchealth/transparency-portal/actions",
  "change_time": "2026-03-15",
  "environments": ["dev", "stage"],
  "user_id": "U12345678"
}
```

Response (200):

```json
{
  "ts": "2026-03-15T14:00:00.000000",
  "slack_ts": "1710511200.000100",
  "status": "DRAFT"
}
```

Error responses:
- `401`: `{"error": "unauthorized"}` — missing or invalid Bearer token
- `400`: `{"error": "Missing fields: [...]"}` — missing required fields
- `400`: `{"error": "type must be Normal or Emergency"}` — invalid enum value

**Key design decisions:**
- **Synchronous path via direct Lambda invoke** — bypasses SQS so responses actually reach the caller. Existing Slack webhook path stays async via SQS.
- **Dedicated `handle_api_cr()` function** — separate from `process_one_api_event()` because the direct API Gateway route uses a specific resource (`/api/cr`), not `{proxy+}`, so `pathParameters.proxy` is not set. Routing is based on `event["resource"]` in `handler()`.
- **Auth checked first** — before any field validation, to prevent information leakage to unauthenticated callers
- **`user_id` is required, not optional** — prevents `get_user_real_name_from_slack_id()` crash on fake user IDs
- Field names match the existing data model exactly (no translation layer needed)
- `deployment_links` is a string (one URL per line), matching how the modal stores it
- `environments` is a list of strings (`["dev", "stage", "prod"]`), matching `extract_modal_values()` output, with validation
- `change_time` is a date string (YYYY-MM-DD), matching the datepicker output

**Deployment**: Care team reviews the PR and deploys via their pipeline (GitHub Actions → Octopus Deploy). The CloudFormation changes add a new API Gateway route with direct Lambda integration — this is additive and doesn't affect existing routes.

#### Task 5: Wire `slack-cr` skill to use the CR bot API

After Task 4 is merged and deployed:

1. **Update Workflow 3 in SKILL.md** — replace the placeholder with the real posting workflow:
   - Take the approved draft from Workflow 1
   - Construct the API request body matching the bot's data model exactly
   - POST to the CR bot API endpoint
   - Parse the response — extract `ts` (CR identifier) and `slack_ts` (message timestamp)
   - Show confirmation: "CR posted to #info-change. Status: DRAFT. Next: click 'Mark as Ready' in Slack when you're ready for approval."
   - Always require engineer confirmation before posting

2. **Handle the API call** — Options:
   - **Script in skill**: A small `post-cr.ps1` script in `slack-cr/scripts/` that the agent calls via shell. Takes JSON on stdin, posts to the API, returns the response. Simple, no MCP dependency.
   - **Direct Invoke-WebRequest**: Agent constructs and runs the HTTP request directly. Simplest, but puts the API URL and token in the command.

   Recommended: **Script approach**. A `post-cr.ps1` script that reads the API URL and token from environment variables (`CR_BOT_API_URL`, `CR_BOT_API_TOKEN`), takes JSON input, and returns the response.

3. **Identity handling**: The script must include the engineer's Slack user ID in the `user_id` field. Options:
   - Store the mapping in an env var (`SLACK_USER_ID=U12345678`)
   - Ask the engineer for their Slack user ID on first use
   - Hard-code per-user in the skill's env setup

4. **Environment setup**: Document the env vars needed:
   - `CR_BOT_API_URL` — e.g., `https://<api-gateway-url>/api/cr`
   - `CR_BOT_API_TOKEN` — API key for authentication
   - `SLACK_USER_ID` — the engineer's Slack user ID (for "submitted by" attribution)

---

### Phase 3: Cleanup (After new process is live)

#### Task 6: Delete `shortcut-cr` skill

Once the new process is officially live in `#info-change`:

1. Delete `~/.claude/skills/shortcut-cr/` directory (SKILL.md + references/)
2. Remove any references to `shortcut-cr` in AGENTS.md or other config files
3. If `shortcut-cr` was distributed to `survey-management-tools/.github/skills/`, remove it there too

---

## Implementation Order

```
Task 1  ──┐
Task 2  ──┤── Phase 1: Core Skill (unblocked, ready for Coder)
Task 3  ──┘
           │
Task 4  ──── Phase 2a: CR Bot API endpoint (unblocked — repo access obtained, needs Care team PR review)
           │
Task 5  ──── Phase 2b: Wire skill to API (blocked on Task 4 being deployed)
           │
Task 6  ──── Phase 3: Cleanup (after new process is live)
```

## Pre-completed Work

- Analysis of old `shortcut-cr` skill (full review of SKILL.md, examples.md, cr-process.md)
- Mapping of old template fields to new form fields
- Risk level definitions updated for actual 4-tier system (Very Low / Low / Medium / High)
- Channel confirmed: `#info-change` (currently testing in `#bot-cr-testing`)
- Full CR bot codebase analysis completed (10 Python files, ~1,150 lines)
- CR bot architecture documented (Python 3.12, Lambda, API Gateway, SQS, DynamoDB)
- CR bot data model mapped (12 form fields + system fields)
- CR lifecycle states mapped (7 states including ROLLED_BACK)
- Task 4 implementation plan written with exact file locations and line references

## Risks / Open Questions

### 1. ~~CR Bot Architecture Unknown~~ (RESOLVED)
~~We don't know the bot's language, framework, or internal structure yet.~~
**Resolved**: Python 3.12, AWS Lambda, API Gateway → SQS → Lambda. Architecture fully documented in Background section above.

### 2. Auth Mechanism for Bot API (Task 4)
The bot currently has no auth on any endpoint (Slack interactions are trusted by convention). Adding a Bearer token is the simplest approach, but needs Care team buy-in.

**Mitigation**: Propose the simplest viable auth (env var token + Bearer header). Easy to upgrade later.

### 3. Channel Transition Timing
The process is currently in `#bot-cr-testing` and will move to `#info-change`. The skill references `#info-change` (the final state).

**Mitigation**: If the skill ships before the channel transition, add a note that the channel is temporarily `#bot-cr-testing`. Easy one-line update later.

### 4. Emergency CR Process Unclear
The new process adds "Emergency" as a CR Type but doesn't describe any different workflow for emergencies (faster approval? skip Ready state?).

**Mitigation**: Skill defaults to Normal. Emergency is only used when the engineer explicitly requests it. If the process adds emergency-specific rules later, update the skill.

### 5. User Identity for API-Created CRs (NEW — Task 4-5)
The bot uses `user_id` from Slack payloads to attribute CRs ("submitted by <@user>"). An API endpoint needs the caller to provide a Slack user ID. If omitted, the CR shows "submitted by API_USER" which is confusing.

**Mitigation**: Require `user_id` in the API payload. The skill stores the engineer's Slack user ID in an env var (`SLACK_USER_ID`).

### 6. CR Creation Logic is Inline (Task 4)
The `handle_view_submission()` function has CR creation logic inline (not extracted). Task 4 requires refactoring this into a shared function before the API route can call it.

**Mitigation**: This is a safe refactor — extract existing code, no behavior change. The existing function becomes a thin wrapper. But it does expand the diff for the Care team PR review.

### 7. Care Team PR Approval (Task 4)
We can write the code, but the Care team (CODEOWNERS: `@NationalResearchCorporation/care`) must review and approve the PR. Their review velocity is unknown.

**Mitigation**: Keep the PR small and well-documented. Consider reaching out to the team before submitting.

## Validation

### Phase 1 (Tasks 1-3)
1. Load the `slack-cr` skill (restart agent session)
2. Ask: "Help me create a CR for sc-67890" — should draft all 12 fields (including Testing Plan)
3. Ask: "What's the CR process?" — should explain full lifecycle: DRAFT → READY → APPROVED → STARTED → EXECUTED → VERIFIED (+ ROLLED_BACK)
4. Verify risk guidance includes all 4 levels (Very Low/Low/Medium/High — NOT "Critical")
5. Verify Change Time uses date-only format (YYYY-MM-DD), not date+time+timezone
6. Verify Environments is a checkbox group (Dev/Stage/Prod), not separate In Dev/In Stage booleans
7. Verify no references to old Shortcut custom fields or Shortcut workflow states

### Phase 2 (Tasks 4-5)
1. Call the CR bot API with a test payload — should create a DRAFT CR in `#bot-cr-testing` (or `#info-change`)
2. Verify the API validates required fields and rejects bad payloads with 400
3. Verify the API rejects requests without a valid Bearer token with 401
4. Ask the skill to draft and post a CR — should call the API after confirmation
5. Verify the posted CR appears in Slack with correct content, buttons, and DRAFT status
6. Verify a Shortcut comment is added to the referenced story
