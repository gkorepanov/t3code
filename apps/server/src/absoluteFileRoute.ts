const LINE_COLUMN_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;
const WINDOWS_DRIVE_PATH_PATTERN = /^\/?[A-Za-z]:[\\/]/;
const FILE_ROUTE_PREFIX = "/file";

export type AbsoluteFileRouteMatch =
  | { readonly kind: "unmatched" }
  | { readonly kind: "invalid" }
  | { readonly kind: "matched"; readonly filePath: string };

function normalizeAbsoluteFilePath(pathname: string): string {
  return pathname.startsWith("/") && WINDOWS_DRIVE_PATH_PATTERN.test(pathname)
    ? pathname.slice(1)
    : pathname;
}

export function matchAbsoluteFileRoute(
  pathname: string,
  method: string | undefined,
): AbsoluteFileRouteMatch {
  if (method !== "GET" && method !== "HEAD") {
    return { kind: "unmatched" };
  }

  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {
    return { kind: "invalid" };
  }

  if (!decodedPathname.startsWith(`${FILE_ROUTE_PREFIX}/`)) {
    return { kind: "unmatched" };
  }

  const encodedFilePath = decodedPathname.slice(FILE_ROUTE_PREFIX.length);
  const hasPositionSuffix = LINE_COLUMN_SUFFIX_PATTERN.test(encodedFilePath);
  const filePath = normalizeAbsoluteFilePath(
    encodedFilePath.replace(LINE_COLUMN_SUFFIX_PATTERN, ""),
  );
  const segments = filePath.split(/[\\/]/).filter((segment) => segment.length > 0);
  const hasRelativeSegments = segments.some((segment) => segment === "." || segment === "..");
  const isAbsoluteFilePath = filePath.startsWith("/") || WINDOWS_DRIVE_PATH_PATTERN.test(filePath);

  if (!isAbsoluteFilePath || (!hasPositionSuffix && filePath.length === 0)) {
    return { kind: "invalid" };
  }

  if (filePath.includes("\0") || hasRelativeSegments) {
    return { kind: "invalid" };
  }

  return { kind: "matched", filePath };
}
