import { describe, expect, it } from "vitest";
import {
  createPluginSecretsHandler,
  PLUGIN_SECRET_REFS_DISABLED_MESSAGE,
} from "../services/plugin-secrets-handler.js";

const VALID_UUID = "77777777-7777-4777-8777-777777777777";

describe("createPluginSecretsHandler", () => {
  it("rejects malformed (non-UUID) secret refs", async () => {
    const handler = createPluginSecretsHandler({
      db: {} as never,
      pluginId: "11111111-1111-4111-8111-111111111111",
    });

    await expect(
      handler.resolve({ secretRef: "not-a-uuid" }),
    ).rejects.toThrow(/invalid secret reference/i);

    // Also reject hsk_-prefixed external key formats (the original bug in the logs)
    await expect(
      handler.resolve({ secretRef: "hsk_fc23abbba481f9418485c5cabcf458fd_f2089e529af404d2" }),
    ).rejects.toThrow(/invalid secret reference/i);
  });

  it("rejects empty or missing secret refs", async () => {
    const handler = createPluginSecretsHandler({
      db: {} as never,
      pluginId: "22222222-2222-4222-8222-222222222222",
    });

    await expect(handler.resolve({ secretRef: "" })).rejects.toThrow(/invalid secret reference/i);
  });

  it("requires a company scope (companyId) for secret resolution — fails closed without one", async () => {
    const handler = createPluginSecretsHandler({
      db: {} as never,
      pluginId: "33333333-3333-4333-8333-333333333333",
    });

    // Valid UUID format but no companyId — must fail closed
    await expect(
      handler.resolve({ secretRef: VALID_UUID }),
    ).rejects.toThrow(/company-scoped invocation/i);

    // Also fails with undefined explicitly
    await expect(
      handler.resolve({ secretRef: VALID_UUID }, undefined),
    ).rejects.toThrow(/company-scoped invocation/i);
  });

  it("rate-limits rapid secret resolution attempts", async () => {
    const handler = createPluginSecretsHandler({
      db: {} as never,
      pluginId: "44444444-4444-4444-8444-444444444444",
    });

    // Exhaust the rate limit (30 per minute) — these will all fail at the
    // company-scope check, but the rate limiter still counts them
    const promises = [];
    for (let i = 0; i < 31; i++) {
      promises.push(
        handler.resolve({ secretRef: VALID_UUID }).catch(() => { /* expected */ }),
      );
    }
    await Promise.all(promises);

    // The 32nd call should be rate-limited
    await expect(
      handler.resolve({ secretRef: VALID_UUID }),
    ).rejects.toThrow(/rate limit exceeded/i);
  });

  it("preserves backwards compatibility: PLUGIN_SECRET_REFS_DISABLED_MESSAGE is still exported", () => {
    expect(PLUGIN_SECRET_REFS_DISABLED_MESSAGE).toBe(
      "Plugin secret references are disabled until company-scoped plugin config lands",
    );
  });

  // DB-backed tests using a simplified mock for the Drizzle query chain.
  // Drizzle call pattern: db.select({}).from(table).where(eq(table.col, val)).then(rows => ...)
  describe("with db mock for ownership and existence checks", () => {
    // Build a mock that returns the given rows from the Drizzle query chain.
    // We use a custom thenable to avoid Drizzle detecting our mock as a Promise.
    function mockDbQuery(rows: Array<{ id: string; companyId: string }>) {
      const queryResult = {
        then(onFulfilled: (val: unknown) => unknown) {
          return onFulfilled(rows);
        },
      };
      const whereResult = {
        then: queryResult.then.bind(queryResult),
      };
      const fromResult = {
        where: () => whereResult,
      };
      const selectResult = {
        from: () => fromResult,
      };
      const db = {
        select: () => selectResult,
      };
      return db as unknown as import("@paperclipai/db").Db;
    }

    it("rejects cross-company secret access", async () => {
      const pluginId = "55555555-5555-4555-8555-555555555555";
      const companyId = "66666666-6666-4666-8666-666666666666";
      const secretId = VALID_UUID;
      const otherCompanyId = "99999999-9999-4999-8999-999999999999";

      const handler = createPluginSecretsHandler({ db: mockDbQuery([{ id: secretId, companyId: otherCompanyId }]), pluginId });

      await expect(
        handler.resolve({ secretRef: secretId }, companyId),
      ).rejects.toThrow(/does not belong to the invoking company/i);
    });

    it("rejects when secret does not exist (empty result)", async () => {
      const pluginId = "77777777a-7777-4777-877a-77777777777a";
      const companyId = "88888888-8888-4888-8888-888888888888";
      const secretId = VALID_UUID;

      const handler = createPluginSecretsHandler({ db: mockDbQuery([]), pluginId });

      await expect(
        handler.resolve({ secretRef: secretId }, companyId),
      ).rejects.toThrow(/secret not found/i);
    });

    it("passes ownership check for company-owned secrets and delegates to secretService", async () => {
      const pluginId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const companyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const secretId = VALID_UUID;

      const handler = createPluginSecretsHandler({ db: mockDbQuery([{ id: secretId, companyId }]), pluginId });

      // The call should get past the company-ownership check.
      // It will fail at the resolveSecretValue step (dynamic import of secrets.ts
      // which won't work with a mock db), but that proves the guard passed.
      const result = handler.resolve({ secretRef: secretId }, companyId);
      await expect(result).rejects.not.toThrow(/does not belong to the invoking company/i);
      await expect(result).rejects.not.toThrow(/company-scoped invocation/i);
      await expect(result).rejects.not.toThrow(/secret not found/i);
    });
  });
});