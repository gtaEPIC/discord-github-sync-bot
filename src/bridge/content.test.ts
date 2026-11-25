import { describe, expect, it } from "vitest";
import { embedMarkdown } from "./content";

describe("embed rendering", () => {
  it("renders a webhook bug report embed as quoted Markdown", () => {
    const report = {
      data: { type: "rich" },
      title: "Station signs",
      description: "The station name and some signs are floating in the air.",
      fields: [
        {
          name: "Occupied Blocks",
          value: "• B61 (player1)\n• MST-B250 (player2)",
        },
        {
          name: "Server Logs",
          value: "*Upload failed — service may be unavailable*",
        },
      ],
      footer: { text: "Report 42" },
    };
    expect(embedMarkdown([report])).toBe(
      [
        "> **Station signs**",
        ">",
        "> The station name and some signs are floating in the air.",
        ">",
        "> **Occupied Blocks**",
        "> • B61 (player1)",
        "> • MST-B250 (player2)",
        ">",
        "> **Server Logs**",
        "> *Upload failed — service may be unavailable*",
        ">",
        "> _Report 42_",
      ].join("\n"),
    );
  });
  it("links titles and authors, shows web images, and skips link previews", () => {
    const text = embedMarkdown([
      {
        title: "A [tricky] title",
        url: "https://example.com/report",
        author: { name: "Reporter", url: "https://example.com/u" },
        image: { url: "https://cdn.example.com/shot.png" },
        thumbnail: { url: "attachment://local.png" },
      },
      { data: { type: "link" }, title: "Preview of a pasted URL" },
      { data: { type: "rich" } },
    ]);
    expect(text).toContain("> _[Reporter](https://example.com/u)_");
    expect(text).toContain(
      "> **[A  tricky  title](https://example.com/report)**",
    );
    expect(text).toContain("> ![image](https://cdn.example.com/shot.png)");
    expect(text).not.toContain("attachment://");
    expect(text).not.toContain("Preview of a pasted URL");
    expect(embedMarkdown([])).toBe("");
  });
});
