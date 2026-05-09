# Telegram channel

Aiden v4.1 ships a Telegram bot adapter. Configure a token and Aiden will
listen on direct messages and reply with full agent answers (tools,
skills, memory — same loop as the REPL).

## Phase 2 scope (v4.1.0)

| Supported                              | Deferred to Phase 3          |
| -------------------------------------- | ---------------------------- |
| Direct messages                        | Voice notes                  |
| Group chats (mention-only by default)  | Webhooks                     |
| Per-user rate limit (5 msg / minute)   | Inline mode / callback queries |
| Admin commands (/pause, /resume, …)    | File and photo uploads       |
| Group allowlist (`TELEGRAM_ALLOWED_GROUPS`) |                          |
| Per-group memory isolation             |                              |
| Persistent group state                 |                              |
| Long-polling                           |                              |
| Markdown formatting                    |                              |
| 4 096-char chunked replies             |                              |

## Setup

### 1. Create a bot with @BotFather

1. Open Telegram and message [@BotFather](https://t.me/BotFather).
2. Send `/newbot` and follow the prompts (name, username).
3. Copy the **bot token** BotFather replies with — it looks like
   `123456789:ABCdef-GHIjkl_MNOpqr-stUVwxYZ012345`.

### 2. Set the environment variable

Add the token to your shell environment or to Aiden's `.env` file
(`%LOCALAPPDATA%\aiden\.env` on Windows, `~/.aiden/.env` elsewhere):

```bash
TELEGRAM_BOT_TOKEN=123456789:ABCdef-GHIjkl_MNOpqr-stUVwxYZ012345
```

Optionally, restrict who can talk to the bot by listing the chat IDs:

```bash
TELEGRAM_ALLOWED_CHATS=12345678,87654321
```

When `TELEGRAM_ALLOWED_CHATS` is empty (the default), the bot answers
anyone who messages it. Find your chat ID by sending the bot any
message and checking `https://api.telegram.org/bot<TOKEN>/getUpdates`.

### 3. Start Aiden

```bash
aiden serve
```

You should see one of:

- `[Telegram] Connected as @your_bot_username` — token accepted, polling.
- `[Telegram] Disabled — set TELEGRAM_BOT_TOKEN to enable` — adapter
  inert. Double-check the env var made it into the running process.
- `[Telegram] getMe failed: ETELEGRAM: 401 Unauthorized` — token is
  wrong or revoked. Get a fresh one from BotFather.

### 4. Chat with the bot

Open Telegram, find your bot by its username, and send any message.
Aiden's REPL boot card will also show `channels: N configured (incl.
telegram)` once `TELEGRAM_BOT_TOKEN` is in the environment.

## In-chat commands

| Command       | DM                       | Group                       |
| ------------- | ------------------------ | --------------------------- |
| `/help`       | anyone                   | anyone                      |
| `/status`     | anyone                   | anyone                      |
| `/clear`      | anyone (own DM only)     | **admin only** — wipes group memory |
| `/pause`      | n/a                      | **admin only** — bot stops responding |
| `/resume`     | n/a                      | **admin only** — bot resumes |
| `/allowusers` | n/a                      | **admin only** — restrict who may chat (`/allowusers reset` clears) |
| anything      | sent to the agent loop   | sent to the agent loop only when the bot is @mentioned or replied to |

The bot publishes the user-facing commands via Telegram's
`setMyCommands` so they appear in the `/` autocomplete menu.

## Groups (Phase v4.1-2)

When you add the bot to a group, it stays quiet by default. To get a
reply, **@mention the bot** (`@your_bot_username summarise this thread`)
or **reply to one of its previous messages**. Every message in
the group routes to the agent only when one of those signals is present —
this prevents the bot from chiming in on every chatter and keeps your
API quota under control.

Knobs:

```bash
# Strict allowlist — when set, the bot ignores groups not on this list.
# Empty / unset = open mode (works in any group it is added to).
TELEGRAM_ALLOWED_GROUPS=-1001234567890,-1009876543210

# Flip groups to "respond to every message". Off by default.
TELEGRAM_GROUPS_RESPOND_ALL=true

# Per-user rate limit across DMs + all groups (default: 5 / minute).
TELEGRAM_USER_RATE_LIMIT=5
TELEGRAM_USER_RATE_WINDOW_MS=60000

# Admin user ids — used by /pause /resume /clear /allowusers.
# Owner is always whoever set TELEGRAM_OWNER_ID; this list adds more.
TELEGRAM_OWNER_ID=12345678
TELEGRAM_ADMIN_USERS=87654321,11223344

# Optional: trust Telegram-side group admins as bot admins.
# Default OFF — owner-only is the safest baseline.
TELEGRAM_TRUST_GROUP_ADMINS=true
```

### Manage from the CLI

```bash
/channel telegram allowlist list
/channel telegram allowlist add -1001234567890
/channel telegram allowlist remove -1001234567890

/channel telegram groups list      # observed groups + last-message timestamp
/channel telegram groups pause -1001234567890
/channel telegram groups resume -1001234567890
```

State persists at `<aidenRoot>/state/telegram-groups.json`.

## Per-chat / per-group memory

Each chat (DM or group) has an isolated session. The gateway keys
sessions on `(channel='telegram', channelId=<chat_id>)`, so two different
groups — or two different DMs — get independent memory and history.
`/clear` wipes only the calling chat (or, in a group, requires admin).

## Rate limits

- **Telegram side:** the bot library handles the documented 30 msg/sec
  global cap and 1 msg/sec/chat sustained limit.
- **Bot side (Phase v4.1-2):** a per-user sliding window (5 messages
  per 60 seconds, configurable). Above the limit, messages are silently
  dropped — spammers don't see the limit, which makes the bot less
  attractive to abuse.

The adapter classifies `429 Too Many Requests` and respects Telegram's
`retry_after` field (capped at 10 s so a runaway value cannot stall
the process).

## Per-chat memory

Each chat has an isolated session. The gateway keys sessions on
`(channel='telegram', channelId=<chat_id>)`, so two different users
messaging the same bot get independent memory and history. `/clear`
wipes only the calling chat.

## Rate limits

Telegram caps bots at roughly **30 messages per second across all
chats** and **1 message per second per chat** (sustained). The
adapter relies on `node-telegram-bot-api`'s built-in retry handling
plus an explicit second-attempt path for `429 Too Many Requests`
that respects Telegram's `retry_after` field (capped at 10 s so a
runaway value cannot stall the process). Long replies are chunked at
the 4 096-character message limit, preferring newline / space split
points over hard cuts.

## Voice notes (Phase v4.1-3)

The bot accepts inbound voice messages and audio files in DMs and
groups. Each clip is transcribed via the existing Whisper provider
chain (Groq → OpenAI → local Whisper.cpp), then the transcript is
smuggled into the user turn that hits the agent — the agent answers
the spoken question naturally rather than echoing the transcript
back as a separate message.

**UX behaviour:**

- **High confidence** (Whisper `avg_logprob` ≥ −0.5): silent. The
  agent answers the spoken question; no echo.
- **Low confidence** (`avg_logprob` < −0.5): the bot first sends
  `🎤 _heard:_ "<transcript>"` so you can see what it understood,
  then the agent answers.
- **Failure** (no provider, network error, hallucination): the
  agent sees `[The user sent a voice message but transcription
  failed: <reason>. Apologize briefly and ask them to type the
  message instead.]` and composes the apology in its own voice.
- **Voice + caption** (audio file with text): the agent receives
  both — `[transcript: "X"]\n\n<caption>` — on a single user turn.

**Gates** (run *before* the file is downloaded — saves bandwidth on
dropped messages):

1. Group allowlist — `TELEGRAM_ALLOWED_GROUPS`
2. Per-user rate-limit — same 5/min bucket as text
3. Group pause flag — `/pause` from an admin
4. Per-group user allowlist — `/allowusers`
5. Mention gate — caption with `@bot_username` or reply-to-bot
6. **Then** `getFile()` + transcribe

**Cache:**

- Files are written to `<aiden_root>/cache/audio/audio_<uuid>.<ext>`
  (`.ogg` for `msg.voice`, `.mp3` for `msg.audio`).
- A janitor runs once on adapter start: if the cache is over 500 MB,
  files older than 7 days are deleted. There is no background timer
  in v4.1-3 — restart aiden to re-run the sweep.

**Configuration (all optional):**

| Var | Default | Effect |
|---|---|---|
| `TELEGRAM_VOICE_ENABLED` | `true` | Set to `false` to refuse voice notes with a friendly reply. |
| `TELEGRAM_VOICE_CONFIDENCE_THRESHOLD` | `-0.5` | `avg_logprob` floor; below this the bot echoes before answering. |
| `TELEGRAM_VOICE_LANGUAGE` | unset (auto-detect) | BCP-47 hint, e.g. `hi` for Hindi. |

Re-uses your existing `GROQ_API_KEY` / `OPENAI_API_KEY` /
`WHISPER_MODEL_PATH` from the provider chain — no new credentials
required to enable voice.

**Slash commands:**

- `/channel telegram voice status` — shows enabled flag, confidence
  threshold, language, cache footprint, and per-session counters.
- `/channel telegram voice enable` — flips
  `TELEGRAM_VOICE_ENABLED=true` in `.env` (atomic write).
- `/channel telegram voice disable` — flips it to `false`.

**Limits:**

- 25 MB cap (matches both Telegram's getFile attachment ceiling and
  OpenAI's Whisper API request limit). Larger files get a friendly
  reject without spending Whisper quota.
- Whisper hallucination guard catches the well-known noise outputs
  ("Thank you for watching", "Subtitles by Amara.org", etc.) and
  treats them as failures so the agent can apologize rather than
  proceed on garbage.

## Photos (Phase v4.1-4)

The bot accepts inbound photos in DMs and groups. Photo routing is
**model-aware**:

- **Vision-capable model active** (model carries `supportsVision:
  true` in `providers/v4/modelCatalog.ts`) — the local cache path is
  smuggled into the user turn with a directive telling the agent
  loop to attach the pixels on the request. The model "sees" the
  photo directly.
- **Text-only model** (or model lookup fails) — the bot pre-analyzes
  the image via the auxiliary vision chain (Anthropic claude-3-5-
  sonnet → OpenAI gpt-4o → Ollama llava) and prepends a description
  annotation:

  ```
  [The user sent a photo. Description: <auxiliary description>]

  <optional caption>
  ```

The agent then composes the user-facing reply naturally — same
"smuggle into agent turn" pattern as voice transcripts.

**Limits:**

- 25 MB cap (matches photo size limit on the receiving side; the
  auxiliary vision providers also reject larger images).
- Multiple photos in one Telegram message arrive as separate inbound
  events in v4.1-4 — each is handled independently. Multi-photo
  batching is parked for a later sub-phase.

## Documents (Phase v4.1-4)

Supported types: `pdf`, `png`, `jpg`, `jpeg`, `gif`, `webp`.

- **PDF** — text is extracted locally via `pdf-parse`, truncated to
  fit the active model's context window (50K char ceiling, with
  8K tokens reserved for the response), and smuggled into the
  user turn:

  ```
  [The user sent a PDF "<filename>". Extracted text:
  <truncated content>
  Note: PDF truncated to fit context. Original was N chars.]

  <optional caption>
  ```

- **Image-as-document** (PNG/JPG/GIF/WEBP sent as a file rather
  than via Telegram's photo flow) — routed through the same photo
  pipeline as `msg.photo`. Native vs. text mode decided per-model.

- **Anything else** — friendly reject reply listing supported types.

**Limits:**

- 20 MB cap for PDFs (Telegram's documented Bot API getFile limit).
- 25 MB cap for image-as-document.
- Cache lives at `<aiden_root>/cache/documents/doc_<uuid12>_<sanitized_filename>`.
  The original filename is preserved in the cache + agent annotation
  so replies can reference it.
- Scanned-image-only PDFs (no text layer) currently produce an empty
  extraction and the agent receives a directive annotation asking
  the user to retry or paste the text.

## Media slash commands

- `/channel telegram media status` — voice + photo + document
  caches, supported types, per-session counters.
- `/channel telegram media enable` — flips
  `TELEGRAM_MEDIA_ENABLED=true` in `.env` (atomic write). Default is
  `true`, so this only matters after explicit `disable`.
- `/channel telegram media disable` — flips it to `false`. Inbound
  photos + documents get the friendly reject reply. **Voice retains
  its own `/channel telegram voice` toggle** so operators can disable
  one without the other.

## Troubleshooting

**Bot doesn't reply.** Check the API server log for `[Telegram]
Connected as @...`. If you only see `[Telegram] Disabled`, the env
var is not in the running process — start Aiden from the same shell
where you set the variable, or write it to `.env`.

**`Polling error` lines in the log.** Telegram occasionally returns
502/504 errors during maintenance windows. The adapter retries
internally; messages are not lost. Sustained polling errors usually
mean a network filter or proxy is blocking
`api.telegram.org`.

**`Webhook error` lines.** The adapter uses long polling, but a
stale webhook URL may still be registered against the bot from a
previous session. Run
`https://api.telegram.org/bot<TOKEN>/deleteWebhook` once to clear it.

**Group messages get a "groups aren't supported yet" reply.** That
is Phase 1 by design — Phase 2 unlocks groups.

**Token leaked to a log line.** It shouldn't — the adapter scrubs
the token from every error message before logging. If you see a
real token in a log, file an issue; it's a bug.

## Security notes

- The bot token is the credential for the bot account. Treat it like
  a password — anyone with it can impersonate your bot.
- Aiden never logs the token. It's also redacted from every error
  message the adapter emits.
- For shared Telegram bots, set `TELEGRAM_ALLOWED_CHATS` to a
  comma-separated list of chat IDs you trust. Unauthorized chats get
  a one-line refusal and never reach the agent loop.
