/**
 * Plugin secrets host-side handler — resolves secret references through the
 * Paperclip secret provider system.
 *
 * When a plugin worker calls `ctx.secrets.resolve(secretRef)`, the JSON-RPC
 * request arrives at the host with `{ secretRef }`. This module provides the
 * concrete `HostServices.secrets` adapter that:
 *
 * 1. Parses the `secretRef` string to identify the secret.
 * 2. Derives the company scope from the invocation context.
 * 3. Validates that the secret belongs to the invoking company.
 * 4. Looks up the secret record and its latest version in the database.
 * 5. Delegates to the configured `SecretProviderModule` to decrypt /
 *    resolve the raw value.
 * 6. Returns the resolved plaintext value to the worker.
 *
 * ## Secret Reference Format
 *
 * A `secretRef` is a **secret UUID** — the primary key (`id`) of a row in
 * the `company_secrets` table. Operators place these UUIDs into plugin
 * config values; plugin workers resolve them at execution time via
 * `ctx.secrets.resolve(secretId)`.
 *
 * ## Security Invariants
 *
 * - Resolved values are **never** logged, persisted, or included in error
 *   messages (per PLUGIN_SPEC.md §22).
 * - The handler is capability-gated: only plugins with `secrets.read-ref`
 *   declared in their manifest may call it (enforced by `host-client-factory`).
 * - The handler requires an invocation scope with a `companyId`; calls
 *   without a company scope fail closed.
 * - The secret must belong to the invoking company; cross-company access
 *   is rejected.
 * - The host handler itself does not cache resolved values. Each call goes
 *   through the secret provider to honour rotation.
 *
 * @see PLUGIN_SPEC.md §22 — Secrets
 * @see host-client-factory.ts — capability gating
 * @see services/secrets.ts — secretService used by agent env bindings
 */

import type { Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { companySecretBindings, companySecrets } from "@paperclipai/db";
import {
  collectSecretRefPaths,
  isUuidSecretRef,
  readConfigValueAtPath,
} from "./json-schema-secret-refs.js";

export const PLUGIN_SECRET_REFS_DISABLED_MESSAGE =
  "Plugin secret references are disabled until company-scoped plugin config lands";

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function invalidSecretRef(secretRef: string): Error {
  const err = new Error(`Invalid secret reference: ${secretRef}`);
  err.name = "InvalidSecretRefError";
  return err;
}

function missingCompanyScope(): Error {
  const err = new Error(
    "Plugin secret resolution requires a company-scoped invocation context. " +
    "Ensure the plugin action runs within a company scope (e.g. an issue, heartbeat, or agent execution).",
  );
  err.name = "MissingCompanyScopeError";
  return err;
}

function secretNotFound(secretRef: string): Error {
  const err = new Error(`Secret not found: ${secretRef}`);
  err.name = "SecretNotFoundError";
  return err;
}

function secretNotOwnedByCompany(secretRef: string): Error {
  const err = new Error(
    `Secret ${secretRef} does not belong to the invoking company`,
  );
  err.name = "SecretCompanyMismatchError";
  return err;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Extract secret reference UUIDs from a plugin's configJson, scoped to only
 * the fields annotated with `format: "secret-ref"` in the schema.
 *
 * When no schema is provided, falls back to collecting all UUID-shaped strings
 * (backwards-compatible for plugins without a declared instanceConfigSchema).
 */
export function extractSecretRefsFromConfig(
  configJson: unknown,
  schema?: Record<string, unknown> | null,
): Set<string> {
  return new Set(extractSecretRefPathsFromConfig(configJson, schema).keys());
}

export function collectSecretRefValuesFromConfig(
  configJson: unknown,
  schema?: Record<string, unknown> | null,
): Map<string, string> {
  const values = new Map<string, string>();
  if (configJson == null || typeof configJson !== "object") return values;

  for (const dotPath of collectSecretRefPaths(schema)) {
    const current = readConfigValueAtPath(configJson as Record<string, unknown>, dotPath);
    if (typeof current !== "string") continue;
    const trimmed = current.trim();
    if (trimmed.length === 0) continue;
    values.set(dotPath, trimmed);
  }

  return values;
}

export function extractSecretRefPathsFromConfig(
  configJson: unknown,
  schema?: Record<string, unknown> | null,
): Map<string, Set<string>> {
  const refs = new Map<string, Set<string>>();
  const addRef = (secretRef: string, path: string) => {
    const existing = refs.get(secretRef) ?? new Set<string>();
    existing.add(path);
    refs.set(secretRef, existing);
  };
  if (configJson == null || typeof configJson !== "object") return new Map();

  const secretPaths = collectSecretRefPaths(schema);

  // If schema declares secret-ref paths, extract only those values.
  if (secretPaths.size > 0) {
    for (const dotPath of secretPaths) {
      const current = readConfigValueAtPath(configJson as Record<string, unknown>, dotPath);
      if (typeof current === "string" && isUuidSecretRef(current)) {
        addRef(current, dotPath);
      }
    }
    return refs;
  }

  // Fallback: no schema or no secret-ref annotations — collect all UUIDs.
  // This preserves backwards compatibility for plugins that omit
  // instanceConfigSchema.
  function walkAll(value: unknown): void {
    if (typeof value === "string") {
      if (isUuidSecretRef(value)) addRef(value, "$");
    } else if (Array.isArray(value)) {
      for (const item of value) walkAll(item);
    } else if (value !== null && typeof value === "object") {
      for (const v of Object.values(value as Record<string, unknown>)) walkAll(v);
    }
  }

  walkAll(configJson);
  return refs;
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Input shape for the `secrets.resolve` handler.
 *
 * Matches `WorkerToHostMethods["secrets.resolve"][0]` from `protocol.ts`.
 */
export interface PluginSecretsResolveParams {
  /** The secret reference string (a secret UUID). */
  secretRef: string;
}

/**
 * Options for creating the plugin secrets handler.
 */
export interface PluginSecretsHandlerOptions {
  /** Database connection. */
  db: Db;
  /**
   * The plugin ID using this handler.
   * Used for logging context only; never included in error payloads
   * that reach the plugin worker.
   */
  pluginId: string;
}

/**
 * The `HostServices.secrets` adapter for the plugin host-client factory.
 */
export interface PluginSecretsService {
  /**
   * Resolve a secret reference to its current plaintext value.
   *
   * @param params - Contains the `secretRef` (UUID of the secret)
   * @param companyId - The company ID derived from the invocation scope.
   *   Required for company-scoped secret access.
   * @returns The resolved secret value
   * @throws {Error} If the secret is not found, has no versions, or
   *   the provider fails to resolve
   */
  resolve(params: PluginSecretsResolveParams, companyId?: string): Promise<string>;
}

/**
 * Create a `HostServices.secrets` adapter for a specific plugin.
 *
 * The returned service looks up secrets by UUID, fetches the latest version
 * material, and delegates to the appropriate `SecretProviderModule` for
 * decryption.
 *
 * @example
 * ```ts
 * const secretsHandler = createPluginSecretsHandler({ db, pluginId });
 * const handlers = createHostClientHandlers({
 *   pluginId,
 *   capabilities: manifest.capabilities,
 *   services: {
 *     secrets: secretsHandler,
 *     // ...
 *   },
 * });
 * ```
 *
 * @param options - Database connection and plugin identity
 * @returns A `PluginSecretsService` suitable for `HostServices.secrets`
 */
/** Simple sliding-window rate limiter for secret resolution attempts. */
function createRateLimiter(maxAttempts: number, windowMs: number) {
  const attempts = new Map<string, number[]>();

  return {
    check(key: string): boolean {
      const now = Date.now();
      const windowStart = now - windowMs;
      const existing = (attempts.get(key) ?? []).filter((ts) => ts > windowStart);
      if (existing.length >= maxAttempts) return false;
      existing.push(now);
      attempts.set(key, existing);
      return true;
    },
  };
}

export function createPluginSecretsHandler(
  options: PluginSecretsHandlerOptions,
): PluginSecretsService {
  const { db, pluginId } = options;

  // Rate limit: max 30 resolution attempts per plugin per minute
  const rateLimiter = createRateLimiter(30, 60_000);

  return {
    async resolve(params: PluginSecretsResolveParams, companyId?: string): Promise<string> {
      const { secretRef } = params;

      // ---------------------------------------------------------------
      // 0. Rate limiting — prevent brute-force UUID enumeration
      // ---------------------------------------------------------------
      if (!rateLimiter.check(pluginId)) {
        const err = new Error("Rate limit exceeded for secret resolution");
        err.name = "RateLimitExceededError";
        throw err;
      }

      // ---------------------------------------------------------------
      // 1. Validate the ref format
      // ---------------------------------------------------------------
      if (!secretRef || typeof secretRef !== "string" || secretRef.trim().length === 0) {
        throw invalidSecretRef(secretRef ?? "<empty>");
      }

      const trimmedRef = secretRef.trim();

      if (!isUuidSecretRef(trimmedRef)) {
        throw invalidSecretRef(trimmedRef);
      }

      // ---------------------------------------------------------------
      // 2. Require company scope
      // ---------------------------------------------------------------
      if (!companyId) {
        throw missingCompanyScope();
      }

      // ---------------------------------------------------------------
      // 3. Look up the secret and verify company ownership
      // ---------------------------------------------------------------
      const secret = await db
        .select({
          id: companySecrets.id,
          companyId: companySecrets.companyId,
        })
        .from(companySecrets)
        .where(eq(companySecrets.id, trimmedRef))
        .then((rows) => rows[0] ?? null);

      if (!secret) {
        throw secretNotFound(trimmedRef);
      }

      if (secret.companyId !== companyId) {
        throw secretNotOwnedByCompany(trimmedRef);
      }

      const binding = await db
        .select({
          configPath: companySecretBindings.configPath,
          versionSelector: companySecretBindings.versionSelector,
        })
        .from(companySecretBindings)
        .where(
          and(
            eq(companySecretBindings.companyId, companyId),
            eq(companySecretBindings.secretId, trimmedRef),
            eq(companySecretBindings.targetType, "plugin"),
            eq(companySecretBindings.targetId, pluginId),
          ),
        )
        .then((rows) => rows[0] ?? null)
        .catch(() => null);

      const resolvedVersion: number | "latest" = binding?.versionSelector === "latest" || !binding?.versionSelector
        ? "latest"
        : Number.parseInt(binding.versionSelector, 10);
      const safeResolvedVersion = typeof resolvedVersion === "number" && Number.isFinite(resolvedVersion)
        ? resolvedVersion
        : "latest";

      // ---------------------------------------------------------------
      // 4. Resolve the secret value through the provider
      // ---------------------------------------------------------------
      const { secretService } = await import("./secrets.js");
      const svc = secretService(db);
      return svc.resolveSecretValue(
        companyId,
        trimmedRef,
        safeResolvedVersion,
        binding
          ? {
              consumerType: "plugin",
              consumerId: pluginId,
              actorType: "system",
              actorId: null,
              configPath: binding.configPath,
              pluginId,
            }
          : undefined,
      );
    },
  };
}