import { describe, expect, it } from "vitest";

import { resolveOpenAiSubscriptionBilling } from "../services/heartbeat.ts";

const usage = { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 };

describe("resolveOpenAiSubscriptionBilling", () => {
  it("prices OpenAI subscription runs as metered API in USD", () => {
    const result = resolveOpenAiSubscriptionBilling({
      provider: "openai",
      model: "gpt-5",
      usage,
      billingType: "subscription_included",
      baseCostCents: 0,
    });
    // gpt-5: 1.25 input + 10.00 output per 1M => $11.25 => 1125 cents.
    expect(result).toEqual({ costCents: 1125, billingType: "metered_api", biller: "openai" });
  });

  it("also covers the empty-model subscription default (gpt-5.5 batch fallback)", () => {
    const result = resolveOpenAiSubscriptionBilling({
      provider: "openai",
      model: "",
      usage,
      billingType: "subscription_included",
      baseCostCents: 0,
    });
    // gpt-5.5 batch: 2.50 input + 15.00 output per 1M => $17.50 => 1750 cents.
    expect(result).toEqual({ costCents: 1750, billingType: "metered_api", biller: "openai" });
  });

  it("does not override metered API runs", () => {
    expect(
      resolveOpenAiSubscriptionBilling({
        provider: "openai",
        model: "gpt-5",
        usage,
        billingType: "metered_api",
        baseCostCents: 500,
      }),
    ).toBeNull();
  });

  it("never overrides an adapter-reported cost", () => {
    expect(
      resolveOpenAiSubscriptionBilling({
        provider: "openai",
        model: "gpt-5",
        usage,
        billingType: "subscription_included",
        baseCostCents: 42,
      }),
    ).toBeNull();
  });

  it("leaves non-OpenAI subscription runs untouched", () => {
    expect(
      resolveOpenAiSubscriptionBilling({
        provider: "anthropic",
        model: "claude-opus-4-8",
        usage,
        billingType: "subscription_included",
        baseCostCents: 0,
      }),
    ).toBeNull();
  });

  it("returns null when there is no usage to price", () => {
    expect(
      resolveOpenAiSubscriptionBilling({
        provider: "openai",
        model: "gpt-5",
        usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
        billingType: "subscription_included",
        baseCostCents: 0,
      }),
    ).toBeNull();
  });
});
