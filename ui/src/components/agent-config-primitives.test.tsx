// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ToggleField, ToggleWithNumber } from "./agent-config-primitives";

describe("agent-config-primitives toggles", () => {
  it("renders unchecked toggle with visible track and thumb styling", () => {
    const html = renderToStaticMarkup(
      <ToggleField label="Wake on demand" checked={false} onChange={vi.fn()} />,
    );

    expect(html).toContain("aria-pressed=\"false\"");
    expect(html).toContain("bg-muted border-border");
    expect(html).toContain("ring-1 ring-border/80");
  });

  it("renders checked toggle with active styling", () => {
    const html = renderToStaticMarkup(
      <ToggleWithNumber
        label="Heartbeat on interval"
        checked
        onCheckedChange={vi.fn()}
        number={240}
        onNumberChange={vi.fn()}
        numberLabel="sec"
        showNumber
      />,
    );

    expect(html).toContain("aria-pressed=\"true\"");
    expect(html).toContain("bg-green-600 border-green-600");
    expect(html).toContain("translate-x-4.5");
  });
});
