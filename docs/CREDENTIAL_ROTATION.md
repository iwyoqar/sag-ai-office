# Credential rotation checklist — exposure of 2026-10-30

Owner: project owner. **Claude does not revoke credentials, change passwords or handle secret values**: every
step below is done by the owner (or explicitly authorised step by step). Never paste a secret into chat, an
issue, a commit or a document — only into the local `.env` and the Render environment.

## What was exposed (no values here)

Commit `d3605b2` (2026-10-30 10:15, pushed to the private GitHub repository) contained:

| Item | Where | Assessment |
|---|---|---|
| Gemini API key | `.env.example` | compromised — anyone with repository access could copy it |
| Telegram bot token | `.env.example` | compromised — full control of the bot |
| Admin password (initial) | `.env.example` | compromised if it is still the admin's password anywhere |
| Dev database `data/sag.db` | repository | 2 user accounts with scrypt password hashes (N=2^14), 11 unexpired session-token hashes, 5 Telegram update records, audit log; no connector secrets |

History status: GitHub `main` was rewritten and is clean, **but the old commit is still retrievable by SHA**
(verified 2026-10-30), and clones made before the rewrite still contain it. Removing a secret from history does
not make it safe; only rotation does.

## Checklist

| # | Step | How | Done |
|---|---|---|---|
| 1 | Revoke and replace the **Telegram bot token** | @BotFather → `/mybots` → bot → API Token → Revoke; put the new token in local `.env` and Render `TELEGRAM_BOT_TOKEN`; restart; send `/status` in the group | ☐ |
| 2 | Delete and replace the **Gemini API key** | Google AI Studio → API keys → delete the exposed key; create a new one (restrict to the Generative Language API); local `.env` + Render `GEMINI_API_KEY`; restart; run one agent task | ☐ |
| 3 | Change the **admin password** | in the app: Account → change password (the `ADMIN_PASSWORD` env var is only read on an empty database). If the same password was used anywhere else, change it there too | ☐ |
| 4 | **Reset the other account's password** in the leaked DB (and on production if it exists there) | People → user → reset password; tell the person through a separate channel | ☐ |
| 5 | **End all sessions** | after steps 3–4 (password changes end the user's other sessions); for a full sweep the owner runs `DELETE FROM sessions;` on each database (everyone signs in again) | ☐ |
| 6 | Review the **Telegram group** | members and admins; the leaked records show who used the bot | ☐ |
| 7 | **GitHub** | Support request to purge cached views / dangling objects of the rewritten history (`d3605b2`); review collaborators, deploy keys, Actions secrets, recent clones | ☐ |
| 8 | **Every clone** | each working copy follows the git synchronisation procedure in the W0 plan; no pushes from clones with the old history | ☐ (this computer: done) |
| 9 | **Render** | update env vars; confirm `render.yaml` holds no values (it uses `sync: false`); redeploy | ☐ |
| 10 | Not yet in use — set fresh values only in env when needed | `SECRETS_KEY`, `GOOGLE_CLIENT_ID/SECRET`, `SLACK_BOT_TOKEN`, `NOTION_TOKEN`, `BACKUP_KEY` | — |

## Verification after rotation

- The old Telegram token returns 401 from `getMe`; the bot answers with the new one.
- An agent task completes with the new Gemini key; the old key is gone from AI Studio.
- Signing in with the old admin password fails.
- `scripts/scan-secrets.mjs` (W0.1) finds nothing in the tree and staged changes.

Record the date of each step in the "Done" column and in the W0 report.
