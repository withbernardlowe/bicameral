import { Env } from "./types";

// OAuth 1.0a signature for Twitter API v2
export async function postTweet(text: string, env: Env, replyToId?: string, quoteTweetId?: string): Promise<{ id: string; text: string }> {
  const url = "https://api.twitter.com/2/tweets";
  const method = "POST";
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID().replace(/-/g, "");

  const params: Record<string, string> = {
    oauth_consumer_key: env.TWITTER_API_KEY,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: env.TWITTER_ACCESS_TOKEN,
    oauth_version: "1.0",
  };

  // Create signature base string (no body params for JSON POST)
  const paramString = Object.keys(params)
    .sort()
    .map((k) => `${encodeRFC3986(k)}=${encodeRFC3986(params[k])}`)
    .join("&");

  const baseString = `${method}&${encodeRFC3986(url)}&${encodeRFC3986(paramString)}`;
  const signingKey = `${encodeRFC3986(env.TWITTER_API_SECRET)}&${encodeRFC3986(env.TWITTER_ACCESS_SECRET)}`;

  const signature = await hmacSha1(signingKey, baseString);
  params.oauth_signature = signature;

  const authHeader =
    "OAuth " +
    Object.keys(params)
      .sort()
      .map((k) => `${encodeRFC3986(k)}="${encodeRFC3986(params[k])}"`)
      .join(", ");

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      ...(replyToId ? { reply: { in_reply_to_tweet_id: replyToId } } : {}),
      ...(quoteTweetId ? { quote_tweet_id: quoteTweetId } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Twitter API error ${res.status}: ${body}`);
  }

  const json = (await res.json()) as { data: { id: string; text: string } };
  return json.data;
}

export async function lookupUser(username: string, env: Env): Promise<string> {
  const url = `https://api.twitter.com/2/users/by/username/${username}`;
  const res = await oauthFetch("GET", url, env);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Lookup failed ${res.status}: ${body}`);
  }
  const json = (await res.json()) as { data: { id: string } };
  return json.data.id;
}

export async function getMyId(env: Env): Promise<string> {
  const url = "https://api.twitter.com/2/users/me";
  const res = await oauthFetch("GET", url, env);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Get me failed ${res.status}: ${body}`);
  }
  const json = (await res.json()) as { data: { id: string } };
  return json.data.id;
}

export async function followUser(myId: string, targetId: string, env: Env): Promise<{ following: boolean; pending: boolean }> {
  const url = `https://api.twitter.com/2/users/${myId}/following`;
  const res = await oauthFetch("POST", url, env, { target_user_id: targetId });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Follow failed ${res.status}: ${body}`);
  }
  const json = (await res.json()) as { data: { following: boolean; pending_follow: boolean } };
  return { following: json.data.following, pending: json.data.pending_follow };
}

export async function unfollowUser(myId: string, targetId: string, env: Env): Promise<{ following: boolean }> {
  const url = `https://api.twitter.com/2/users/${myId}/following/${targetId}`;
  const res = await oauthFetch("DELETE", url, env);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Unfollow failed ${res.status}: ${body}`);
  }
  const json = (await res.json()) as { data: { following: boolean } };
  return { following: json.data.following };
}

export async function getFollowing(myId: string, env: Env): Promise<Array<{ id: string; username: string; name: string }>> {
  const results: Array<{ id: string; username: string; name: string }> = [];
  let nextToken: string | undefined;

  do {
    const url = `https://api.twitter.com/2/users/${myId}/following?max_results=100${nextToken ? `&pagination_token=${nextToken}` : ""}`;
    const res = await oauthFetch("GET", url, env);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Get following failed ${res.status}: ${body}`);
    }
    const json = (await res.json()) as {
      data?: Array<{ id: string; username: string; name: string }>;
      meta?: { next_token?: string };
    };
    if (json.data) {
      results.push(...json.data);
    }
    nextToken = json.meta?.next_token;
  } while (nextToken);

  return results;
}

async function oauthFetch(method: string, url: string, env: Env, body?: Record<string, string>): Promise<Response> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID().replace(/-/g, "");

  const params: Record<string, string> = {
    oauth_consumer_key: env.TWITTER_API_KEY,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: env.TWITTER_ACCESS_TOKEN,
    oauth_version: "1.0",
  };

  const paramString = Object.keys(params)
    .sort()
    .map((k) => `${encodeRFC3986(k)}=${encodeRFC3986(params[k])}`)
    .join("&");

  const baseString = `${method}&${encodeRFC3986(url)}&${encodeRFC3986(paramString)}`;
  const signingKey = `${encodeRFC3986(env.TWITTER_API_SECRET)}&${encodeRFC3986(env.TWITTER_ACCESS_SECRET)}`;

  const signature = await hmacSha1(signingKey, baseString);
  params.oauth_signature = signature;

  const authHeader =
    "OAuth " +
    Object.keys(params)
      .sort()
      .map((k) => `${encodeRFC3986(k)}="${encodeRFC3986(params[k])}"`)
      .join(", ");

  const headers: Record<string, string> = { Authorization: authHeader };
  if (body) headers["Content-Type"] = "application/json";

  return fetch(url, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function encodeRFC3986(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function hmacSha1(key: string, data: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}
