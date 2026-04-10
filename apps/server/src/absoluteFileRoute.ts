import type http from "node:http";

import Mime from "@effect/platform-node/Mime";
import { Effect, Exit, FileSystem, Stream } from "effect";

const LINE_COLUMN_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;
const WINDOWS_DRIVE_PATH_PATTERN = /^\/?[A-Za-z]:[\\/]/;
const POSIX_FILE_ROOT_PREFIXES = [
  "/Users/",
  "/home/",
  "/tmp/",
  "/var/",
  "/etc/",
  "/opt/",
  "/mnt/",
  "/Volumes/",
  "/private/",
  "/root/",
  "/srv/",
  "/usr/",
] as const;

export type AbsoluteFileRouteMatch =
  | { readonly kind: "unmatched" }
  | { readonly kind: "invalid" }
  | { readonly kind: "matched"; readonly filePath: string };

type AbsoluteFileRouteResponder = (
  statusCode: number,
  headers: Record<string, string>,
  body?: string | Uint8Array,
) => void;

function looksLikePosixAbsoluteFilePath(pathname: string, hasPositionSuffix: boolean): boolean {
  if (!pathname.startsWith("/")) return false;
  if (POSIX_FILE_ROOT_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;
  if (hasPositionSuffix) return true;
  const basename = pathname.slice(pathname.lastIndexOf("/") + 1);
  return basename.startsWith(".") || /\.[A-Za-z0-9_-]+$/.test(basename);
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

  const hasPositionSuffix = LINE_COLUMN_SUFFIX_PATTERN.test(decodedPathname);
  const filePath = decodedPathname.replace(LINE_COLUMN_SUFFIX_PATTERN, "");
  const segments = filePath.split(/[\\/]/).filter((segment) => segment.length > 0);
  const hasRelativeSegments = segments.some((segment) => segment === "." || segment === "..");
  const isAbsoluteFilePath =
    looksLikePosixAbsoluteFilePath(filePath, hasPositionSuffix) ||
    WINDOWS_DRIVE_PATH_PATTERN.test(filePath);

  if (!isAbsoluteFilePath) {
    return { kind: "unmatched" };
  }

  if (filePath.includes("\0") || hasRelativeSegments) {
    return { kind: "invalid" };
  }

  return { kind: "matched", filePath };
}

export function serveAbsoluteFileRoute(
  match: AbsoluteFileRouteMatch,
  {
    fileSystem,
    method,
    res,
    respond,
  }: {
    fileSystem: FileSystem.FileSystem;
    method: string | undefined;
    res: http.ServerResponse;
    respond: AbsoluteFileRouteResponder;
  },
): Effect.Effect<boolean> {
  if (match.kind !== "matched") {
    return Effect.succeed(false);
  }

  return Effect.gen(function* () {
    const fileInfo = yield* fileSystem
      .stat(match.filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!fileInfo || fileInfo.type !== "File") {
      respond(404, { "Content-Type": "text/plain" }, "Not Found");
      return true;
    }

    const contentType = Mime.getType(match.filePath) ?? "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    });
    if (method === "HEAD") {
      res.end();
      return true;
    }

    const streamExit = yield* Stream.runForEach(fileSystem.stream(match.filePath), (chunk) =>
      Effect.sync(() => {
        if (!res.destroyed) {
          res.write(chunk);
        }
      }),
    ).pipe(Effect.exit);
    if (Exit.isFailure(streamExit)) {
      if (!res.destroyed) {
        res.destroy();
      }
      return true;
    }

    if (!res.writableEnded) {
      res.end();
    }
    return true;
  });
}
