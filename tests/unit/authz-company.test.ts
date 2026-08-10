import { describe, expect, it } from "vitest";
import {
  assertSessionCompanyAccess,
  resolveActingCompanyId,
  type StaffContext,
} from "../../functions/src/lib/authz";
import { PERMISSIONS } from "../../functions/src/shared";

/** Firebase's HttpsError isn't resolvable from the test root — assert by shape instead. */
function expectHttpsError(err: unknown): void {
  expect(err).toBeInstanceOf(Error);
  expect((err as { code?: string }).code).toBeTruthy();
}

function makeCtx(overrides: Partial<StaffContext>): StaffContext {
  return {
    uid: "uid1",
    profile: {} as StaffContext["profile"],
    permissions: [],
    rolePrimary: "representative",
    companyId: null,
    isPlatformAdmin: false,
    ...overrides,
  };
}

describe("resolveActingCompanyId", () => {
  it("uses the caller's assigned company when not a platform admin", () => {
    const ctx = makeCtx({ companyId: "companyA" });
    expect(resolveActingCompanyId(ctx, null)).toBe("companyA");
  });

  it("rejects cross-company requests from non-admin staff", () => {
    const ctx = makeCtx({ companyId: "companyA" });
    try {
      resolveActingCompanyId(ctx, "companyB");
      expect.unreachable("expected resolveActingCompanyId to throw");
    } catch (err) {
      expectHttpsError(err);
    }
  });

  it("throws when a non-admin staff user has no company assignment", () => {
    const ctx = makeCtx({ companyId: null });
    try {
      resolveActingCompanyId(ctx, null);
      expect.unreachable("expected resolveActingCompanyId to throw");
    } catch (err) {
      expectHttpsError(err);
    }
  });

  it("lets a platform admin pass an explicit companyId", () => {
    const ctx = makeCtx({ isPlatformAdmin: true, companyId: null });
    expect(resolveActingCompanyId(ctx, "companyB")).toBe("companyB");
  });

  it("falls back to the admin's own companyId when none is requested", () => {
    const ctx = makeCtx({ isPlatformAdmin: true, companyId: "companyA" });
    expect(resolveActingCompanyId(ctx, null)).toBe("companyA");
  });

  it("requires a companyId for platform admins with none assigned or requested", () => {
    const ctx = makeCtx({ isPlatformAdmin: true, companyId: null });
    try {
      resolveActingCompanyId(ctx, null);
      expect.unreachable("expected resolveActingCompanyId to throw");
    } catch (err) {
      expectHttpsError(err);
    }
  });
});

describe("assertSessionCompanyAccess", () => {
  it("allows platform admins to access any session", async () => {
    const ctx = makeCtx({ isPlatformAdmin: true });
    await expect(
      assertSessionCompanyAccess(ctx, {
        representativeId: "someoneElse",
        companyId: "companyB",
      }),
    ).resolves.toBeUndefined();
  });

  it("allows a manager with sessions:read_company to read sessions in their company", async () => {
    const ctx = makeCtx({
      companyId: "companyA",
      permissions: [PERMISSIONS.SESSIONS_READ_COMPANY],
    });
    await expect(
      assertSessionCompanyAccess(ctx, {
        representativeId: "otherRep",
        companyId: "companyA",
      }),
    ).resolves.toBeUndefined();
  });

  it("blocks a manager with sessions:read_company from another company", async () => {
    const ctx = makeCtx({
      companyId: "companyA",
      permissions: [PERMISSIONS.SESSIONS_READ_COMPANY],
    });
    try {
      await assertSessionCompanyAccess(ctx, {
        representativeId: "otherRep",
        companyId: "companyB",
      });
      expect.unreachable("expected assertSessionCompanyAccess to throw");
    } catch (err) {
      expectHttpsError(err);
    }
  });

  it("allows a representative with sessions:read_own to read only their own session", async () => {
    const ctx = makeCtx({
      uid: "repA",
      companyId: "companyA",
      permissions: [PERMISSIONS.SESSIONS_READ_OWN],
    });
    await expect(
      assertSessionCompanyAccess(ctx, {
        representativeId: "repA",
        companyId: "companyA",
      }),
    ).resolves.toBeUndefined();
    try {
      await assertSessionCompanyAccess(ctx, {
        representativeId: "repB",
        companyId: "companyA",
      });
      expect.unreachable("expected assertSessionCompanyAccess to throw");
    } catch (err) {
      expectHttpsError(err);
    }
  });

  it("blocks staff with neither read permission", async () => {
    const ctx = makeCtx({ companyId: "companyA", permissions: [] });
    try {
      await assertSessionCompanyAccess(ctx, {
        representativeId: "repA",
        companyId: "companyA",
      });
      expect.unreachable("expected assertSessionCompanyAccess to throw");
    } catch (err) {
      expectHttpsError(err);
    }
  });
});
