import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  collection,
  getDocs,
} from "firebase/firestore";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";

const PROJECT_ID = "spp-rules-test";

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync(resolve(__dirname, "../../firestore.rules"), "utf8"),
      host: "127.0.0.1",
      port: 8080,
    },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "companies/companyA"), {
      name: "Company A",
      status: "active",
    });
    await setDoc(doc(db, "companies/companyB"), {
      name: "Company B",
      status: "active",
    });
    await setDoc(doc(db, "presentationSessions/sessionA"), {
      representativeId: "repA",
      companyId: "companyA",
      clientName: "Client A",
      status: "opened",
    });
    await setDoc(doc(db, "presentationSessions/sessionB"), {
      representativeId: "repB",
      companyId: "companyA",
      clientName: "Client B",
      status: "opened",
    });
    await setDoc(doc(db, "presentationSessions/sessionC"), {
      representativeId: "repC",
      companyId: "companyB",
      clientName: "Client C",
      status: "opened",
    });
    await setDoc(doc(db, "invites/inviteA"), {
      createdBy: "repA",
      companyId: "companyA",
      sessionId: "sessionA",
    });
    await setDoc(doc(db, "followUps/followUpA"), {
      representativeId: "repA",
      companyId: "companyA",
      sessionId: "sessionA",
    });
    await setDoc(doc(db, "users/repA"), {
      email: "repa@example.com",
      companyId: "companyA",
      primaryRole: "representative",
    });
    await setDoc(doc(db, "legalAcceptances/acceptA"), {
      presentationSessionId: "sessionA",
      clientEmail: "a@example.com",
      companyId: "companyA",
      immutable: true,
    });
    await setDoc(doc(db, "legalEvidence/evidenceA"), {
      companyId: "companyA",
      contactName: "Contact A",
      contactEmail: "a@example.com",
      sessionId: "sessionA",
      invitationId: "inviteA",
      immutable: true,
    });
    await setDoc(doc(db, "legalEvidence/evidenceB"), {
      companyId: "companyB",
      contactName: "Contact C",
      contactEmail: "c@example.com",
      sessionId: "sessionC",
      invitationId: "inviteC",
      immutable: true,
    });
    await setDoc(doc(db, "auditEvents/event1"), {
      sessionId: "sessionA",
      type: "invitation_opened",
    });
    await setDoc(doc(db, "videos/videoA"), {
      title: "Video A",
      companyId: "companyA",
    });
    await setDoc(doc(db, "legalDocuments/legalA"), {
      type: "nda",
      companyId: "companyA",
    });
    await setDoc(doc(db, "contacts/contactA"), {
      displayName: "Contact A",
      email: "a@example.com",
      companyId: "companyA",
      ownerRepresentativeId: "repA",
      status: "lead",
    });
    await setDoc(doc(db, "contacts/contactB"), {
      displayName: "Contact B",
      email: "b@example.com",
      companyId: "companyA",
      ownerRepresentativeId: "repB",
      status: "lead",
    });
    await setDoc(doc(db, "contacts/contactC"), {
      displayName: "Contact C",
      email: "c@example.com",
      companyId: "companyB",
      ownerRepresentativeId: "repC",
      status: "lead",
    });
  });
});

function repAuth(uid: string, companyId = "companyA") {
  return testEnv.authenticatedContext(uid, {
    rolePrimary: "representative",
    companyId,
    permissions: ["dashboard:read", "sessions:read_own", "contacts:manage_own"],
  });
}

function managerAuth(uid: string, companyId: string) {
  return testEnv.authenticatedContext(uid, {
    rolePrimary: "manager",
    companyId,
    permissions: [
      "dashboard:read",
      "sessions:read_own",
      "sessions:read_company",
      "followups:read_company",
      "users:manage_company",
      "contacts:read_company",
      "contacts:manage_company",
      "legal_evidence:read_company",
    ],
  });
}

function adminAuth(uid: string) {
  return testEnv.authenticatedContext(uid, {
    rolePrimary: "administrator",
    companyId: null,
    permissions: [
      "dashboard:read",
      "admin:access",
      "companies:manage",
      "legal:manage",
      "videos:manage",
      "users:manage",
      "sessions:read_own",
      "sessions:read_company",
      "contacts:manage_all",
      "legal_evidence:read_all",
      "legal_evidence:export",
    ],
  });
}

function clientAuth(uid: string, sessionId: string) {
  return testEnv.authenticatedContext(uid, {
    rolePrimary: "client",
    sessionId,
    permissions: ["sessions:read_own", "legal:accept_own", "video:view_own"],
  });
}

describe("Firestore security rules", () => {
  it("Representative A cannot read Representative B session", async () => {
    const db = repAuth("repA").firestore();
    await assertFails(getDoc(doc(db, "presentationSessions/sessionB")));
    await assertSucceeds(getDoc(doc(db, "presentationSessions/sessionA")));
  });

  it("Representative cannot read a session belonging to another company", async () => {
    const db = repAuth("repA", "companyA").firestore();
    await assertFails(getDoc(doc(db, "presentationSessions/sessionC")));
  });

  it("Manager cannot read a session belonging to another company", async () => {
    const db = managerAuth("managerA", "companyA").firestore();
    await assertSucceeds(getDoc(doc(db, "presentationSessions/sessionA")));
    await assertFails(getDoc(doc(db, "presentationSessions/sessionC")));
  });

  it("Manager can read another representative's session within the same company", async () => {
    const db = managerAuth("managerA", "companyA").firestore();
    await assertSucceeds(getDoc(doc(db, "presentationSessions/sessionB")));
  });

  it("Client can read only their claimed session", async () => {
    const db = clientAuth("client_sessionA", "sessionA").firestore();
    await assertSucceeds(getDoc(doc(db, "presentationSessions/sessionA")));
    await assertFails(getDoc(doc(db, "presentationSessions/sessionB")));
  });

  it("Client remains restricted to its own session even across companies", async () => {
    const db = clientAuth("client_sessionA", "sessionA").firestore();
    await assertFails(getDoc(doc(db, "presentationSessions/sessionC")));
  });

  it("Client cannot read another client's legal acceptance", async () => {
    const db = clientAuth("client_sessionB", "sessionB").firestore();
    await assertFails(getDoc(doc(db, "legalAcceptances/acceptA")));
  });

  it("Client cannot edit audit logs", async () => {
    const db = clientAuth("client_sessionA", "sessionA").firestore();
    await assertFails(
      updateDoc(doc(db, "auditEvents/event1"), { type: "tampered" }),
    );
    await assertFails(
      setDoc(doc(db, "auditEvents/event2"), { type: "fake" }),
    );
  });

  it("Representative cannot edit immutable acceptance records", async () => {
    const db = repAuth("repA").firestore();
    await assertFails(
      updateDoc(doc(db, "legalAcceptances/acceptA"), { clientName: "Hacked" }),
    );
  });

  it("Representative cannot write videos or legal documents", async () => {
    const db = repAuth("repA").firestore();
    await assertFails(
      updateDoc(doc(db, "videos/videoA"), { title: "Hacked" }),
    );
    await assertFails(
      setDoc(doc(db, "videos/videoB"), { title: "Fake" }),
    );
    await assertFails(
      updateDoc(doc(db, "legalDocuments/legalA"), { type: "terms" }),
    );
    await assertFails(
      setDoc(doc(db, "legalDocuments/legalB"), { type: "terms" }),
    );
  });

  it("Direct client writes cannot mark a video completed", async () => {
    const db = clientAuth("client_sessionA", "sessionA").firestore();
    await assertFails(
      updateDoc(doc(db, "presentationSessions/sessionA"), {
        status: "completed",
        completionPercent: 100,
      }),
    );
  });

  it("Only non-SDK paths can transition privileged session state (SDK write denied)", async () => {
    const db = repAuth("repA").firestore();
    await assertFails(
      updateDoc(doc(db, "presentationSessions/sessionA"), {
        status: "in_progress",
      }),
    );
  });

  it("Clients cannot list or write viewing leases", async () => {
    const db = clientAuth("client_sessionA", "sessionA").firestore();
    await assertFails(getDoc(doc(db, "viewingLeases/sessionA")));
    await assertFails(
      setDoc(doc(db, "viewingLeases/sessionA"), { deviceId: "x" }),
    );
  });

  it("Unauthenticated users cannot browse sessions", async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDocs(collection(db, "presentationSessions")));
  });

  it("Platform admin can read all companies", async () => {
    const db = adminAuth("admin1").firestore();
    await assertSucceeds(getDoc(doc(db, "companies/companyA")));
    await assertSucceeds(getDoc(doc(db, "companies/companyB")));
  });

  it("Staff can read their own company but not another company", async () => {
    const db = repAuth("repA", "companyA").firestore();
    await assertSucceeds(getDoc(doc(db, "companies/companyA")));
    await assertFails(getDoc(doc(db, "companies/companyB")));
  });

  it("Manager can read followups within their company but not another company", async () => {
    const db = managerAuth("managerA", "companyA").firestore();
    await assertSucceeds(getDoc(doc(db, "followUps/followUpA")));
  });

  it("Manager can read invites within their company", async () => {
    const db = managerAuth("managerA", "companyA").firestore();
    await assertSucceeds(getDoc(doc(db, "invites/inviteA")));
  });

  it("Manager can read users within their company but not read arbitrary users", async () => {
    const db = managerAuth("managerA", "companyA").firestore();
    await assertSucceeds(getDoc(doc(db, "users/repA")));
  });

  it("Representative only sees own contacts", async () => {
    const db = repAuth("repA").firestore();
    await assertSucceeds(getDoc(doc(db, "contacts/contactA")));
    await assertFails(getDoc(doc(db, "contacts/contactB")));
    await assertFails(getDoc(doc(db, "contacts/contactC")));
  });

  it("Manager sees all contacts in company but not another company", async () => {
    const db = managerAuth("managerA", "companyA").firestore();
    await assertSucceeds(getDoc(doc(db, "contacts/contactA")));
    await assertSucceeds(getDoc(doc(db, "contacts/contactB")));
    await assertFails(getDoc(doc(db, "contacts/contactC")));
  });

  it("Administrator sees all contacts", async () => {
    const db = adminAuth("admin1").firestore();
    await assertSucceeds(getDoc(doc(db, "contacts/contactA")));
    await assertSucceeds(getDoc(doc(db, "contacts/contactC")));
  });

  it("Representatives cannot write contacts via SDK", async () => {
    const db = repAuth("repA").firestore();
    await assertFails(
      updateDoc(doc(db, "contacts/contactA"), { displayName: "Hacked" }),
    );
  });

  it("Representatives cannot read Legal Evidence or acceptance hashes", async () => {
    const db = repAuth("repA").firestore();
    await assertFails(getDoc(doc(db, "legalEvidence/evidenceA")));
    await assertFails(getDoc(doc(db, "legalAcceptances/acceptA")));
  });

  it("Managers can read company Legal Evidence but not another company", async () => {
    const db = managerAuth("managerA", "companyA").firestore();
    await assertSucceeds(getDoc(doc(db, "legalEvidence/evidenceA")));
    await assertFails(getDoc(doc(db, "legalEvidence/evidenceB")));
  });

  it("Platform admin can read all Legal Evidence; SDK cannot modify it", async () => {
    const db = adminAuth("admin1").firestore();
    await assertSucceeds(getDoc(doc(db, "legalEvidence/evidenceA")));
    await assertSucceeds(getDoc(doc(db, "legalEvidence/evidenceB")));
    await assertFails(
      updateDoc(doc(db, "legalEvidence/evidenceA"), { contactName: "Tampered" }),
    );
  });

  it("Calendar connection tokens are never readable or writable via client SDK", async () => {
    const db = repAuth("repA").firestore();
    await assertFails(getDoc(doc(db, "calendarConnections/repA")));
    await assertFails(
      setDoc(doc(db, "calendarConnections/repA"), {
        encryptedAccessToken: "secret",
        encryptedRefreshToken: "secret",
      }),
    );
    const other = repAuth("repB").firestore();
    await assertFails(getDoc(doc(db, "calendarConnections/repA")));
  });

  it("Representative cannot read another representative's presentation session", async () => {
    const db = repAuth("repB").firestore();
    await assertFails(getDoc(doc(db, "presentationSessions/sessionA")));
  });

  it("Manager cannot read presentations outside company", async () => {
    const db = managerAuth("managerA", "companyA").firestore();
    await assertFails(getDoc(doc(db, "presentationSessions/sessionC")));
  });
});
