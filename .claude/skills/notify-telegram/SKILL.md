---
name: notify-telegram
description: Send the user a Telegram message when they are away. Use ONLY when the user has said they're OOO / leaving / going unsupervised (or explicitly asks for a ping), to notify them that a long-running task finished or needs input. Do NOT use it while the user is actively in the session with you.
---

# Notify via Telegram

Sends a message to the user's Telegram chat using their bot. Credentials live in
`credentials.env` next to this file (gitignored — never commit or echo the token).

## When to use

- ONLY when the user is away: they've said they're OOO, leaving, going to bed,
  stepping out, or otherwise leaving you working unsupervised — or they explicitly
  ask to be pinged.
- Do NOT ping while the user is actively present in the session; just reply in chat.
- Good moments while they're away: a task completes, all work is done, or you're
  blocked and need their input before continuing.

## How to send

Run this from the skill directory (do NOT print the token in logs):

```bash
set -a; . "$CLAUDE_PROJECT_DIR/.claude/skills/notify-telegram/credentials.env"; set +a
curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
  --data-urlencode "text=${MSG}" \
  --data-urlencode "parse_mode=Markdown" \
  -o /dev/null -w "telegram: %{http_code}\n"
```

Set `MSG` to the message first, e.g. `MSG="✅ Email verification feature merged — tests green."`.
If `$CLAUDE_PROJECT_DIR` is unset, use the absolute path to this skill directory.

## Guidance

- Keep messages short and specific: what finished, key result, any action needed.
- A `telegram: 200` line means it was delivered. Any other code → report it, don't retry blindly.
- Send on completion of tasks the user asked to be notified about, or on explicit request.
- Never paste the bot token into chat, commit messages, or command output.
