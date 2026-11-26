import { describe, expect, it, vi } from "vitest";
import { WriteBlocked } from "./authorship";
import { ProjectsClient } from "./projects";

type Reply = {
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
};

/** A fake GraphQL endpoint: each handler gets the query and variables, in call order. */
function setup(
  handler: (query: string, variables: Record<string, unknown>) => Reply,
  token: string | undefined = "pat",
) {
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const { query, variables } = JSON.parse(init.body as string);
    calls.push({ query, variables });
    const reply = handler(query, variables);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: reply.headers,
    });
  });
  const client = new ProjectsClient({
    token: () => token,
    owner: "jas",
    number: 3,
    field: "Status",
    repo: { owner: "jas", repo: "app" },
    ttl: 60_000,
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
  return { client, calls, fetch };
}

const project = {
  data: {
    user: {
      projectV2: {
        id: "P1",
        field: {
          id: "F1",
          options: [
            { id: "o-backlog", name: "Backlog" },
            { id: "o-progress", name: "In Progress" },
          ],
        },
      },
    },
  },
};
const item = (id: string, number: number, repo: string, status?: string) => ({
  id,
  content: { number, repository: { nameWithOwner: repo } },
  fieldValueByName: status ? { name: status } : null,
});

describe("Projects v2 client", () => {
  it("reads every page of the board and keeps only this repository's issues", async () => {
    const { client, calls } = setup((query, variables) => {
      if (query.includes("projectV2(number")) return { body: project };
      return {
        body: {
          data: {
            node: {
              items: variables.cursor
                ? {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [item("I3", 3, "jas/app", "Backlog")],
                  }
                : {
                    pageInfo: { hasNextPage: true, endCursor: "c1" },
                    nodes: [
                      item("I1", 1, "JAS/App", "In Progress"),
                      item("I2", 1, "jas/other", "Backlog"),
                      { id: "D1", content: null, fieldValueByName: null },
                    ],
                  },
            },
          },
        },
      };
    });
    const items = await client.scan();
    expect([...items]).toEqual([
      // Positions count every item on the board, including other repositories and drafts.
      [1, { id: "I1", status: "In Progress", position: 0 }],
      [3, { id: "I3", status: "Backlog", position: 3 }],
    ]);
    // Cached reads do not call GitHub again.
    expect(await client.item(1)).toEqual({
      id: "I1",
      status: "In Progress",
      position: 0,
    });
    expect(await client.item(2)).toBeNull();
    expect(calls).toHaveLength(3);
  });
  it("adds a missing issue before setting its Status, and clears a Status with null", async () => {
    let onBoard = false;
    const { client, calls } = setup((query) => {
      if (query.includes("projectV2(number")) return { body: project };
      if (query.includes("projectItems"))
        return {
          body: {
            data: {
              repository: {
                issue: {
                  id: "ISSUE",
                  projectItems: {
                    nodes: onBoard
                      ? [
                          {
                            id: "NEW",
                            project: { id: "P1" },
                            fieldValueByName: { name: "In Progress" },
                          },
                        ]
                      : [
                          {
                            id: "ELSEWHERE",
                            project: { id: "P9" },
                            fieldValueByName: null,
                          },
                        ],
                  },
                },
              },
            },
          },
        };
      if (query.includes("addProjectV2ItemById")) {
        onBoard = true;
        return {
          body: { data: { addProjectV2ItemById: { item: { id: "NEW" } } } },
        };
      }
      return { body: { data: { ok: true } } };
    });
    await client.setStatus(7, "in progress");
    const mutations = calls.filter((c) => c.query.includes("mutation"));
    expect(mutations.map((c) => c.variables)).toEqual([
      { project: "P1", content: "ISSUE" },
      { project: "P1", item: "NEW", field: "F1", option: "o-progress" },
    ]);
    await client.setStatus(7, null);
    expect(calls.at(-1)!.query).toContain("clearProjectV2ItemFieldValue");
    // Clearing an issue that is not on the board does nothing.
    onBoard = false;
    calls.length = 0;
    await client.setStatus(8, null);
    expect(calls.some((c) => c.query.includes("mutation"))).toBe(false);
  });
  it("holds on access and configuration problems but lets the queue retry rate limits", async () => {
    await expect(
      setup(() => ({ body: project }), undefined).client.scan(),
    ).rejects.toBeInstanceOf(WriteBlocked);
    await expect(
      setup(() => ({
        status: 401,
        body: { message: "Bad credentials" },
      })).client.scan(),
    ).rejects.toBeInstanceOf(WriteBlocked);
    await expect(
      setup(() => ({
        body: { data: { user: { projectV2: null } } },
      })).client.scan(),
    ).rejects.toThrow(/not found/);
    const limited = setup(() => ({
      status: 403,
      headers: { "retry-after": "30" },
      body: { message: "secondary rate limit" },
    }));
    const error = await limited.client.scan().catch((e) => e);
    expect(error).not.toBeInstanceOf(WriteBlocked);
    expect(error.response.headers["retry-after"]).toBe("30");
    const graphqlLimit = await setup(() => ({
      body: { errors: [{ type: "RATE_LIMITED", message: "limit" }] },
    }))
      .client.scan()
      .catch((e) => e);
    expect(graphqlLimit).not.toBeInstanceOf(WriteBlocked);
  });
  it("re-reads the field once for an unknown option, then refuses it", async () => {
    const { client, calls } = setup((query) =>
      query.includes("projectV2(number")
        ? { body: project }
        : { body: { data: {} } },
    );
    await expect(client.setStatus(1, "Shipped")).rejects.toThrow(
      /no option named "Shipped"/,
    );
    expect(
      calls.filter((c) => c.query.includes("projectV2(number")),
    ).toHaveLength(2);
  });
});
