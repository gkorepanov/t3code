const CLIPBOARD_WRITE_PERMISSION = "clipboard-sanitized-write";

export function shouldAllowDesktopPermissionRequest(permission: string, details: unknown): boolean {
  if (permission === CLIPBOARD_WRITE_PERMISSION) {
    return true;
  }
  return permission === "media" && shouldAllowMediaPermissionRequest(details);
}

export function shouldAllowMediaPermissionRequest(details: unknown): boolean {
  const mediaTypes =
    typeof details === "object" &&
    details !== null &&
    "mediaTypes" in details &&
    Array.isArray(details.mediaTypes)
      ? details.mediaTypes
      : null;
  return !mediaTypes || mediaTypes.length === 0 || mediaTypes.includes("audio");
}
