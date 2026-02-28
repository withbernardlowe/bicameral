import { Env, Draft } from "./types";

const DISCORD_API = "https://discord.com/api/v10";

// Verify Discord interaction signature
export async function verifyDiscordSignature(
  request: Request,
  publicKey: string
): Promise<boolean> {
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp) return false;

  const body = await request.clone().text();
  const encoder = new TextEncoder();
  const message = encoder.encode(timestamp + body);

  const key = await crypto.subtle.importKey(
    "raw",
    hexToUint8Array(publicKey),
    { name: "Ed25519", namedCurve: "Ed25519" },
    false,
    ["verify"]
  );

  return crypto.subtle.verify("Ed25519", key, hexToUint8Array(signature), message);
}

// Send a DM with approve/reject buttons
export async function sendDraftDM(draft: Draft, env: Env): Promise<void> {
  // Get or create DM channel
  const dmChannel = await fetch(`${DISCORD_API}/users/@me/channels`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ recipient_id: env.APPROVED_USER_ID }),
  });

  if (!dmChannel.ok) {
    const err = await dmChannel.text();
    throw new Error(`Failed to create DM channel: ${err}`);
  }

  const { id: channelId } = (await dmChannel.json()) as { id: string };

  // Send message with buttons
  const message = {
    content: draft.replyToId
      ? `📝 **Reply Draft**\n\n↩️ https://x.com/i/status/${draft.replyToId}\n\n${draft.text}`
      : draft.quoteTweetId
      ? `📝 **Quote Tweet Draft**\n\n🔁 https://x.com/i/status/${draft.quoteTweetId}\n\n${draft.text}`
      : `📝 **New Tweet Draft**\n\n${draft.text}`,
    components: [
      {
        type: 1, // Action Row
        components: [
          {
            type: 2, // Button
            style: 3, // Success (green)
            label: "✅ Publish",
            custom_id: `approve:${draft.id}`,
          },
          {
            type: 2,
            style: 4, // Danger (red)
            label: "❌ Cancel",
            custom_id: `reject:${draft.id}`,
          },
        ],
      },
    ],
  };

  const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(message),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to send DM: ${err}`);
  }
}

// Discord interaction response helpers
export function interactionResponse(content: string, ephemeral = false) {
  return new Response(
    JSON.stringify({
      type: 4, // CHANNEL_MESSAGE_WITH_SOURCE
      data: {
        content,
        flags: ephemeral ? 64 : 0,
      },
    }),
    { headers: { "Content-Type": "application/json" } }
  );
}

export function deferResponse() {
  return new Response(
    JSON.stringify({ type: 5 }), // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
    { headers: { "Content-Type": "application/json" } }
  );
}

export function updateMessage(content: string) {
  return new Response(
    JSON.stringify({
      type: 7, // UPDATE_MESSAGE
      data: {
        content,
        components: [], // Remove buttons after action
      },
    }),
    { headers: { "Content-Type": "application/json" } }
  );
}

function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}
