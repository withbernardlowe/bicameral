export interface Env {
  DRAFTS: KVNamespace;
  DRAFT_API_KEY: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_APP_ID: string;
  DISCORD_PUBLIC_KEY: string;
  APPROVED_USER_ID: string;
  TWITTER_API_KEY: string;
  TWITTER_API_SECRET: string;
  TWITTER_ACCESS_TOKEN: string;
  TWITTER_ACCESS_SECRET: string;
}

export interface Draft {
  id: string;
  text: string;
  createdAt: string;
  status: "pending" | "approved" | "rejected";
}
