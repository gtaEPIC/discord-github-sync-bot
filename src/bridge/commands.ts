import { ChatInputCommandInteraction, PermissionFlagsBits } from "discord.js";
import { randomUUID } from "node:crypto";
import { Store } from "./database";
import { Platforms } from "./types";

export async function issueCommand(
  interaction: ChatInputCommandInteraction,
  store: Store,
  api: Pick<Platforms, "getIssue">,
  options: {
    forum: string;
    roles: string[];
    authorize?: (id: string) => Promise<boolean>;
  },
) {
  await interaction.deferReply({ ephemeral: true });
  const member = await interaction.guild!.members.fetch(interaction.user.id);
  const forum = await interaction.guild!.channels.fetch(options.forum);
  if (!forum?.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)) {
    await interaction.editReply("You do not have access to the issue forum.");
    return;
  }
  const manager = () =>
    Boolean(
      forum.permissionsFor(member)?.has(PermissionFlagsBits.ManageThreads),
    ) || options.roles.some((id) => member.roles.cache.has(id));
  if (interaction.options.getSubcommand() === "open") {
    // Create the issue for a post the bridge did not pick up (an old post, or a bot's).
    const channel = interaction.channel;
    if (!channel?.isThread() || channel.parentId !== options.forum) {
      await interaction.editReply(
        "Use /issue open inside a post in the issue forum.",
      );
      return;
    }
    if (!manager()) {
      await interaction.editReply(
        "Opening an issue for a post requires Manage Threads in the forum or a configured manager role.",
      );
      return;
    }
    const existing = store.thread(channel.id);
    if (existing) {
      await interaction.editReply(
        existing.disabled
          ? `This post was unlinked from #${existing.issue} and cannot be linked again.`
          : `This post is already linked to #${existing.issue}.`,
      );
      return;
    }
    store.enqueue(
      { type: "open", thread: channel.id, actor: interaction.user.id },
      randomUUID(),
    );
    await interaction.editReply(
      "Queued. The GitHub issue will be created and linked to this post shortly.",
    );
    return;
  }
  const number = interaction.options.getInteger("number");
  const link = number
    ? store.link(number)
    : store.thread(interaction.channelId);
  if (!link || link.disabled) {
    await interaction.editReply(
      "No linked issue. Use this inside a synced thread, or supply its issue number.",
    );
    return;
  }
  const action = interaction.options.getSubcommand();
  if (action === "status") {
    const issue = await api.getIssue(link.issue);
    await interaction.editReply(
      `#${issue.number}: ${issue.state}\n${issue.url}`,
    );
    return;
  }
  if (!["close", "reopen"].includes(action))
    throw new Error("Unknown issue command");
  if (!manager()) {
    await interaction.editReply(
      "Closing/reopening requires Manage Threads in the forum or a configured manager role.",
    );
    return;
  }
  if (options.authorize && !(await options.authorize(interaction.user.id))) {
    await interaction.editReply(
      "Run /github link and /github confirm before changing an issue on GitHub.",
    );
    return;
  }
  // Acknowledge success only after SQLite commits the authorized command.
  store.enqueue(
    {
      type: "state",
      actor: interaction.user.id,
      issue: link.issue,
      state: action === "close" ? "closed" : "open",
    },
    randomUUID(),
  );
  await interaction.editReply(
    `Queued ${action} for #${link.issue}. The thread summary will reflect the result.`,
  );
}
