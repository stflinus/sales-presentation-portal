/**
 * CalendarService abstraction — Google is Phase 1; Outlook-ready later.
 * Dashboard business logic must depend on this interface only.
 */

export type CalendarProviderId = "google" | "microsoft";

export interface CalendarConnectionPublicStatus {
  connected: boolean;
  provider: CalendarProviderId | null;
  email: string | null;
  needsReconnect: boolean;
  /** Never include tokens. */
}

export interface CalendarEventView {
  id: string;
  summary: string;
  start: string | null;
  end: string | null;
  htmlLink: string | null;
}

export interface ListEventsInput {
  timeMin: string;
  timeMax: string;
  maxResults?: number;
}

export interface CalendarProvider {
  readonly id: CalendarProviderId;
  getAuthUrl(state: string): string;
  exchangeCode(code: string): Promise<{
    accessToken: string;
    refreshToken: string | null;
    expiresAt: number;
    email: string | null;
    scope: string;
  }>;
  refreshAccessToken(refreshToken: string): Promise<{
    accessToken: string;
    expiresAt: number;
  }>;
  listEvents(
    accessToken: string,
    input: ListEventsInput,
  ): Promise<CalendarEventView[]>;
  revoke?(accessToken: string): Promise<void>;
}

export interface CalendarService {
  getProvider(id: CalendarProviderId): CalendarProvider;
  /** Phase 1 default provider. */
  defaultProvider(): CalendarProvider;
}

export class DefaultCalendarService implements CalendarService {
  constructor(private readonly providers: Map<CalendarProviderId, CalendarProvider>) {}

  getProvider(id: CalendarProviderId): CalendarProvider {
    const p = this.providers.get(id);
    if (!p) throw new Error(`Calendar provider not registered: ${id}`);
    return p;
  }

  defaultProvider(): CalendarProvider {
    return this.getProvider("google");
  }
}
