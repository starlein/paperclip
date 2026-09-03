const NUMBER_WORDS = new Map<string, number>([
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10],
]);

const IMPLEMENTATION_PR_LIMIT_PATTERN =
  /\bat most\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+open implementation PRs?\b/gi;

function parseLimit(raw: string) {
  const normalized = raw.toLowerCase();
  const wordValue = NUMBER_WORDS.get(normalized);
  if (wordValue !== undefined) return wordValue;
  const numericValue = Number.parseInt(normalized, 10);
  return Number.isSafeInteger(numericValue) && numericValue > 0 ? numericValue : null;
}

export function implementationPrLimits(instructions: string) {
  return [...instructions.matchAll(IMPLEMENTATION_PR_LIMIT_PATTERN)]
    .map((match) => parseLimit(match[1]!))
    .filter((limit): limit is number => limit !== null);
}

export function authoritativeImplementationPrLimit(companyInstructions: string) {
  const limits = [...new Set(implementationPrLimits(companyInstructions))];
  if (limits.length === 0) return null;
  if (limits.length > 1) {
    throw new Error(
      `Company instructions contain contradictory implementation PR limits: ${limits.join(", ")}`,
    );
  }
  return limits[0]!;
}

export function reconcileManagedAgentInstructionPolicy(input: {
  agentInstructions: string;
  companyInstructions: string;
}) {
  const authoritativeLimit = authoritativeImplementationPrLimit(input.companyInstructions);
  if (authoritativeLimit === null) {
    return {
      content: input.agentInstructions,
      changed: false,
      authoritativeLimit: null,
      replacedLimits: [] as number[],
    };
  }

  const replacedLimits = implementationPrLimits(input.agentInstructions)
    .filter((limit) => limit !== authoritativeLimit);
  if (replacedLimits.length === 0) {
    return {
      content: input.agentInstructions,
      changed: false,
      authoritativeLimit,
      replacedLimits,
    };
  }

  const content = input.agentInstructions.replace(
    IMPLEMENTATION_PR_LIMIT_PATTERN,
    `at most ${authoritativeLimit} open implementation PRs`,
  );
  return {
    content,
    changed: content !== input.agentInstructions,
    authoritativeLimit,
    replacedLimits,
  };
}
