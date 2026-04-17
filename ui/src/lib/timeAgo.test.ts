import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { timeAgo } from "./timeAgo.js";

const NOW = new Date("2026-04-17T12:00:00.000Z").getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function secondsAgo(s: number): Date {
  return new Date(NOW - s * 1000);
}

describe("timeAgo", () => {
  it("returns 'just now' for 0 seconds ago", () => {
    expect(timeAgo(secondsAgo(0))).toBe("just now");
  });

  it("returns 'just now' for 30 seconds ago", () => {
    expect(timeAgo(secondsAgo(30))).toBe("just now");
  });

  it("returns 'just now' for 59 seconds ago", () => {
    expect(timeAgo(secondsAgo(59))).toBe("just now");
  });

  it("returns '1m ago' for exactly 1 minute ago", () => {
    expect(timeAgo(secondsAgo(60))).toBe("1m ago");
  });

  it("returns '5m ago' for 5 minutes ago", () => {
    expect(timeAgo(secondsAgo(5 * 60))).toBe("5m ago");
  });

  it("returns '59m ago' for 59 minutes ago", () => {
    expect(timeAgo(secondsAgo(59 * 60))).toBe("59m ago");
  });

  it("returns '1h ago' for exactly 1 hour ago", () => {
    expect(timeAgo(secondsAgo(3600))).toBe("1h ago");
  });

  it("returns '3h ago' for 3 hours ago", () => {
    expect(timeAgo(secondsAgo(3 * 3600))).toBe("3h ago");
  });

  it("returns '23h ago' for 23 hours ago", () => {
    expect(timeAgo(secondsAgo(23 * 3600))).toBe("23h ago");
  });

  it("returns '1d ago' for exactly 1 day ago", () => {
    expect(timeAgo(secondsAgo(24 * 3600))).toBe("1d ago");
  });

  it("returns '3d ago' for 3 days ago", () => {
    expect(timeAgo(secondsAgo(3 * 24 * 3600))).toBe("3d ago");
  });

  it("returns '6d ago' for 6 days ago", () => {
    expect(timeAgo(secondsAgo(6 * 24 * 3600))).toBe("6d ago");
  });

  it("returns '1w ago' for exactly 1 week ago", () => {
    expect(timeAgo(secondsAgo(7 * 24 * 3600))).toBe("1w ago");
  });

  it("returns '3w ago' for 3 weeks ago", () => {
    expect(timeAgo(secondsAgo(3 * 7 * 24 * 3600))).toBe("3w ago");
  });

  it("returns '1mo ago' for exactly 30 days ago", () => {
    expect(timeAgo(secondsAgo(30 * 24 * 3600))).toBe("1mo ago");
  });

  it("returns '2mo ago' for 60 days ago", () => {
    expect(timeAgo(secondsAgo(60 * 24 * 3600))).toBe("2mo ago");
  });

  it("accepts ISO string input", () => {
    const isoString = new Date(NOW - 5 * 60 * 1000).toISOString();
    expect(timeAgo(isoString)).toBe("5m ago");
  });
});
