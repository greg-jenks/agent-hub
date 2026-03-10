# Proposal: Add a REST API Endpoint to the CR Bot

## TL;DR

We'd like to propose adding a single `POST /api/cr` endpoint to the Change Request bot that lets tools create DRAFT CRs programmatically. The CR shows up in Slack exactly like one created through the modal — same message, same buttons, same lifecycle. We're happy to write the PR; we'd just need your review and buy-in on the approach.

## Why This Would Be Useful

We're building a coding assistant skill that helps engineers draft Change Request content. Right now, the skill generates the 12 form fields and the engineer manually copy-pastes each value into the Slack modal. It works, but it's clunky — especially for multi-service CRs where the fields are dense.

An API endpoint would let the skill post the CR directly to `#info-change` after the engineer reviews and approves the draft. The CR would arrive in Slack as a normal DRAFT, with all the same buttons and lifecycle the bot already manages. The engineer still has full control — they review the draft before it's posted, and they can edit/delete it in Slack afterward just like any other CR.

**What this enables:**
- Engineer says "help me create a CR for sc-67890"
- The skill pulls context from Shortcut, git, and the conversation to draft all 12 fields
- Engineer reviews the draft, tweaks anything that needs adjusting
- Skill posts the CR to `#info-change` — it shows up as a normal DRAFT
- Engineer continues through the lifecycle as usual (Ready → Approved → Started → etc.)

## What We're Proposing

A single new route: **`POST /api/cr`** — accepts JSON, creates a DRAFT CR, returns the result.

**Scope:**
- ~100-140 new lines across 3 files (`cf.yml`, `index.py`, and a small refactor to share existing CR creation logic)
- No changes to the Slack modal flow, button handling, or lifecycle logic
- No new dependencies
- Additive only — all existing behavior stays exactly the same

### API Contract

```
POST /api/cr
Authorization: Bearer <token>
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

The field names and types match the existing data model exactly — same keys that `extract_modal_values()` produces. No translation layer needed.

**Responses:**
- `200` — CR created, returns `{ "ts": "...", "slack_ts": "...", "status": "DRAFT" }`
- `401` — missing or invalid Bearer token
- `400` — missing required fields or invalid values (with descriptive error message)

### What the Engineer Sees

Nothing different. The CR appears in Slack as a normal DRAFT message with the summary blocks, detail thread, and all the usual buttons (Edit, Delete, Mark as Ready). The Shortcut story gets the standard CR comment. Everything downstream — approval, execution, verification, rollback — works exactly the same because it's the same CR creation logic.

## How It Fits the Existing Architecture

Your current architecture is clever — the SQS passer lambda gives Slack the fast 200 response it needs (within 3 seconds), while the main lambda does the actual work asynchronously. That pattern is perfect for Slack webhooks.

For a REST API though, we need a synchronous path so the caller gets the response (created CR data, or validation errors, or a 401). The approach we'd propose:

**Add a direct API Gateway → Lambda route for just this one path.** API Gateway resolves specific routes (`/api/cr`) before the `{proxy+}` catch-all, so:
- `POST /api/cr` → invokes `ChangeRequestLambda` directly (synchronous)
- Everything else → continues through the SQS passer (unchanged)

This means the existing Slack webhook flow is completely untouched. The direct route only applies to this one new endpoint.

```
                     ┌─────────────────────────────────────────────┐
                     │              API Gateway                     │
                     │                                              │
                     │  POST /api/cr ──────► ChangeRequestLambda    │  (new, direct)
                     │                       (synchronous response) │
                     │                                              │
                     │  {proxy+}    ──────► SQS Passer Lambda       │  (existing, unchanged)
                     │                       ──► SQS ──► Lambda     │
                     └─────────────────────────────────────────────┘
```

### CloudFormation Changes

Four new resources (after `ProxyMethod`, before `CrAutomationApiDeployment`):

```yaml
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

Plus adding `ApiCrMethod` to the `DependsOn` list of `CrAutomationApiDeployment`.

### Handler Changes

The `handler()` function needs to detect whether it's being invoked directly by API Gateway or via SQS. Since the `/api/cr` route uses a specific API Gateway resource (not the `{proxy+}` catch-all), `pathParameters` won't contain a `proxy` key — so we route based on `event["resource"]` instead, and handle it separately from the Slack event processing:

```python
def handler(event, context):
    # Direct API Gateway invocation (synchronous — the new /api/cr path)
    if "httpMethod" in event:
        resource = event.get("resource", "")
        if resource == "/api/cr":
            return handle_api_cr(event)
        # Future direct routes could be added here
        return process_one_api_event(event)

    # SQS batch processing (existing async path — unchanged)
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

### API Route Handler

The `handle_api_cr()` function is separate from `process_one_api_event()` — it handles auth, validation, and CR creation for the REST API path. This keeps it cleanly isolated from the Slack event processing.

```python
def handle_api_cr(event):
    # Auth first — before any validation or field access
    auth_header = (event.get("headers") or {}).get("Authorization", "")
    expected_token = os.environ.get("CR_API_TOKEN", "")
    if not expected_token or auth_header != f"Bearer {expected_token}":
        return {"statusCode": 401, "body": json.dumps({"error": "unauthorized"})}

    body = json.loads(event.get("body", "{}"))

    # Validate required fields
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

    # Validate environments
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

### Shared CR Creation Function

The CR creation logic currently lives inline in `handle_view_submission()` (the `else` branch, lines 125-141). We'd extract it into a shared function that both the modal submission and the API route can call:

```python
def create_cr_from_values(values, channel_id, slack_token, shortcut_token, field_map):
    now = datetime.now().isoformat()
    values["ts"] = now
    values["status"] = "DRAFT"

    insert_into_table(values)
    log_event({}, values, "CREATE", values["user_id"])
    blocks = build_summary_blocks(values, values["user_id"])
    _, ts = post_to_slack(slack_token, channel_id, blocks, values["user_id"])
    _, thread_ts = post_to_thread(slack_token, channel_id, build_details_blocks(values), ts)

    save_ts(now, thread_ts)
    save_parent_ts(now, ts)
    creator_name = get_user_real_name_from_slack_id(slack_token, values["user_id"])["user"]["real_name"]
    add_comment_to_story(values["shortcut_id"], shortcut_token, format_shortcut_block(values, creator_name))
    set_cr_created(values["shortcut_id"], shortcut_token, field_map)
    update_shortcut_environments(values["shortcut_id"], values["environments"], shortcut_token, field_map)

    return {"ts": now, "slack_ts": ts, "status": "DRAFT"}
```

Then `handle_view_submission()` calls it instead of having the logic inline. Same behavior, just shared.

### New Environment Variables

Two new env vars on `ChangeRequestLambda`:

| Variable | Purpose | How to Set |
|----------|---------|------------|
| `CR_API_TOKEN` | Bearer token for API authentication | Secrets Manager (following your existing pattern) or CF parameter |
| `CR_CHANNEL_ID` | Target Slack channel ID | CF parameter — `#bot-cr-testing` during dev, `#info-change` for prod |

## What's NOT Changing

- ✅ Slack modal form — unchanged
- ✅ Button interactions (Edit, Delete, Ready, Approve, Start, Execute, Verify, Rollback) — unchanged
- ✅ SQS async pipeline for Slack webhooks — unchanged
- ✅ DynamoDB schema — unchanged (API-created CRs use the same fields)
- ✅ Shortcut integration (comments, custom fields, environments) — unchanged
- ✅ CR lifecycle and state machine — unchanged
- ✅ Existing API Gateway routes — unchanged

## What We'd Need From You

1. **Feedback on this approach** — Does the direct Lambda invoke path make sense? Are there concerns we haven't thought of? Are there plans for the bot that would conflict with this?

2. **PR review** — We're happy to write the code and open a PR. Your team would review it as normal (CODEOWNERS requires `@NationalResearchCorporation/care` approval).

3. **API token setup** — We'd need to agree on how to manage the Bearer token. Simplest option: add it to Secrets Manager alongside the existing bot credentials. Open to whatever approach you prefer.

4. **Channel ID configuration** — We'd need the Slack channel ID for `#bot-cr-testing` (for initial testing) and eventually `#info-change`.

## Open Questions

- **Lambda timeout**: The current timeout is 5 seconds, which works well for the async SQS path. On the synchronous API path, CR creation makes ~7 external calls (DynamoDB, 2× Slack API, Slack user lookup, 3× Shortcut API), which could be tight if any service is slow. Would you want to increase the timeout (e.g., 15-30s), or is 5 seconds typically plenty of headroom for these calls?
- **Auth approach**: We proposed a simple Bearer token. Would you prefer something different (API key header, IAM auth, etc.)?
- **Rate limiting**: Should we add any throttling? For our use case, we'd expect single-digit requests per day, but worth discussing.
- **Testing**: Would you like us to include unit tests? The codebase doesn't currently have them, so we'd follow whatever your preference is.
- **Naming**: We used `api/cr` as the path — open to alternatives if you have a convention in mind.
