export async function validateDiscord(token: string) {
  const response = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bot ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw new Error(
      `Discord rejected the bot token (HTTP ${response.status}).`,
    );
  const user = (await response.json()) as { bot?: boolean; username?: string };
  if (!user.bot) throw new Error("Provide a Discord bot token.");
  return user.username ?? "Discord bot";
}

/**
 * Check a Projects token: user-owned Projects v2 boards accept only a classic personal access
 * token with the `project` scope (fine-grained tokens and GitHub Apps cannot reach them).
 */
export async function validateProjects(token: string) {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `bearer ${token}`,
      "user-agent": "ry-issue-bridge",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw new Error(`GitHub rejected the token (HTTP ${response.status}).`);
  const scopes = response.headers.get("x-oauth-scopes");
  if (scopes === null)
    throw new Error(
      "Use a classic personal access token: fine-grained tokens cannot reach user-owned projects.",
    );
  const list = scopes.split(",").map((s) => s.trim());
  if (!list.includes("project"))
    throw new Error(
      "The token needs the project scope (read:project cannot set Status).",
    );
  const user = (await response.json()) as { login?: string };
  return { login: user.login ?? "unknown", scopes: list };
}
