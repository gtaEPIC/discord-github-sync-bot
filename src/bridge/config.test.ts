import { describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_CONFIG,
  parseBridgeConfig,
  resolveConfig,
} from "./config";

describe("bridge settings", () => {
  it("defaults to upstream user mode", () => {
    expect(resolveConfig(undefined)).toEqual(DEFAULT_CONFIG);
    expect(resolveConfig({})).toMatchObject({ writeMode: "user" });
  });
  it("accepts a full bridge configuration and keeps only given keys", () => {
    expect(
      parseBridgeConfig({
        writeMode: "bridge",
        allowRoles: ["123456", "123456"],
        rateLimit: { issuesPerHour: 2 },
      }),
    ).toEqual({
      writeMode: "bridge",
      allowRoles: ["123456"],
      rateLimit: { issuesPerHour: 2 },
    });
    expect(
      resolveConfig({ writeMode: "bridge", rateLimit: { issuesPerHour: 2 } })
        .rateLimit,
    ).toEqual({ issuesPerHour: 2, commentsPerHour: 60 });
  });
  it("rejects unknown keys, bad modes, bad role IDs and bad limits with every problem listed", () => {
    let error: unknown;
    try {
      parseBridgeConfig({
        writemode: "bridge",
        writeMode: "everyone",
        allowRoles: ["moderators"],
        rateLimit: { issuesPerHour: -1, burst: 3 },
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).problems).toHaveLength(5);
    expect(() => parseBridgeConfig([])).toThrow(ConfigError);
    expect(() => parseBridgeConfig("bridge")).toThrow(ConfigError);
  });
  it("validates tag-to-label mappings", () => {
    expect(parseBridgeConfig({ labels: { Feature: "enhancement" } })).toEqual({
      labels: { Feature: "enhancement" },
    });
    expect(() => parseBridgeConfig({ labels: { Feature: 3 } })).toThrow(
      ConfigError,
    );
    expect(() => parseBridgeConfig({ labels: ["bug"] })).toThrow(ConfigError);
    expect(resolveConfig({}).labels).toEqual({});
  });
  it("validates close tags", () => {
    const closeTags = [
      { tag: "Fixed", reason: "completed" },
      { tag: "Won't Fix", reason: "not_planned" },
    ];
    expect(parseBridgeConfig({ closeTags })).toEqual({ closeTags });
    expect(resolveConfig({}).closeTags).toEqual([]);
    for (const bad of [
      [{ tag: "Fixed", reason: "done" }],
      [{ tag: "Fixed" }],
      [{ tag: "", reason: "completed" }],
      [{ tag: "Fixed", reason: "completed", extra: 1 }],
      [
        { tag: "Fixed", reason: "completed" },
        { tag: "fixed", reason: "not_planned" },
      ],
      { Fixed: "completed" },
    ])
      expect(() => parseBridgeConfig({ closeTags: bad })).toThrow(ConfigError);
  });
  it("validates Projects status settings and fills defaults", () => {
    const status = {
      owner: "gtaEPIC",
      number: 2,
      tags: { "In Progress": "In Progress" },
      defaultOption: "Backlog",
    };
    expect(parseBridgeConfig({ status })).toEqual({ status });
    expect(resolveConfig({ status }).status).toEqual({
      ...status,
      field: "Status",
      pollSeconds: 120,
    });
    expect(resolveConfig({}).status).toBeUndefined();
    for (const bad of [
      { ...status, owner: "not a login" },
      { ...status, number: 0 },
      { ...status, tags: {} },
      { ...status, pollSeconds: 30 },
      { ...status, column: "Status" },
      "board",
    ])
      expect(() => parseBridgeConfig({ status: bad })).toThrow(ConfigError);
    expect(() =>
      parseBridgeConfig({
        closeTags: [{ tag: "Done", reason: "completed" }],
        status: { ...status, tags: { done: "Done" } },
      }),
    ).toThrow(/both a close tag and a status tag/);
  });
  it("validates timeline settings", () => {
    expect(parseBridgeConfig({ timeline: {} })).toEqual({ timeline: {} });
    expect(resolveConfig({ timeline: {} }).timeline).toEqual({
      maxAgeDaysClosed: 14,
    });
    expect(resolveConfig({}).timeline).toBeUndefined();
    for (const bad of [true, { maxAgeDaysClosed: -1 }, { days: 3 }])
      expect(() => parseBridgeConfig({ timeline: bad })).toThrow(ConfigError);
  });
  it("never resolves corrupt stored settings to bridge mode", () => {
    expect(resolveConfig({ writeMode: "bridge", typo: true }).writeMode).toBe(
      "user",
    );
  });
});
