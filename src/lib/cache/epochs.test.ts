import { describe, expect, it } from "vitest";
import { createEpochRegistry } from "./epochs";

describe("request epochs", () => {
  it("issues a strictly increasing epoch across every context", () => {
    const epochs = createEpochRegistry();

    const first = epochs.issue("a");
    const second = epochs.issue("a");
    const other = epochs.issue("b");

    expect(second).toBeGreaterThan(first);
    expect(other).toBeGreaterThan(second);
  });

  it("accepts only the latest epoch of the selected context", () => {
    const epochs = createEpochRegistry();

    const stale = epochs.select("a");
    expect(epochs.accepts("a", stale)).toBe(true);

    const fresh = epochs.issue("a");
    expect(epochs.accepts("a", stale)).toBe(false);
    expect(epochs.accepts("a", fresh)).toBe(true);
  });

  it("refuses a response for a context that is no longer selected, even at its latest epoch", () => {
    const epochs = createEpochRegistry();

    const first = epochs.select("a");
    expect(epochs.accepts("a", first)).toBe(true);

    const second = epochs.select("b");

    expect(epochs.accepts("a", first)).toBe(false);
    expect(epochs.accepts("b", second)).toBe(true);
  });

  it("refuses every epoch once nothing is selected", () => {
    const epochs = createEpochRegistry();
    const epoch = epochs.select("a");

    epochs.deselect();

    expect(epochs.selected()).toBe(null);
    expect(epochs.accepts("a", epoch)).toBe(false);
  });

  it("reports the latest epoch issued for a context", () => {
    const epochs = createEpochRegistry();

    expect(epochs.latest("a")).toBe(null);
    const issued = epochs.issue("a");
    expect(epochs.latest("a")).toBe(issued);
  });
});
