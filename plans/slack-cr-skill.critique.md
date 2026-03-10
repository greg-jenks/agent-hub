# Critique: `slack-cr` Skill Plan

**Reviewer:** reviewer agent
**Date:** 2026-03-09
**Verdict:** Phase 1 ready for Coder | Phase 2 needs redesign (1 critical architectural flaw, 3 important bugs)

## Summary

Phase 1 (Tasks 1-3) is thorough, well-researched, and ready for implementation. The data model mapping, field-by-field population guidance, and example CRs are solid. However, Phase 2 (Tasks 4-5) has a critical flaw: the plan designs a synchronous API endpoint but the CR bot uses an async SQS architecture that makes synchronous responses impossible. Three additional bugs in the proposed API route code would cause crashes or silent failures even if the architecture were synchronous.

---

## Findings

### 🔴 Critical: SQS architecture breaks synchronous API design (Task 4)

**Location:** Plan lines 314-407 (Task 4 implementation plan + API contract)

**Issue:** The plan designs a synchronous request-response API that returns CR data (`ts`, `slack_ts`, `status`). But the actual architecture is:

```
Client → API Gateway → SQS Passer Lambda (returns 200) → SQS → Main Lambda
```

The SQS passer lambda (`sqs-passer/index.py` lines 8-21) **always returns 200 immediately** and dumps the event into SQS. The main lambda processes the event asynchronously from SQS. Its return value goes back to SQS (as batch item failure reporting), **not to the API caller**.

**Impact — four cascading failures:**
1. **Auth is useless** — Unauthorized requests get 200 from the SQS passer before auth is checked in the main lambda. The 401 response is never sent to the caller.
2. **Validation responses never reach caller** — 400 responses for missing/invalid fields go to SQS, not to the HTTP client.
3. **CR data never reaches caller** — The plan's proposed response `{ "ts": ..., "slack_ts": ..., "status": "DRAFT" }` is computed in the main lambda but discarded by SQS.
4. **Error handling is silent** — If CR creation fails (e.g., bad Slack user ID, DynamoDB error), the main lambda logs the error and reports a batch item failure to SQS. The client, which already got 200, has no idea.

**Verified against code:** `sqs-passer/index.py` always returns `{"statusCode": 200}` (lines 16-20). `handler()` in `code/index.py` returns `{"batchItemFailures": failures}` to SQS (line 260), not to HTTP.

**Fix — three options (pick one):**

1. **Bypass SQS for the API route**: Add a second API Gateway integration that invokes the main lambda directly (synchronous), bypassing the SQS passer. API Gateway supports Lambda proxy integration directly. The existing SQS path stays for Slack webhooks (which need the 3-second ack). The `api/cr` route would go through the synchronous path and actually return the response.

2. **Fire-and-forget API**: Accept that the API is async. Return 200 meaning "accepted for processing." Add a separate `GET /api/cr/{ts}` endpoint (also synchronous) to poll for the created CR's status. The skill would POST, then poll until the CR appears. Simpler but adds polling complexity.

3. **Add auth to the SQS passer**: Move the Bearer token check into the SQS passer lambda so unauthorized requests get a real 401. Keep the API as fire-and-forget (200 = accepted). Accept that the skill won't get back CR data in the response. This is the simplest option but loses the confirmation workflow the plan describes.

**Recommendation:** Option 1 is cleanest — it matches the plan's intended behavior and the diff is small (one CloudFormation resource in `templates/cf.yml`). Discuss with the Care team which they prefer.

---

### 🟡 Important: Route ordering — `parse_slack_form_body()` crashes before `api/cr` handler (Task 4)

**Location:** Plan line 329 ("Add API route in `process_one_api_event()` (after line 243)")

**Issue:** The plan says to insert the `api/cr` handler after line 243 (after the `create_cr` block). But line 239 runs unconditionally before we reach that point:

```python
# line 239 — runs for ALL requests that aren't slack/interactions
text, trigger_id, channel_id = parse_slack_form_body(event)
```

`parse_slack_form_body()` parses the event body as URL-encoded form data and accesses `parsed["trigger_id"][0]` (misc_helper.py line 14). An API request with a JSON body will crash here with a `KeyError: 'trigger_id'`.

**Trace:**
1. API request hits `process_one_api_event()` with `proxy = "api/cr"`
2. Line 221: `proxy != "slack/interactions"` → skip
3. Line 239: `parse_slack_form_body(event)` → **KeyError: 'trigger_id'** → exception
4. `api/cr` handler on line 244+ is never reached

**Fix:** Insert the `api/cr` check **before line 239** (between the `slack/interactions` block and the `parse_slack_form_body` call):

```python
    if proxy == "slack/interactions":
        ...  # existing code

    if proxy == "api/cr":           # ← must go here
        ...
        return { ... }

    text, trigger_id, channel_id = parse_slack_form_body(event)  # line 239

    if proxy == "create_cr":
        ...
```

---

### 🟡 Important: Auth check happens after field validation (Task 4)

**Location:** Plan lines 334-351 (pseudocode for `api/cr` route)

**Issue:** The pseudocode validates required fields and enum values first (lines 337-345), then checks the Bearer token (lines 348-351). This is a security anti-pattern:

1. **Information leakage**: An unauthenticated caller learns which fields are missing or have invalid values via the 400 response before being rejected.
2. **Wasted processing**: Validation runs for every unauthenticated request.

**Fix:** Move the auth check to the top of the `api/cr` handler, before any field validation:

```python
if proxy == "api/cr":
    # Auth first
    auth_header = (event.get("headers") or {}).get("Authorization", "")
    expected_token = os.environ.get("CR_API_TOKEN", "")
    if not expected_token or auth_header != f"Bearer {expected_token}":
        return {"statusCode": 401, "body": json.dumps({"error": "unauthorized"})}

    # Then validate
    body = json.loads(event.get("body", "{}"))
    ...
```

---

### 🟡 Important: `user_id` defaults to `"API_USER"` despite being required (Task 4)

**Location:** Plan line 354 and Risk #5 (lines 498-500)

**Issue:** Risk #5 says "Require `user_id` in the API payload" but the code does `body["user_id"] = body.get("user_id", "API_USER")`, which silently defaults instead of rejecting.

When `user_id = "API_USER"`, the CR creation flow calls `get_user_real_name_from_slack_id(slack_token, "API_USER")` (index.py line 138). This Slack API call will either:
- Return an error (no such user) → unhandled exception → CR creation fails silently
- Return unexpected data → CR shows garbled "submitted by" text

**Fix:** Add `user_id` to the required fields list (line 335) so the API returns 400 if omitted:

```python
required = ["name", "type", "risk", "description", "shortcut_id",
             "change_plan", "testing_plan", "rollback_plan",
             "deployment_links", "change_time", "environments", "user_id"]  # ← add
```

Remove the fallback on line 354 entirely.

---

### 🟢 Minor: No validation for `environments` values or `change_time` format (Task 4)

**Location:** Plan lines 334-358

**Issue:** The plan validates `type` and `risk` enum values but doesn't validate:
- `environments` — should only contain `"dev"`, `"stage"`, `"prod"`
- `change_time` — should match `YYYY-MM-DD` format
- `environments` should be a list, not a string

**Suggestion:** Add validation, or at minimum document that invalid values will be stored as-is. The bot's modal UI enforces this on the Slack side, but the API bypasses the modal.

---

### 🟢 Minor: Task 2 example inconsistency with Task 4 data model

**Location:** Plan lines 228 (Example 2 Environments field) and 277 (Example 3 Environments field)

**Issue:** Example 2 shows `Environments: Dev, Stage` (comma-separated, title case) and Example 3 shows `Environments: Dev` (single value, title case). But the actual data model uses lowercase list values: `["dev", "stage", "prod"]`. The examples should clarify that these are human-readable labels and the API expects the lowercase list form.

**Suggestion:** Either add a note in the examples ("For the Slack form, select: Dev, Stage. API equivalent: `["dev", "stage"]`") or be consistent with the API format.

---

## What Looks Good

- **Thorough data model mapping**: The 12-field table (lines 69-83) matches `extract_modal_values()` exactly — verified against the actual code. Every field name, type, and valid value is accurate.
- **Risk level correction**: Updated from 3-tier (Low/Medium/High) to 4-tier (Very Low/Low/Medium/High) with clear guidance for each level. Matches the actual `static_select` in the bot.
- **Lifecycle states**: All 7 states documented correctly, including the ROLLED_BACK → DRAFT loop. Verified against `handle_block_actions()` in `code/index.py`.
- **Phase 1 is clean and complete**: Tasks 1-3 have enough detail for the Coder to implement without guessing. The field population table, risk guidance, and workflow descriptions are actionable.
- **Smart scoping**: The phased approach (draft-only first, posting later) means the skill is immediately useful even before the API exists.
- **Good examples**: The three CR examples (single-service, multi-service, emergency) cover the most common real-world scenarios and include the new fields (Testing Plan, Environments, CR Type).
- **Old skill analysis**: The mapping from old template fields to new form fields (lines 29-47) is accurate. Verified against `shortcut-cr/SKILL.md`.

---

## Verdict

- [x] **Phase 1 (Tasks 1-3): Ready for Coder** — No issues. Skill structure, field mappings, examples, and process documentation are all accurate and complete.
- [ ] **Phase 2 (Task 4): Needs redesign** — The SQS architecture makes the synchronous API design impossible. The route ordering bug and auth ordering are also must-fix. Resolve the architecture question (synchronous Lambda invoke vs. fire-and-forget) before the Coder starts Task 4.
- [ ] **Phase 2 (Task 5): Blocked** — Depends on Task 4's final API contract, which depends on the architecture decision above.
- [x] **Phase 3 (Task 6): Ready when needed** — Straightforward cleanup, no issues.
