/**
 * @deprecated SMTP / App Password storage removed.
 * Invitation email uses Firebase Trigger Email (`mail/` queue).
 */
export async function saveCompanyAppPassword(
  _companyId: string,
  _appPassword: string,
): Promise<void> {
  throw new Error(
    "SMTP App Passwords are no longer used. Configure Firebase Trigger Email.",
  );
}

export async function loadCompanySmtpAuth(): Promise<null> {
  return null;
}

export function companyEmailIsConfigured(): boolean {
  return false;
}
