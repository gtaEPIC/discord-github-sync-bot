/**
 * Per-mapping bridge settings (stored as `Mapping.bridge`). Every field is optional in
 * storage; `resolveConfig` fills defaults so a mapping without settings behaves exactly
 * like upstream (`writeMode: "user"`). Later phases add fields here; unknown keys are
 * rejected so typos fail loudly instead of being ignored.
 */
export type WriteMode = "user" | "bridge";
/** GitHub `state_reason` values a forum tag can close an issue with. */
export type CloseReason = "completed" | "not_planned" | "duplicate";
export const CLOSE_REASONS: CloseReason[] = [
  "completed",
  "not_planned",
  "duplicate",
];

export interface BridgeConfig {
  /** `user`: each Discord author must link GitHub (upstream). `bridge`: the GitHub App bot writes with Discord attribution. */
  writeMode: WriteMode;
  /** Bridge mode only: Discord role IDs allowed to write to GitHub. Empty means anyone who can post in the forum. */
  allowRoles: string[];
  /** Bridge mode only: per-Discord-user limits on new issues and new comments, per rolling hour. 0 disables a limit. */
  rateLimit: { issuesPerHour: number; commentsPerHour: number };
  /**
   * Forum tag name -> repository label name, for tags whose names differ from their labels
   * (for example "Bug" -> "bug" is already matched case-insensitively). Tags with no matching
   * label are left alone.
   */
  labels: Record<string, string>;
  /**
   * Forum tags that mean "closed", each with the GitHub close reason it stands for. Applying
   * one closes the issue (bridge mode); removing every close tag reopens it. The first tag is
   * shown when GitHub's reason has no tag of its own. Make these tags moderated in Discord.
   */
  closeTags: { tag: string; reason: CloseReason }[];
  /** Projects v2 Status sync. Off when absent; needs the Projects token (Admin -> Connections). */
  status?: StatusConfig;
}

export interface StatusConfig {
  /** GitHub login that owns the (user-level) project. */
  owner: string;
  /** Project number, from its URL. */
  number: number;
  /** Single-select field to sync. */
  field: string;
  /** Forum tag name -> option name. Leave "Done" out: the close tag stands for it. */
  tags: Record<string, string>;
  /** Option for open issues that are not on the board yet; absent = they are not added. */
  defaultOption?: string;
  /** How often the board is read, in seconds. */
  pollSeconds: number;
}

export const DEFAULT_CONFIG: BridgeConfig = Object.freeze({
  writeMode: "user",
  allowRoles: [],
  rateLimit: Object.freeze({ issuesPerHour: 5, commentsPerHour: 60 }),
  labels: Object.freeze({}),
  closeTags: [],
}) as BridgeConfig;

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid bridge settings: ${problems.join(" ")}`);
    this.name = "ConfigError";
  }
}

const KEYS = [
  "writeMode",
  "allowRoles",
  "rateLimit",
  "labels",
  "closeTags",
  "status",
];
const STATUS_KEYS = [
  "owner",
  "number",
  "field",
  "tags",
  "defaultOption",
  "pollSeconds",
];
const text = (value: unknown, max: number) =>
  typeof value === "string" && value.trim() !== "" && value.length <= max;
const RATE_KEYS = ["issuesPerHour", "commentsPerHour"];
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Validate stored or submitted settings. Returns only the keys that were given (defaults are not persisted). */
export function parseBridgeConfig(value: unknown): Partial<BridgeConfig> {
  if (value === undefined || value === null) return {};
  if (!isObject(value))
    throw new ConfigError(["Settings must be a JSON object."]);
  const problems: string[] = [];
  const result: Partial<BridgeConfig> = {};
  for (const key of Object.keys(value))
    if (!KEYS.includes(key)) problems.push(`Unknown setting "${key}".`);
  if (value.writeMode !== undefined) {
    if (value.writeMode === "user" || value.writeMode === "bridge")
      result.writeMode = value.writeMode;
    else problems.push('writeMode must be "user" or "bridge".');
  }
  if (value.allowRoles !== undefined) {
    if (
      Array.isArray(value.allowRoles) &&
      value.allowRoles.length <= 50 &&
      value.allowRoles.every(
        (id) => typeof id === "string" && /^\d{5,25}$/.test(id),
      )
    )
      result.allowRoles = [...new Set(value.allowRoles as string[])];
    else
      problems.push(
        "allowRoles must be a list of up to 50 Discord role IDs (strings of digits).",
      );
  }
  if (value.rateLimit !== undefined) {
    if (!isObject(value.rateLimit))
      problems.push("rateLimit must be an object.");
    else {
      const rate: Record<string, number> = {};
      for (const key of Object.keys(value.rateLimit))
        if (!RATE_KEYS.includes(key))
          problems.push(`Unknown setting "rateLimit.${key}".`);
      for (const key of RATE_KEYS) {
        const n = value.rateLimit[key];
        if (n === undefined) continue;
        if (
          Number.isInteger(n) &&
          (n as number) >= 0 &&
          (n as number) <= 10_000
        )
          rate[key] = n as number;
        else
          problems.push(
            `rateLimit.${key} must be a whole number from 0 to 10000.`,
          );
      }
      result.rateLimit = rate as BridgeConfig["rateLimit"];
    }
  }
  if (value.labels !== undefined) {
    const entries = isObject(value.labels) ? Object.entries(value.labels) : [];
    if (
      !isObject(value.labels) ||
      entries.length > 20 ||
      entries.some(
        ([tag, label]) =>
          !tag.trim() ||
          tag.length > 20 ||
          typeof label !== "string" ||
          !label.trim() ||
          label.length > 50,
      )
    )
      problems.push(
        "labels must map up to 20 forum tag names (max 20 characters) to label names (max 50 characters).",
      );
    else result.labels = Object.fromEntries(entries) as Record<string, string>;
  }
  if (value.closeTags !== undefined) {
    const list = value.closeTags;
    const names = Array.isArray(list)
      ? list.map((t) =>
          isObject(t) && typeof t.tag === "string"
            ? t.tag.trim().toLowerCase()
            : "",
        )
      : [];
    if (
      !Array.isArray(list) ||
      list.length > 10 ||
      list.some(
        (t) =>
          !isObject(t) ||
          Object.keys(t).some((k) => k !== "tag" && k !== "reason") ||
          typeof t.tag !== "string" ||
          !t.tag.trim() ||
          t.tag.length > 20 ||
          !CLOSE_REASONS.includes(t.reason as CloseReason),
      )
    )
      problems.push(
        `closeTags must be a list of up to 10 { "tag": forum tag name (max 20 characters), "reason": ${CLOSE_REASONS.map((r) => `"${r}"`).join(" | ")} }.`,
      );
    else if (new Set(names).size !== names.length)
      problems.push("closeTags lists the same tag twice.");
    else
      result.closeTags = (list as { tag: string; reason: CloseReason }[]).map(
        ({ tag, reason }) => ({ tag, reason }),
      );
  }
  if (value.status !== undefined) {
    const status = value.status;
    if (!isObject(status)) problems.push("status must be an object.");
    else {
      const before = problems.length;
      for (const key of Object.keys(status))
        if (!STATUS_KEYS.includes(key))
          problems.push(`Unknown setting "status.${key}".`);
      if (
        typeof status.owner !== "string" ||
        !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(status.owner)
      )
        problems.push("status.owner must be a GitHub user login.");
      if (!Number.isInteger(status.number) || (status.number as number) < 1)
        problems.push("status.number must be the project number.");
      if (status.field !== undefined && !text(status.field, 100))
        problems.push("status.field must be a field name.");
      const tags = isObject(status.tags) ? Object.entries(status.tags) : [];
      if (
        !isObject(status.tags) ||
        !tags.length ||
        tags.length > 20 ||
        tags.some(([tag, option]) => !text(tag, 20) || !text(option, 100))
      )
        problems.push(
          "status.tags must map 1 to 20 forum tag names (max 20 characters) to Status option names.",
        );
      else {
        const close = new Set(
          (result.closeTags ?? []).map((t) => t.tag.trim().toLowerCase()),
        );
        const names = tags.map(([tag]) => tag.trim().toLowerCase());
        if (names.some((n) => close.has(n)))
          problems.push("A tag cannot be both a close tag and a status tag.");
        if (new Set(names).size !== names.length)
          problems.push("status.tags lists the same tag twice.");
      }
      if (
        status.defaultOption !== undefined &&
        !text(status.defaultOption, 100)
      )
        problems.push("status.defaultOption must be an option name.");
      if (
        status.pollSeconds !== undefined &&
        (!Number.isInteger(status.pollSeconds) ||
          (status.pollSeconds as number) < 60 ||
          (status.pollSeconds as number) > 3600)
      )
        problems.push("status.pollSeconds must be from 60 to 3600.");
      if (problems.length === before)
        result.status = {
          owner: status.owner as string,
          number: status.number as number,
          ...(status.field !== undefined && { field: status.field as string }),
          tags: Object.fromEntries(tags) as Record<string, string>,
          ...(status.defaultOption !== undefined && {
            defaultOption: status.defaultOption as string,
          }),
          ...(status.pollSeconds !== undefined && {
            pollSeconds: status.pollSeconds as number,
          }),
        } as StatusConfig;
    }
  }
  if (problems.length) throw new ConfigError(problems);
  return result;
}

/** Settings with defaults applied. Invalid stored settings fall back to defaults field by field, never to bridge mode. */
export function resolveConfig(stored: unknown): BridgeConfig {
  let parsed: Partial<BridgeConfig>;
  try {
    parsed = parseBridgeConfig(stored);
  } catch {
    parsed = {};
  }
  return {
    writeMode: parsed.writeMode ?? DEFAULT_CONFIG.writeMode,
    allowRoles: parsed.allowRoles ?? [],
    rateLimit: { ...DEFAULT_CONFIG.rateLimit, ...parsed.rateLimit },
    labels: parsed.labels ?? {},
    closeTags: parsed.closeTags ?? [],
    status: parsed.status && {
      ...parsed.status,
      field: parsed.status.field ?? "Status",
      pollSeconds: parsed.status.pollSeconds ?? 120,
    },
  };
}
