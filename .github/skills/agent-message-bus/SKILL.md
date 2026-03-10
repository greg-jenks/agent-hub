---
name: agent-message-bus
description: Structured inter-agent messaging via ~/.agent/msg.js (send, reply, inbox, read, address, thread) for planner/coder/reviewer/puddleglum coordination.
---

# Agent Message Bus — Communication Protocol

## Overview

You have access to a message bus for structured communication with other agents (planner, coder, reviewer, puddleglum). Messages are sent and received via the `msg.js` CLI tool.

## Your Identity

You are the **{AGENT_NAME}** agent. Replace `{AGENT_NAME}` with your role when using commands.

## Mandatory: Check Inbox on Session Start

At the beginning of every session, check your inbox:

```bash
node ~/.agent/msg.js inbox {AGENT_NAME}
```

If there are blocking messages, resolve them before starting other work.

## Workflow

1. Check inbox on session start.
2. Read and handle blocking messages first.
3. Use `reply` to preserve thread context.
4. Mark messages `read` when actively working, and `address` with a specific note when complete.

## Commands

```bash
node ~/.agent/msg.js inbox {AGENT_NAME}
node ~/.agent/msg.js send {AGENT_NAME} <to> <type> --ref <ref> --body "..."
node ~/.agent/msg.js send {AGENT_NAME} <to> <type> --ref <ref> --blocking --body "..."
node ~/.agent/msg.js reply <parent-id> {AGENT_NAME} --body "..."
node ~/.agent/msg.js reply <parent-id> {AGENT_NAME} --to <agent> --body "..."
node ~/.agent/msg.js read <id>
node ~/.agent/msg.js address <id> --note "What was done"
node ~/.agent/msg.js thread <thread-id>
```

## Message Types

- `plan_feedback`: commenting on a plan
- `diff_feedback`: commenting on code changes
- `question`: asking for clarification
- `approval`: approval signal
- `info`: FYI

## Conventions

- Always use `--ref` with story ID, PR, or commit SHA.
- Use `--blocking` only for correctness/security/blocking concerns.
- Use `reply` to preserve thread context.
- Addressed notes should describe exactly what changed.

