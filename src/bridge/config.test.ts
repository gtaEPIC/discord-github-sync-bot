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
  it("never resolves corrupt stored settings to bridge mode", () => {
    expect(resolveConfig({ writeMode: "bridge", typo: true }).writeMode).toBe(
      "user",
    );
  });
});
