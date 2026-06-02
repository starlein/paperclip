import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { plugins, pluginState } from "@paperclipai/db";

export const HINDSIGHT_MEMORY_PLUGIN_KEY = "paperclip-plugin-hindsight";
export const HINDSIGHT_MEMORY_STATE_KEY = "recalled-memories";
export const HINDSIGHT_MEMORY_CONTEXT_KEY = "paperclipHindsightMemory";
export const HINDSIGHT_MEMORY_PROMPT_HEADER = "Relevant long-term memory from Hindsight";
export const DEFAULT_HINDSIGHT_MEMORY_WAIT_TIMEOUT_MS = 2_000;
export const DEFAULT_HINDSIGHT_MEMORY_POLL_INTERVAL_MS = 100;
export const MAX_HINDSIGHT_MEMORY_CONTEXT_CHARS = 12_000;

type LogFn = (stream: "stdout" | "stderr", chunk: string) => Promise<void>;

type SleepFn = (ms: number) => Promise<void>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePositiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function normalizeHindsightRecalledMemory(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function buildHindsightMemoryPromptSection(value: unknown): string | null {
  const recalledMemory = normalizeHindsightRecalledMemory(value);
  if (!recalledMemory) return null;
  const clipped = recalledMemory.length > MAX_HINDSIGHT_MEMORY_CONTEXT_CHARS
    ? `${recalledMemory.slice(0, MAX_HINDSIGHT_MEMORY_CONTEXT_CHARS)}\n[Hindsight memory truncated by Paperclip]`
    : recalledMemory;
  return `${HINDSIGHT_MEMORY_PROMPT_HEADER}:\n${clipped}`;
}

export function injectHindsightMemoryContext(
  context: Record<string, unknown>,
  recalledMemory: unknown,
): boolean {
  const promptSection = buildHindsightMemoryPromptSection(recalledMemory);
  if (!promptSection) {
    delete context[HINDSIGHT_MEMORY_CONTEXT_KEY];
    return false;
  }
  context[HINDSIGHT_MEMORY_CONTEXT_KEY] = promptSection;
  return true;
}

export async function waitForHindsightRecalledMemory(input: {
  lookup: () => Promise<unknown>;
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: SleepFn;
  now?: () => number;
}): Promise<string | null> {
  const timeoutMs = normalizePositiveInteger(
    input.timeoutMs ?? DEFAULT_HINDSIGHT_MEMORY_WAIT_TIMEOUT_MS,
    DEFAULT_HINDSIGHT_MEMORY_WAIT_TIMEOUT_MS,
  );
  const intervalMs = normalizePositiveInteger(
    input.intervalMs ?? DEFAULT_HINDSIGHT_MEMORY_POLL_INTERVAL_MS,
    DEFAULT_HINDSIGHT_MEMORY_POLL_INTERVAL_MS,
  );
  const sleepFn = input.sleep ?? sleep;
  const nowFn = input.now ?? Date.now;
  const deadline = nowFn() + timeoutMs;

  for (;;) {
    const recalledMemory = normalizeHindsightRecalledMemory(await input.lookup());
    if (recalledMemory) return recalledMemory;
    if (nowFn() >= deadline) return null;
    await sleepFn(Math.min(intervalMs, Math.max(0, deadline - nowFn())));
  }
}

async function findReadyHindsightPluginId(db: Db): Promise<string | null> {
  const row = await db
    .select({ id: plugins.id })
    .from(plugins)
    .where(and(eq(plugins.pluginKey, HINDSIGHT_MEMORY_PLUGIN_KEY), eq(plugins.status, "ready")))
    .then((rows) => rows[0] ?? null);
  return row?.id ?? null;
}

export async function injectHindsightMemoryContextFromPluginState(input: {
  db: Db;
  runId: string;
  context: Record<string, unknown>;
  onLog?: LogFn;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<boolean> {
  if (typeof input.context.issueId !== "string" || input.context.issueId.trim().length === 0) {
    delete input.context[HINDSIGHT_MEMORY_CONTEXT_KEY];
    return false;
  }

  const pluginId = await findReadyHindsightPluginId(input.db);
  if (!pluginId) {
    delete input.context[HINDSIGHT_MEMORY_CONTEXT_KEY];
    return false;
  }

  const recalledMemory = await waitForHindsightRecalledMemory({
    timeoutMs: input.timeoutMs,
    intervalMs: input.intervalMs,
    lookup: async () => {
      const row = await input.db
        .select({ valueJson: pluginState.valueJson })
        .from(pluginState)
        .where(
          and(
            eq(pluginState.pluginId, pluginId),
            eq(pluginState.scopeKind, "run"),
            eq(pluginState.scopeId, input.runId),
            eq(pluginState.namespace, "default"),
            eq(pluginState.stateKey, HINDSIGHT_MEMORY_STATE_KEY),
          ),
        )
        .then((rows) => rows[0] ?? null);
      return row?.valueJson ?? null;
    },
  });

  const injected = injectHindsightMemoryContext(input.context, recalledMemory);
  if (injected) {
    await input.onLog?.(
      "stdout",
      "[paperclip] Injected recalled Hindsight long-term memory into this heartbeat.\n",
    );
  }
  return injected;
}
