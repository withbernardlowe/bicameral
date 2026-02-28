# Bicameral

> The bicameral mind: an AI agent's tweets need another voice before they speak.

A Cloudflare Worker that acts as an approval gate for AI agent actions on Twitter/X. The agent submits requests via API; a Discord bot sends them to a human for review. Only an explicit button press executes the action.

## Core Principle

**All outbound actions must go through human approval.** The agent cannot tweet, reply, quote, or follow directly. Every action is held pending until approved via Discord.

## Architecture

```
AI Agent → POST /draft or /follow (API key) → Cloudflare Worker → KV store
                                                     ↓
                                               Discord DM (button)
                                                     ↓
                                          Human presses ✅ → Action executed
```

## Why

If an AI agent has direct Twitter write access, a prompt injection attack could make it tweet anything. Bicameral removes write access from the agent entirely — the worst case becomes spam draft submissions, not published tweets.

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /draft | API key | Submit tweet draft (supports `reply_to`, `quote_tweet_id`) |
| GET | /drafts | API key | List recent 10 drafts + follows (30-day log) |
| POST | /follow | API key | Submit follow request |
| POST | /interactions | Discord signature | Discord button callback |
| GET | / | None | Health check |

## Security

- **API key**: All agent-facing endpoints require `Authorization: Bearer <key>`
- **Rate limiting**: 10 requests/min per IP (application-level, KV counters)
- **Discord signature**: `/interactions` verified via Ed25519
- **User allowlist**: Only `APPROVED_USER_ID` can press buttons
- **Logging**: All actions logged to KV (30-day TTL) on create + status change

## Adding New Features

When adding any new outbound action:
1. **Must go through approval** — Discord DM with approve/reject buttons
2. **Must have logging** — Write `log:` KV entries on create + status change (30d TTL)
3. **Must have rate limiting** — Add path to rate limit check
4. **Must require API key** — Bearer token auth

## Setup

### 1. Create a Discord Application

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application named **Bicameral**
3. Note the **Application ID** and **Public Key**
4. Create a bot, note the **Bot Token**
5. Set the Interactions Endpoint URL to `https://<your-worker>.workers.dev/interactions`

### 2. Deploy

```bash
npm install
wrangler deploy
```

### 3. Configure Secrets

```bash
wrangler secret put DRAFT_API_KEY
wrangler secret put DISCORD_BOT_TOKEN
wrangler secret put DISCORD_APP_ID
wrangler secret put DISCORD_PUBLIC_KEY
wrangler secret put APPROVED_USER_ID
wrangler secret put TWITTER_API_KEY
wrangler secret put TWITTER_API_SECRET
wrangler secret put TWITTER_ACCESS_TOKEN
wrangler secret put TWITTER_ACCESS_SECRET
```

### 4. Usage

```bash
# Submit a tweet draft
curl -X POST https://<your-worker>.workers.dev/draft \
  -H "Authorization: Bearer <DRAFT_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world"}'

# Submit a reply
curl -X POST https://<your-worker>.workers.dev/draft \
  -H "Authorization: Bearer <DRAFT_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"text": "Nice post!", "reply_to": "1234567890"}'

# Submit a quote tweet
curl -X POST https://<your-worker>.workers.dev/draft \
  -H "Authorization: Bearer <DRAFT_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"text": "Interesting", "quote_tweet_id": "1234567890"}'

# Follow a user
curl -X POST https://<your-worker>.workers.dev/follow \
  -H "Authorization: Bearer <DRAFT_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"username": "example"}'

# Check recent activity
curl https://<your-worker>.workers.dev/drafts \
  -H "Authorization: Bearer <DRAFT_API_KEY>"
```

## License

MIT
