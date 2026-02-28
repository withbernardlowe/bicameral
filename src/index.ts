import { Env, Draft } from "./types";
import { verifyDiscordSignature, sendDraftDM, interactionResponse, updateMessage } from "./discord";
import { postTweet } from "./twitter";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // POST /draft — Bernard submits a draft tweet
    if (url.pathname === "/draft" && request.method === "POST") {
      return handleDraft(request, env);
    }

    // POST /interactions — Discord interaction webhook
    if (url.pathname === "/interactions" && request.method === "POST") {
      return handleInteraction(request, env);
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
  let body: { text?: string };
  try {
    body = (await request.json()) as { text?: string };
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
  };

  // Store in KV (TTL 24h)
  await env.DRAFTS.put(`draft:${draft.id}`, JSON.stringify(draft), {
    expirationTtl: 86400,
  });

  // Send DM to Yuren
  try {
    await sendDraftDM(draft, env);
  } catch (err) {
    // Clean up KV if DM fails
    await env.DRAFTS.delete(`draft:${draft.id}`);
    return new Response(`Failed to send DM: ${(err as Error).message}`, { status: 502 });
  }

  return Response.json({ id: draft.id, status: "pending" }, { status: 201 });
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
      return interactionResponse("⛔ 你沒有權限操作", true);
    }

    const [action, draftId] = interaction.data.custom_id.split(":");

    // Get draft from KV
    const raw = await env.DRAFTS.get(`draft:${draftId}`);
    if (!raw) {
      return updateMessage("⏰ 這個草稿已過期或不存在");
    }

    const draft: Draft = JSON.parse(raw);

    if (draft.status !== "pending") {
      return updateMessage(`⚠️ 這個草稿已經${draft.status === "approved" ? "發布" : "取消"}了`);
    }

    if (action === "approve") {
      try {
        const tweet = await postTweet(draft.text, env);
        draft.status = "approved";
        await env.DRAFTS.put(`draft:${draftId}`, JSON.stringify(draft), {
          expirationTtl: 86400,
        });
        return updateMessage(
          `✅ 已發布！\n\n${draft.text}\n\nhttps://x.com/i/status/${tweet.id}`
        );
      } catch (err) {
        return updateMessage(`❌ 發推失敗：${(err as Error).message}`);
      }
    }

    if (action === "reject") {
      draft.status = "rejected";
      await env.DRAFTS.put(`draft:${draftId}`, JSON.stringify(draft), {
        expirationTtl: 86400,
      });
      return updateMessage(`❌ 已取消\n\n~~${draft.text}~~`);
    }
  }

  return new Response("Unknown interaction", { status: 400 });
}
