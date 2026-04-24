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
