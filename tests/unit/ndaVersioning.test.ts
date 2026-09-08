import { describe, expect, it } from "vitest";
import {
  getActiveNdaVersion,
  NDA_V1_1_PLAIN_TEXT,
  NDA_VERSIONS,
} from "../../src/modules/legal/nda/versions";

describe("NDA v1.1.0 electronic acceptance wording", () => {
  it("activates version 1.1.0 and archives 1.0.0", () => {
    const active = getActiveNdaVersion();
    expect(active.versionNumber).toBe("1.1.0");
    expect(active.active).toBe(true);
    const v1 = NDA_VERSIONS.find((v) => v.versionNumber === "1.0.0");
    expect(v1?.active).toBe(false);
    expect(v1?.status).toBe("archived");
  });

  it("uses electronic acceptance language instead of signing below", () => {
    expect(NDA_V1_1_PLAIN_TEXT).toContain(
      "By electronically accepting this Agreement below, Client acknowledges that Client has read, understands, and agrees to be bound by its terms.",
    );
    expect(NDA_V1_1_PLAIN_TEXT).not.toContain("By signing below");
  });

  it("does not require physical Signature/Date lines in the v1.1 twin", () => {
    expect(NDA_V1_1_PLAIN_TEXT).not.toMatch(/^Signature:/m);
    expect(NDA_V1_1_PLAIN_TEXT).not.toMatch(/^Date:/m);
  });
});
