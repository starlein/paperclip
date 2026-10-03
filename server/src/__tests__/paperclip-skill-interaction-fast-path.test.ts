import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const paperclipSkillPaths = ["skills/paperclip/SKILL.md"];

describe("Paperclip pending interaction skill contract", () => {
  for (const relativePath of paperclipSkillPaths) {
    it(`${relativePath} keeps addressee reviews out of issue checkout ownership`, async () => {
      const body = await fs.readFile(path.join(process.cwd(), relativePath), "utf8");

      expect(body).toContain("PAPERCLIP_WAKE_REASON=interaction_pending");
      expect(body).toContain("request_confirmation`, `request_checkbox_confirmation`, and `request_item_verdicts");
      expect(body).toContain("other kinds follow the normal workflow");
      expect(body).toContain("Do not checkout, reassign, release, or status-PATCH the issue");
      expect(body).toContain("/interactions/{interactionId}/verdicts");
      expect(body).toContain("issue ownership and execution locks stay with the implementation owner");
      expect(body).toContain("Except for the pending-interaction addressee fast path above");
    });
  }
});
