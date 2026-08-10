export interface ClientEnvironment {
  browser: string;
  browserVersion: string;
  operatingSystem: string;
  deviceType: string;
  userAgent: string;
}

export function parseUserAgent(userAgent: string): ClientEnvironment {
  const ua = userAgent || "unknown";
  let browser = "Unknown";
  let browserVersion = "";
  if (/Edg\/([\d.]+)/i.test(ua)) {
    browser = "Edge";
    browserVersion = RegExp.$1 || "";
  } else if (/Chrome\/([\d.]+)/i.test(ua)) {
    browser = "Chrome";
    browserVersion = RegExp.$1 || "";
  } else if (/Firefox\/([\d.]+)/i.test(ua)) {
    browser = "Firefox";
    browserVersion = RegExp.$1 || "";
  } else if (/Version\/([\d.]+).*Safari/i.test(ua)) {
    browser = "Safari";
    browserVersion = RegExp.$1 || "";
  } else if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) {
    browser = "Safari";
  }

  let operatingSystem = "Unknown";
  if (/Windows/i.test(ua)) operatingSystem = "Windows";
  else if (/Mac OS X|Macintosh/i.test(ua)) operatingSystem = "macOS";
  else if (/Android/i.test(ua)) operatingSystem = "Android";
  else if (/iPhone|iPad|iOS/i.test(ua)) operatingSystem = "iOS";
  else if (/Linux/i.test(ua)) operatingSystem = "Linux";

  let deviceType = "desktop";
  if (/Mobi|Android.*Mobile|iPhone/i.test(ua)) deviceType = "mobile";
  else if (/iPad|Tablet/i.test(ua)) deviceType = "tablet";

  return {
    browser,
    browserVersion: browserVersion || "unknown",
    operatingSystem,
    deviceType,
    userAgent: ua,
  };
}

export function clientIpFromRequest(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) return "unknown";
  return raw.split(",")[0]?.trim() || "unknown";
}
