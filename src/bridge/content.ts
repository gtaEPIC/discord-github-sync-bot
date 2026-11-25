import { createHash } from "node:crypto";
import { Issue, IssueRef, Message, TimelineEvent } from "./types";

export const hash = (body: string) =>
  createHash("sha256").update(body).digest("hex");
export const issueMarker = (thread: string) =>
  `<!-- gd-sync:thread:${thread} -->`;
export const messageMarker = (id: string) => `<!-- gd-sync:message:${id} -->`;
export function sourceBody(message: Message) {
  const author = message.author.replace(/[\[\]<>\r\n]/g, "");
  // Remove reserved markers supplied in user content so only our generated marker is authoritative.
  const body = message.body.replace(/<!--\s*gd-sync:[\s\S]*?-->/g, "");
  return `**[${author}](${message.url})** on Discord\n\n${body || "_(No text)_"}`;
}
export function issueSummary(issue: Issue) {
  const body = issue.body.replace(/<!--\s*gd-sync:[\s\S]*?-->/g, "").trim();
  return `**[${issue.state === "closed" ? "Closed" : "Open"} · #${issue.number}](${issue.url})** — ${issue.author}\n\n${body || "_(No description)_"}\n\nLabels: ${issue.labels.join(", ") || "none"}`;
}
/** Split by UTF-16 length (Discord's limit), retaining the source URL in every part. */
export function chunks(body: string, url: string): string[] {
  const parts: string[] = [];
  let remaining = body;
  do {
    let end = Math.min(1700, remaining.length);
    if (end < remaining.length && /[\uD800-\uDBFF]/.test(remaining[end - 1]))
      end--;
    parts.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  } while (remaining.length);
  return parts.map(
    (part, i) => `${part}\n\n↪ ${url} · part ${i + 1}/${parts.length}`,
  );
}
export function missing(error: unknown): boolean {
  const e = error as { status?: number; code?: number };
  return e.status === 404 || e.code === 10003 || e.code === 10008;
}

/** One bot-owned message per event. Text comes from GitHub; mentions are disabled on send. */
export function timelineBody(event: TimelineEvent) {
  const clean = (text: string) =>
    text
      .replace(/[\[\]\r\n*_`~|]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const bold = (text?: string | null) => `**${clean(text ?? "") || "none"}**`;
  const actor = event.actor?.replace(/\[bot\]$/, "");
  const by = actor ? ` by ${bold(actor)}` : "";
  const ref = (r: IssueRef) =>
    `[${r.label}](${r.url})${r.title ? ` ${clean(r.title)}` : ""}`;
  const commit = `commit [\`${event.label}\`](${event.url})`;
  switch (event.kind) {
    case "crossref":
      return `Mentioned in ${event.pullRequest ? "pull request" : "issue"} ${ref({ label: event.label ?? "", url: event.url, title: event.title })}${by}`;
    case "commit":
      return `Referenced in ${commit}${by}`;
    case "closed": {
      const reason =
        event.reason === "not_planned"
          ? " as not planned"
          : event.reason === "duplicate"
            ? ` as a duplicate${event.duplicateOf ? ` of ${ref(event.duplicateOf)}` : ""}`
            : event.reason === "completed"
              ? " as completed"
              : "";
      return `Closed${reason}${event.label ? ` by ${commit}` : ""}${by}`;
    }
    case "reopened":
      return `Reopened${by}`;
    case "renamed":
      return `Renamed from ${bold(event.from)} to ${bold(event.to)}${by}`;
    case "labeled":
      return `Label ${bold(event.name)} added${by}`;
    case "unlabeled":
      return `Label ${bold(event.name)} removed${by}`;
    case "assigned":
      return `Assigned to ${bold(event.name)}${by}`;
    case "unassigned":
      return `${bold(event.name)} unassigned${by}`;
    case "milestoned":
      return `Added to milestone ${bold(event.name)}${by}`;
    case "demilestoned":
      return `Removed from milestone ${bold(event.name)}${by}`;
    case "locked":
      return `Conversation locked on GitHub${by}`;
    case "unlocked":
      return `Conversation unlocked on GitHub${by}`;
    case "duplicate":
      return event.duplicate
        ? `${ref(event.duplicate)} was marked as a duplicate of this issue${by}`
        : `Marked as a duplicate${event.duplicateOf ? ` of ${ref(event.duplicateOf)}` : ""}${by}`;
    case "status":
      return `Status moved from ${bold(event.from)} to ${bold(event.to)}${event.project ? ` on ${bold(event.project)}` : ""}${by}`;
  }
}

/** The parts of a Discord embed that carry text (discord.js `Embed` satisfies this). */
export interface EmbedLike {
  data?: { type?: string };
  title?: string | null;
  url?: string | null;
  description?: string | null;
  author?: { name: string; url?: string } | null;
  fields?: { name: string; value: string }[];
  footer?: { text: string } | null;
  image?: { url: string } | null;
  thumbnail?: { url: string } | null;
}

/**
 * Rich embeds (what webhooks and bots send) as quoted Markdown. Link previews Discord adds
 * to members' URLs are skipped: they repeat the URL and arrive later as an edit.
 */
export function embedMarkdown(embeds: EmbedLike[]): string {
  const label = (text: string) => text.replace(/[\[\]\r\n]/g, " ").trim();
  const web = (url?: string | null) =>
    url && /^https?:\/\//i.test(url) ? url : undefined;
  return embeds
    .filter((e) => !e.data?.type || e.data.type === "rich")
    .map((e) => {
      const blocks: string[] = [];
      if (e.author?.name)
        blocks.push(
          web(e.author.url)
            ? `_[${label(e.author.name)}](${e.author.url})_`
            : `_${e.author.name}_`,
        );
      if (e.title)
        blocks.push(
          web(e.url) ? `**[${label(e.title)}](${e.url})**` : `**${e.title}**`,
        );
      if (e.description) blocks.push(e.description);
      for (const field of e.fields ?? [])
        blocks.push(`**${field.name}**\n${field.value}`);
      for (const picture of [e.image, e.thumbnail])
        if (web(picture?.url)) blocks.push(`![image](${picture!.url})`);
      if (e.footer?.text) blocks.push(`_${e.footer.text}_`);
      return (
        blocks
          .join("\n\n")
          .split("\n")
          // A bare ">" shows as a literal ">" on Discord, so blank lines end the quote instead.
          .map((line) => (line.trim() ? `> ${line}` : ""))
          .join("\n")
      );
    })
    .filter((quote) => quote.length)
    .join("\n\n");
}
