const LINE_COLUMN_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;

export type AbsoluteFileRouteMatch =
  | { readonly kind: "unmatched" }
  | { readonly kind: "invalid" }
  | { readonly kind: "matched"; readonly filePath: string };

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

  const filePath = decodedPathname.replace(LINE_COLUMN_SUFFIX_PATTERN, "");
  const segments = filePath.split("/").filter((segment) => segment.length > 0);
  const hasRelativeSegments = segments.some((segment) => segment === "." || segment === "..");
  const isRootDotfile = segments.length === 1 && segments[0]!.startsWith(".");
  const isAbsoluteFilePath = filePath.startsWith("/") && (segments.length >= 2 || isRootDotfile);

  if (!isAbsoluteFilePath) {
    return { kind: "unmatched" };
  }

  if (filePath.includes("\0") || hasRelativeSegments) {
    return { kind: "invalid" };
  }

  return { kind: "matched", filePath };
}
