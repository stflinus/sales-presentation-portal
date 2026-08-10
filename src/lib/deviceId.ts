const KEY = "spp.deviceId";

export function getOrCreateDeviceId(): string {
  const existing = localStorage.getItem(KEY);
  if (existing && existing.length >= 8) return existing;
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `dev_${Math.random().toString(36).slice(2)}${Date.now()}`;
  localStorage.setItem(KEY, id);
  return id;
}
