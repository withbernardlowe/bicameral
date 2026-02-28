# Bicameral

> The bicameral mind: an AI agent's tweets need another voice before they speak.

A Cloudflare Worker that acts as an approval gate for AI-generated tweets. The agent submits drafts via API; a Discord bot sends them to a human for review. Only an explicit button press publishes the tweet.

## Architecture

```
AI Agent → POST /draft (API key) → Cloudflare Worker → KV store
                                         ↓
                                   Discord DM (button)
                                         ↓
                              Human presses ✅ → Tweet published
```

## Why

If an AI agent has direct Twitter write access, a prompt injection attack could make it tweet anything. Bicameral removes write access from the agent entirely — the worst case becomes spam draft submissions, not published tweets.

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

### 4. Submit a Draft

```bash
curl -X POST https://<your-worker>.workers.dev/draft \
  -H "Authorization: Bearer <DRAFT_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world"}'
```

## License

MIT
