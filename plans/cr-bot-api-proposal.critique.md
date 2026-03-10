# Critique: CR Bot API Proposal (for Care Team)

**Reviewer:** reviewer agent
**Date:** 2026-03-10
**Verdict:** Needs 1 critical fix (routing bug), 1 important addition (timeout concern). Tone and completeness are excellent.

## Summary

The proposal is well-written, collaborative in tone, and technically sound in most areas. However, the route handler code has a critical bug: the `pathParameters.proxy` variable won't be populated for the direct `/api/cr` route because it uses specific CloudFormation path resources, not the `{proxy+}` catch-all. The handler code would silently skip the `api/cr` check and crash on `parse_slack_form_body()`. The Lambda's 5-second timeout is also tight for a synchronous endpoint making 7 external API calls.

---

## Findings

### 🔴 Critical: `pathParameters.proxy` is not set for the direct `/api/cr` route

**Location:** Proposal lines 159-197 (route handler code) and lines 92-128 (CloudFormation)

**Issue:** The handler checks `proxy = (event.get("pathParameters") or {}).get("proxy")` and then `if proxy == "api/cr":`. But the CloudFormation creates **specific** path resources (`ApiResource` with PathPart `"api"` → `ApiCrResource` with PathPart `"cr"`), NOT a `{proxy+}` path parameter.

With `AWS_PROXY` integration on a specific path:
- `pathParameters` = `null` (no path parameters defined on the resource)
- `proxy` = `None`
- `proxy == "api/cr"` → `False` — handler is unreachable

The request falls through to `parse_slack_form_body()` and crashes with `KeyError: 'trigger_id'`.

**Verified against:** `templates/cf.yml` line 254 — `{proxy+}` is defined on `ProxyResource`, not on the proposed `ApiCrResource`. Only requests through the catch-all have `pathParameters.proxy` set.

**Fix — two options:**

**(a) Check `resource` instead of `proxy`:**
```python
resource = event.get("resource", "")
if resource == "/api/cr":
    ...
```

**(b) Handle in `handler()` before `process_one_api_event()`** (recommended — cleaner separation):
```python
def handler(event, context):
    if "httpMethod" in event:
        resource = event.get("resource", "")
        if resource == "/api/cr":
            return handle_api_cr(event)
        return process_one_api_event(event)
    # SQS path unchanged...
```

Option (b) is cleaner because it keeps the API handler entirely separate from the Slack handler, and `process_one_api_event()` remains focused on Slack interactions.

---

### 🟡 Important: Lambda timeout is 5 seconds — tight for synchronous endpoint

**Location:** `templates/cf.yml` line 79 (`Timeout: 5`)

**Issue:** The CR creation flow makes ~7 external API calls in sequence:

1. `insert_into_table()` — DynamoDB
2. `post_to_slack()` — Slack API
3. `post_to_thread()` — Slack API
4. `get_user_real_name_from_slack_id()` — Slack API
5. `add_comment_to_story()` — Shortcut API
6. `set_cr_created()` — Shortcut API
7. `update_shortcut_environments()` — Shortcut API

On the SQS path this is fine — async processing with automatic retries on failure. On the direct synchronous path, ALL 7 calls must complete within the Lambda timeout. At 5 seconds, this is tight. If Slack or Shortcut APIs are slow (not uncommon), the Lambda times out and API Gateway returns a 502 to the caller.

**Worse:** Partial completion is possible. If DynamoDB insert and Slack posting succeed but the Lambda times out during Shortcut API calls, the caller gets a 502 but there's now a CR in Slack and DynamoDB with no corresponding Shortcut comment.

**Fix options:**
1. Increase Lambda timeout (15-30s) — either as a CF parameter or by using a second Lambda for the direct path
2. Add this as an Open Question in the proposal so the Care team can weigh in on their preferred approach
3. At minimum, mention the risk — the Care team will notice the 5s timeout when reviewing the CF diff

---

### 🟢 Minor: Credential fetching in separate handler

**Location:** Proposal line 193

**Issue:** The route handler code references `slack_token` and `shortcut_token`, which are fetched at the top of `process_one_api_event()` (lines 217-219 of `code/index.py`). If using fix option (b) above (separate `handle_api_cr()` function), these need to be fetched inside that function too.

---

## What Looks Good

- **Tone**: Excellent. Collaborative, respectful of ownership, offers to do the work. "Does the direct Lambda invoke path make sense? Are there concerns we haven't thought of?" is genuinely open-ended.
- **Architecture diagram** (lines 77-86): Clear visual showing the two paths. Helpful for a quick read.
- **"What's NOT Changing" section** (lines 237-245): Smart inclusion — reduces the Care team's anxiety about blast radius.
- **CF resource names**: All verified against actual `cf.yml` — `CrAutomationApiGateway` (line 228), `ChangeRequestLambda` (line 72), `CrAutomationApiDeployment` (line 270), `ProxyMethod` (line 256). Correct.
- **Open Questions**: Rate limiting, testing, and naming are good questions to surface. Auth approach question shows flexibility.
- **Shared function design**: Extracting `create_cr_from_values()` from inline logic is the right pattern — same behavior, just callable from two paths.

---

## Verdict

- [ ] Ready to share — fix the routing bug and add timeout concern first
- [x] Needs fixes (routing bug is critical — the handler would literally never match; timeout risk should be disclosed)
- [ ] Needs redesign
