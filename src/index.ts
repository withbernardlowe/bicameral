import { Env, Draft, FollowRequest } from "./types";
import { verifyDiscordSignature, sendDraftDM, sendFollowDM, interactionResponse, updateMessage } from "./discord";
import { postTweet, followUser, getMyId, lookupUser } from "./twitter";

const RATE_LIMIT = 10; // max requests per window
const RATE_WINDOW = 60; // window in seconds

async function checkRateLimit(ip: string, env: Env): Promise<boolean> {
  const key = `rate:${ip}`;
  const raw = await env.DRAFTS.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= RATE_LIMIT) return false;
  await env.DRAFTS.put(key, (count + 1).toString(), { expirationTtl: RATE_WINDOW });
  return true;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Rate limit API endpoints (not /interactions which has Discord signature verification)
    if (url.pathname === "/draft" || url.pathname === "/drafts" || url.pathname === "/follow") {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const allowed = await checkRateLimit(ip, env);
      if (!allowed) {
        return new Response("Too many requests", { status: 429 });
      }
    }

    // POST /draft — Bernard submits a draft tweet
    if (url.pathname === "/draft" && request.method === "POST") {
      return handleDraft(request, env);
    }

    // POST /interactions — Discord interaction webhook
    if (url.pathname === "/interactions" && request.method === "POST") {
      return handleInteraction(request, env);
    }

    // GET /drafts — List recent drafts
    if (url.pathname === "/drafts" && request.method === "GET") {
      return handleListDrafts(request, env);
    }

    // POST /follow — Follow a user
    if (url.pathname === "/follow" && request.method === "POST") {
      return handleFollow(request, env);
    }

    // Health check
    if (url.pathname === "/" && request.method === "GET") {
      return new Response("bicameral is listening", { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  },
};

async function handleDraft(request: Request, env: Env): Promise<Response> {
  // Verify API key
  const auth = request.headers.get("Authorization");
  if (auth !== `Bearer ${env.DRAFT_API_KEY}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Parse body
  let body: { text?: string; reply_to?: string; quote_tweet_id?: string };
  try {
    body = (await request.json()) as { text?: string; reply_to?: string; quote_tweet_id?: string };
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (!body.text || body.text.trim().length === 0) {
    return new Response("Missing 'text' field", { status: 400 });
  }

  if (body.text.length > 280) {
    return new Response("Tweet exceeds 280 characters", { status: 400 });
  }

  // Create draft
  const draft: Draft = {
    id: crypto.randomUUID(),
    text: body.text.trim(),
    createdAt: new Date().toISOString(),
    status: "pending",
    ...(body.reply_to ? { replyToId: body.reply_to } : {}),
    ...(body.quote_tweet_id ? { quoteTweetId: body.quote_tweet_id } : {}),
  };

  // Store in KV (TTL 24h)
  await env.DRAFTS.put(`draft:${draft.id}`, JSON.stringify(draft), {
    expirationTtl: 86400,
  });

  // Write to log (30-day TTL)
  await env.DRAFTS.put(`log:${draft.id}`, JSON.stringify(draft), {
    expirationTtl: 2592000,
  });

  // Send DM to Yuren
  try {
    await sendDraftDM(draft, env);
  } catch (err) {
    // Clean up KV if DM fails
    await env.DRAFTS.delete(`draft:${draft.id}`);
    await env.DRAFTS.delete(`log:${draft.id}`);
    return new Response(`Failed to send DM: ${(err as Error).message}`, { status: 502 });
  }

  return Response.json({ id: draft.id, status: "pending" }, { status: 201 });
}

async function handleFollow(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get("Authorization");
  if (auth !== `Bearer ${env.DRAFT_API_KEY}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body: { username?: string };
  try {
    body = (await request.json()) as { username?: string };
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (!body.username) {
    return new Response("Missing 'username' field", { status: 400 });
  }

  const username = body.username.replace(/^@/, "");

  // Lookup user ID first
  let targetId: string;
  try {
    targetId = await lookupUser(username, env);
  } catch (err) {
    return new Response(`User lookup failed: ${(err as Error).message}`, { status: 404 });
  }

  const followReq: FollowRequest = {
    id: crypto.randomUUID(),
    username,
    targetId,
    createdAt: new Date().toISOString(),
    status: "pending",
  };

  await env.DRAFTS.put(`follow:${followReq.id}`, JSON.stringify(followReq), {
    expirationTtl: 86400,
  });

  // Send DM for approval
  try {
    await sendFollowDM(followReq, env);
  } catch (err) {
    await env.DRAFTS.delete(`follow:${followReq.id}`);
    return new Response(`Failed to send DM: ${(err as Error).message}`, { status: 502 });
  }

  return Response.json({ id: followReq.id, status: "pending" }, { status: 201 });
}

async function handleListDrafts(request: Request, env: Env): Promise<Response> {
  // Verify API key
  const auth = request.headers.get("Authorization");
  if (auth !== `Bearer ${env.DRAFT_API_KEY}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  // List all log entries
  const keys = await env.DRAFTS.list({ prefix: "log:" });
  const drafts: Draft[] = [];

  for (const key of keys.keys) {
    const raw = await env.DRAFTS.get(key.name);
    if (raw) {
      drafts.push(JSON.parse(raw));
    }
  }

  // Sort by createdAt descending, take 10
  drafts.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const recent = drafts.slice(0, 10);

  return Response.json({ drafts: recent });
}

async function handleInteraction(request: Request, env: Env): Promise<Response> {
  // Verify signature
  const isValid = await verifyDiscordSignature(request, env.DISCORD_PUBLIC_KEY);
  if (!isValid) {
    return new Response("Invalid signature", { status: 401 });
  }

  const interaction = (await request.json()) as {
    type: number;
    data?: { custom_id?: string };
    member?: { user: { id: string } };
    user?: { id: string };
  };

  // Handle PING
  if (interaction.type === 1) {
    return new Response(JSON.stringify({ type: 1 }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Handle button click (type 3 = MESSAGE_COMPONENT)
  if (interaction.type === 3 && interaction.data?.custom_id) {
    const userId = interaction.user?.id || interaction.member?.user?.id;

    // Verify it's the approved user
    if (userId !== env.APPROVED_USER_ID) {
      return interactionResponse("⛔ Unauthorized", true);
    }

    const [action, kind, itemId] = interaction.data.custom_id.includes(":follow:")
      ? [interaction.data.custom_id.split(":")[0], "follow", interaction.data.custom_id.split(":")[2]]
      : [interaction.data.custom_id.split(":")[0], "draft", interaction.data.custom_id.split(":")[1]];

    // Handle follow requests
    if (kind === "follow") {
      const raw = await env.DRAFTS.get(`follow:${itemId}`);
      if (!raw) return updateMessage("⏰ Follow request expired or not found");
      const followReq: FollowRequest = JSON.parse(raw);
      if (followReq.status !== "pending") {
        return updateMessage(`⚠️ Already ${followReq.status === "approved" ? "approved" : "cancelled"}`);
      }
      if (action === "approve") {
        try {
          const myId = await getMyId(env);
          const result = await followUser(myId, followReq.targetId, env);
          followReq.status = "approved";
          await env.DRAFTS.put(`follow:${itemId}`, JSON.stringify(followReq), { expirationTtl: 86400 });
          const msg = result.pending
            ? `✓ Follow request sent to @${followReq.username} (pending their approval)`
            : `✅ Now following @${followReq.username}`;
          return updateMessage(msg);
        } catch (err) {
          return updateMessage(`❌ Follow failed: ${(err as Error).message}`);
        }
      }
      if (action === "reject") {
        followReq.status = "rejected";
        await env.DRAFTS.put(`follow:${itemId}`, JSON.stringify(followReq), { expirationTtl: 86400 });
        return updateMessage(`❌ Cancelled follow @${followReq.username}`);
      }
    }

    // Handle draft tweets
    const draftId = itemId;

    // Get draft from KV
    const raw = await env.DRAFTS.get(`draft:${draftId}`);
    if (!raw) {
      return updateMessage("⏰ Draft expired or not found");
    }

    const draft: Draft = JSON.parse(raw);

    if (draft.status !== "pending") {
      return updateMessage(`⚠️ Draft already ${draft.status === "approved" ? "published" : "cancelled"}`);
    }

    if (action === "approve") {
      try {
        const tweet = await postTweet(draft.text, env, draft.replyToId, draft.quoteTweetId);
        draft.status = "approved";
        const approvedDraft = { ...draft, tweetId: tweet.id };
        await env.DRAFTS.put(`draft:${draftId}`, JSON.stringify(approvedDraft), {
          expirationTtl: 86400,
        });
        await env.DRAFTS.put(`log:${draftId}`, JSON.stringify(approvedDraft), {
          expirationTtl: 2592000,
        });
        return updateMessage(
          `✅ Published!\n\n${draft.text}\n\nhttps://x.com/i/status/${tweet.id}`
        );
      } catch (err) {
        return updateMessage(`❌ Failed to post: ${(err as Error).message}`);
      }
    }

    if (action === "reject") {
      draft.status = "rejected";
      await env.DRAFTS.put(`draft:${draftId}`, JSON.stringify(draft), {
        expirationTtl: 86400,
      });
      await env.DRAFTS.put(`log:${draftId}`, JSON.stringify(draft), {
        expirationTtl: 2592000,
      });
      return updateMessage(`❌ Cancelled\n\n~~${draft.text}~~`);
    }
  }

  return new Response("Unknown interaction", { status: 400 });
}
