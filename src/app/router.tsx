import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "@/modules/auth/AuthProvider";
import { LoginPage } from "@/modules/auth/LoginPage";
import { RequireStaff } from "@/modules/auth/RequireStaff";
import { DashboardPage } from "@/modules/dashboard/DashboardPage";
import { SessionDetailPage } from "@/modules/dashboard/SessionDetailPage";
import { InviteLandingPage } from "@/modules/client/InviteLandingPage";
import { ClientPresentationPage } from "@/modules/client/ClientPresentationPage";
import { BootstrapPage } from "@/modules/admin/BootstrapPage";
import { NdaPage } from "@/modules/legal/nda/NdaPage";
import { TermsPage } from "@/modules/legal/terms/TermsPage";
import { PrivacyPage } from "@/modules/legal/privacy/PrivacyPage";

import { VideoLibraryPage } from "@/modules/admin/VideoLibraryPage";
import { CompaniesPage } from "@/modules/admin/CompaniesPage";
import { CompanyEmailPage } from "@/modules/admin/CompanyEmailPage";
import { UsersPage } from "@/modules/admin/UsersPage";
import { NotificationSettingsPage } from "@/modules/admin/NotificationSettingsPage";
import { LegalEvidenceVaultPage } from "@/modules/admin/LegalEvidenceVaultPage";

export function AppRouter() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Navigate to="/login" replace />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/bootstrap" element={<BootstrapPage />} />
          <Route path="/legal/nda" element={<NdaPage />} />
          <Route path="/legal/terms" element={<TermsPage />} />
          <Route path="/legal/privacy" element={<PrivacyPage />} />
          <Route path="/i/:token" element={<InviteLandingPage />} />
          <Route path="/p/:sessionId" element={<ClientPresentationPage />} />
          <Route element={<RequireStaff />}>
            <Route path="/app" element={<DashboardPage />} />
            <Route path="/app/videos" element={<VideoLibraryPage />} />
            <Route path="/app/companies" element={<CompaniesPage />} />
            <Route
              path="/app/companies/:companyId/email"
              element={<CompanyEmailPage />}
            />
            <Route path="/app/users" element={<UsersPage />} />
            {/* Contacts CRM UI removed in v0.1 — routes redirect to Dashboard */}
            <Route path="/app/contacts" element={<Navigate to="/app" replace />} />
            <Route
              path="/app/contacts/:contactId"
              element={<Navigate to="/app" replace />}
            />
            <Route path="/app/legal-evidence" element={<LegalEvidenceVaultPage />} />
            <Route path="/app/settings" element={<NotificationSettingsPage />} />
            <Route path="/app/sessions/:sessionId" element={<SessionDetailPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
