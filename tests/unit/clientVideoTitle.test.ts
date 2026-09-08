import { describe, expect, it } from "vitest";
import {
  clientSafeVideoTitle,
  shouldRenderClientPlayerTitle,
  staffDisplayVideoTitle,
} from "../../src/modules/video/clientVideoTitle.pure";

describe("client video title isolation", () => {
  it("never returns the internal library title for client APIs", () => {
    expect(clientSafeVideoTitle("Dan's Presentation")).toBeUndefined();
    expect(clientSafeVideoTitle("Sales Presentation")).toBeUndefined();
    expect(clientSafeVideoTitle("")).toBeUndefined();
  });

  it("does not render an internal title in the client player", () => {
    expect(shouldRenderClientPlayerTitle("Dan's Presentation")).toBe(false);
    expect(shouldRenderClientPlayerTitle("Presentation")).toBe(false);
    expect(shouldRenderClientPlayerTitle(undefined)).toBe(false);
    expect(shouldRenderClientPlayerTitle("")).toBe(false);
  });

  it("preserves internal titles for staff assignment / Video Library", () => {
    expect(staffDisplayVideoTitle("Dan's Presentation")).toBe(
      "Dan's Presentation",
    );
    expect(staffDisplayVideoTitle("Sales Presentation")).toBe(
      "Sales Presentation",
    );
    expect(staffDisplayVideoTitle(null)).toBe("Untitled video");
  });
});
