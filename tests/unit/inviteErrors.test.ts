import { describe, expect, it } from "vitest";
import { mapInviteError } from "../../src/modules/client/inviteErrors";

describe("mapInviteError", () => {
  it("maps already viewed", () => {
    const e = mapInviteError({
      message: "This presentation has already been viewed. Please contact your representative.",
      code: "functions/failed-precondition",
    });
    expect(e.kind).toBe("viewed");
    expect(e.title).toMatch(/completed/i);
    expect(e.message.toLowerCase()).not.toContain("internal");
  });

  it("maps expired", () => {
    const e = mapInviteError({
      message: "This invitation has expired.",
      code: "functions/failed-precondition",
    });
    expect(e.kind).toBe("expired");
  });

  it("never surfaces INTERNAL", () => {
    const e = mapInviteError({
      message: "INTERNAL",
      code: "functions/internal",
    });
    expect(e.message.toLowerCase()).not.toContain("internal");
    expect(e.title.toLowerCase()).not.toContain("internal");
    expect(e.kind).toBe("unavailable");
  });

  it("maps not found", () => {
    const e = mapInviteError({
      message: "Invitation not found.",
      code: "functions/not-found",
    });
    expect(e.kind).toBe("invalid");
  });
});
