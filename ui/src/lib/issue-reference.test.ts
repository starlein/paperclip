import { describe, expect, it } from "vitest";
import { parseIssueReferenceFromHref } from "./issue-reference";

describe("issue-reference", () => {
  it("strips trailing punctuation from issue paths", () => {
    expect(parseIssueReferenceFromHref("/PAP/issues/PAP-224)")).toEqual({
      issuePathId: "PAP-224",
      href: "/issues/PAP-224",
    });
  });

  it("rejects placeholder issue path segments", () => {
    expect(parseIssueReferenceFromHref("/PAP/issues/{issueId}")).toBeNull();
    expect(parseIssueReferenceFromHref("/PAP/issues/<issue-identifier>")).toBeNull();
  });
});
