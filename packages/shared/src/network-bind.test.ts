import { describe, it, expect } from "vitest";
import {
  LOOPBACK_BIND_HOST,
  ALL_INTERFACES_BIND_HOST,
  isLoopbackHost,
  isAllInterfacesHost,
  inferBindModeFromHost,
  validateConfiguredBindMode,
  resolveRuntimeBind,
} from "./network-bind.js";

// ============================================================================
// isLoopbackHost
// ============================================================================

describe("isLoopbackHost", () => {
  it("returns true for '127.0.0.1'", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
  });

  it("returns true for 'localhost'", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
  });

  it("returns true for 'LOCALHOST' (case-insensitive)", () => {
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
  });

  it("returns true for '::1' (IPv6 loopback)", () => {
    expect(isLoopbackHost("::1")).toBe(true);
  });

  it("returns false for '0.0.0.0'", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
  });

  it("returns false for a public IP", () => {
    expect(isLoopbackHost("192.168.1.1")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isLoopbackHost(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isLoopbackHost(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isLoopbackHost("")).toBe(false);
  });

  it("handles whitespace-padded host", () => {
    expect(isLoopbackHost("  127.0.0.1  ")).toBe(true);
  });
});

// ============================================================================
// isAllInterfacesHost
// ============================================================================

describe("isAllInterfacesHost", () => {
  it("returns true for '0.0.0.0'", () => {
    expect(isAllInterfacesHost("0.0.0.0")).toBe(true);
  });

  it("returns true for '::' (IPv6 all interfaces)", () => {
    expect(isAllInterfacesHost("::")).toBe(true);
  });

  it("returns false for '127.0.0.1'", () => {
    expect(isAllInterfacesHost("127.0.0.1")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isAllInterfacesHost(null)).toBe(false);
  });
});

// ============================================================================
// inferBindModeFromHost
// ============================================================================

describe("inferBindModeFromHost", () => {
  it("returns 'loopback' for null", () => {
    expect(inferBindModeFromHost(null)).toBe("loopback");
  });

  it("returns 'loopback' for '127.0.0.1'", () => {
    expect(inferBindModeFromHost("127.0.0.1")).toBe("loopback");
  });

  it("returns 'loopback' for 'localhost'", () => {
    expect(inferBindModeFromHost("localhost")).toBe("loopback");
  });

  it("returns 'lan' for '0.0.0.0'", () => {
    expect(inferBindModeFromHost("0.0.0.0")).toBe("lan");
  });

  it("returns 'tailnet' when host matches tailnetBindHost", () => {
    expect(
      inferBindModeFromHost("100.64.1.2", { tailnetBindHost: "100.64.1.2" })
    ).toBe("tailnet");
  });

  it("returns 'custom' for an unrecognized host with no tailnet match", () => {
    expect(inferBindModeFromHost("10.0.0.1")).toBe("custom");
  });

  it("returns 'custom' even when tailnetBindHost is set but host doesn't match", () => {
    expect(
      inferBindModeFromHost("10.0.0.1", { tailnetBindHost: "100.64.1.2" })
    ).toBe("custom");
  });
});

// ============================================================================
// validateConfiguredBindMode
// ============================================================================

describe("validateConfiguredBindMode", () => {
  it("returns no errors for a valid loopback local_trusted setup", () => {
    const errors = validateConfiguredBindMode({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      bind: "loopback",
    });
    expect(errors).toEqual([]);
  });

  it("returns error when local_trusted is not loopback", () => {
    const errors = validateConfiguredBindMode({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      bind: "lan",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/loopback/);
  });

  it("returns error when bind=custom but customBindHost is missing", () => {
    const errors = validateConfiguredBindMode({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bind: "custom",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/customBindHost/);
  });

  it("returns no error when bind=custom and customBindHost is set", () => {
    const errors = validateConfiguredBindMode({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bind: "custom",
      customBindHost: "10.0.0.5",
    });
    expect(errors).toEqual([]);
  });

  it("returns error when authenticated/public uses tailnet", () => {
    const errors = validateConfiguredBindMode({
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      bind: "tailnet",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/tailnet/);
  });

  it("allows tailnet for authenticated/private", () => {
    const errors = validateConfiguredBindMode({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bind: "tailnet",
    });
    expect(errors).toEqual([]);
  });
});

// ============================================================================
// resolveRuntimeBind
// ============================================================================

describe("resolveRuntimeBind", () => {
  it("resolves loopback bind to 127.0.0.1", () => {
    const result = resolveRuntimeBind({ bind: "loopback" });
    expect(result.bind).toBe("loopback");
    expect(result.host).toBe(LOOPBACK_BIND_HOST);
    expect(result.errors).toEqual([]);
  });

  it("resolves lan bind to 0.0.0.0", () => {
    const result = resolveRuntimeBind({ bind: "lan" });
    expect(result.bind).toBe("lan");
    expect(result.host).toBe(ALL_INTERFACES_BIND_HOST);
    expect(result.errors).toEqual([]);
  });

  it("resolves custom bind with customBindHost", () => {
    const result = resolveRuntimeBind({ bind: "custom", customBindHost: "10.0.0.5" });
    expect(result.host).toBe("10.0.0.5");
    expect(result.errors).toEqual([]);
  });

  it("returns error for custom bind without customBindHost", () => {
    const result = resolveRuntimeBind({ bind: "custom" });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/customBindHost/);
  });

  it("resolves tailnet bind with tailnetBindHost", () => {
    const result = resolveRuntimeBind({ bind: "tailnet", tailnetBindHost: "100.64.1.2" });
    expect(result.host).toBe("100.64.1.2");
    expect(result.errors).toEqual([]);
  });

  it("returns error for tailnet bind without tailnetBindHost", () => {
    const result = resolveRuntimeBind({ bind: "tailnet" });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/tailnet/);
  });

  it("infers bind mode from host when bind is not specified", () => {
    const result = resolveRuntimeBind({ host: "0.0.0.0" });
    expect(result.bind).toBe("lan");
    expect(result.host).toBe(ALL_INTERFACES_BIND_HOST);
  });
});

// ============================================================================
// constants
// ============================================================================

describe("LOOPBACK_BIND_HOST and ALL_INTERFACES_BIND_HOST", () => {
  it("LOOPBACK_BIND_HOST is 127.0.0.1", () => {
    expect(LOOPBACK_BIND_HOST).toBe("127.0.0.1");
  });

  it("ALL_INTERFACES_BIND_HOST is 0.0.0.0", () => {
    expect(ALL_INTERFACES_BIND_HOST).toBe("0.0.0.0");
  });
});
