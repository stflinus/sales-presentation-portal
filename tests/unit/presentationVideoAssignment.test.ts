import { describe, expect, it } from "vitest";
import {
  ignoreClientSubmittedVideoId,
  mergePresentationSettingsPatch,
  resolveInviteVideoSelection,
  snapshottedInviteVideoId,
} from "../../functions/src/lib/presentationPolicy.pure";

const DAN_VIDEO = "PcMlyjYFumQfRURoy1dJ";
const MIKE_VIDEO = "mike-video-id";
const SALES_VIDEO = "2cABIGuqvzBfCtzDFy1D";

describe("resolveInviteVideoSelection precedence", () => {
  it("explicit Dan assignment wins over company Sales Presentation default", () => {
    const result = resolveInviteVideoSelection({
      assignedVideoId: DAN_VIDEO,
      companyActiveVideoId: SALES_VIDEO,
    });
    expect(result.source).toBe("rep_assignment");
    expect(result.videoId).toBe(DAN_VIDEO);
  });

  it("Mike assignment wins over company default", () => {
    expect(
      resolveInviteVideoSelection({
        assignedVideoId: MIKE_VIDEO,
        companyActiveVideoId: SALES_VIDEO,
      }).videoId,
    ).toBe(MIKE_VIDEO);
  });

  it("generic rep with Sales assignment keeps Sales even if company changes", () => {
    expect(
      resolveInviteVideoSelection({
        assignedVideoId: SALES_VIDEO,
        companyActiveVideoId: DAN_VIDEO,
      }).videoId,
    ).toBe(SALES_VIDEO);
  });

  it("company fallback only when rep has no explicit assignment", () => {
    const result = resolveInviteVideoSelection({
      assignedVideoId: null,
      companyActiveVideoId: SALES_VIDEO,
    });
    expect(result.source).toBe("company_fallback");
    expect(result.videoId).toBe(SALES_VIDEO);
  });

  it("empty string assignment uses company fallback", () => {
    expect(
      resolveInviteVideoSelection({
        assignedVideoId: "  ",
        companyActiveVideoId: SALES_VIDEO,
      }).source,
    ).toBe("company_fallback");
  });

  it("changing company default does not override explicit Dan assignment", () => {
    const before = resolveInviteVideoSelection({
      assignedVideoId: DAN_VIDEO,
      companyActiveVideoId: SALES_VIDEO,
    });
    const after = resolveInviteVideoSelection({
      assignedVideoId: DAN_VIDEO,
      companyActiveVideoId: "some-other-company-default",
    });
    expect(before.videoId).toBe(DAN_VIDEO);
    expect(after.videoId).toBe(DAN_VIDEO);
  });
});

describe("invitation video snapshot immutability", () => {
  it("later rep assignment change does not mutate existing invite videoId", () => {
    expect(
      snapshottedInviteVideoId({
        inviteVideoId: SALES_VIDEO,
        laterRepAssignedVideoId: DAN_VIDEO,
        laterCompanyActiveVideoId: DAN_VIDEO,
      }),
    ).toBe(SALES_VIDEO);
  });

  it("later company default change does not mutate existing invite videoId", () => {
    expect(
      snapshottedInviteVideoId({
        inviteVideoId: DAN_VIDEO,
        laterRepAssignedVideoId: DAN_VIDEO,
        laterCompanyActiveVideoId: SALES_VIDEO,
      }),
    ).toBe(DAN_VIDEO);
  });
});

describe("client cannot override assigned video", () => {
  it("ignores client-submitted videoId", () => {
    expect(ignoreClientSubmittedVideoId(DAN_VIDEO)).toBeUndefined();
    expect(ignoreClientSubmittedVideoId(SALES_VIDEO)).toBeUndefined();
    expect(ignoreClientSubmittedVideoId(null)).toBeUndefined();
  });
});

describe("presentation assignment vs access policy independence", () => {
  it("changing access policy does not erase presentation assignment", () => {
    const merged = mergePresentationSettingsPatch({
      previous: {
        activeVideoId: DAN_VIDEO,
        accessPolicy: "single_view",
        accessDurationDays: null,
      },
      patch: {
        accessPolicy: "time_limited",
        accessDurationDays: 7,
      },
    });
    expect(merged.activeVideoId).toBe(DAN_VIDEO);
    expect(merged.accessPolicy).toBe("time_limited");
    expect(merged.accessDurationDays).toBe(7);
  });

  it("changing presentation assignment does not alter access policy", () => {
    const merged = mergePresentationSettingsPatch({
      previous: {
        activeVideoId: SALES_VIDEO,
        accessPolicy: "time_limited",
        accessDurationDays: 7,
      },
      patch: {
        activeVideoId: DAN_VIDEO,
      },
    });
    expect(merged.activeVideoId).toBe(DAN_VIDEO);
    expect(merged.accessPolicy).toBe("time_limited");
    expect(merged.accessDurationDays).toBe(7);
  });
});
