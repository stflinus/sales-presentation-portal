import type { Permission } from "@spp/shared";

export function can(
  permissions: readonly string[] | undefined,
  permission: Permission,
): boolean {
  return Boolean(permissions?.includes(permission));
}
