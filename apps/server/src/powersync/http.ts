import {
  ClientOrchestrationCommand,
  type CommandId,
  type PowerSyncCredentialsResult,
  type PowerSyncJwksResult,
  PowerSyncUploadInput,
  type PowerSyncUploadResult,
} from "@t3tools/contracts";
import * as Crypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { SignJWT } from "jose";

import { respondToAuthError } from "../auth/http.ts";
import { AuthError, type AuthenticatedSession, ServerAuth } from "../auth/Services/ServerAuth.ts";
import { ServerConfig } from "../config.ts";
import { normalizeDispatchCommand } from "../orchestration/Normalizer.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";

const POWERSYNC_JWT_KID = "t3code-powersync-rs256";
const POWERSYNC_TOKEN_TTL_SECONDS = 55 * 60;
const RUNNING_COMMAND_STALE_MS = 60_000;
const CLIENT_COMMAND_TABLE = "client_orchestration_commands";

const ClientCommandRow = Schema.Struct({
  id: Schema.String,
  commandId: Schema.String,
  commandJson: Schema.String,
  status: Schema.String,
  resultSequence: Schema.NullOr(Schema.Number),
  error: Schema.NullOr(Schema.String),
});
type ClientCommandRow = typeof ClientCommandRow.Type;

const decodeClientCommand = Schema.decodeUnknownEffect(ClientOrchestrationCommand);

function powerSyncSqlError(operation: string, cause: unknown): AuthError {
  return new AuthError({
    message: `PowerSync ${operation} failed.`,
    status: 500,
    cause,
  });
}

function requirePowerSyncConfig(config: {
  readonly powerSyncUrl?: string | undefined;
  readonly powerSyncJwtPrivateKey?: string | undefined;
}) {
  if (!config.powerSyncUrl || !config.powerSyncJwtPrivateKey) {
    return Effect.fail(
      new AuthError({
        message: "PowerSync is not configured for this server.",
        status: 500,
      }),
    );
  }
  return Effect.succeed({
    powerSyncUrl: config.powerSyncUrl,
    powerSyncJwtPrivateKey: normalizePem(config.powerSyncJwtPrivateKey),
  });
}

const authenticateOwnerSession = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* ServerAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request);
  if (session.role !== "owner") {
    return yield* new AuthError({
      message: "Only owner sessions can use remote PowerSync.",
      status: 403,
    });
  }
  return session;
});

function normalizePem(input: string): string {
  return input.includes("\\n") ? input.replaceAll("\\n", "\n") : input;
}

function toIso(input: DateTime.DateTime): string {
  return DateTime.formatIso(DateTime.toUtc(input));
}

function createPowerSyncPrivateKey(privateKeyPem: string) {
  return Effect.try({
    try: () => Crypto.createPrivateKey(privateKeyPem),
    catch: (cause) =>
      new AuthError({
        message: "Invalid PowerSync RS256 private key.",
        status: 500,
        cause,
      }),
  });
}

function createPowerSyncPublicJwk(privateKeyPem: string) {
  return Effect.try({
    try: () => {
      const jwk = Crypto.createPublicKey(privateKeyPem).export({ format: "jwk" });
      if (jwk.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.e !== "string") {
        throw new Error("PowerSync signing key must be an RSA key.");
      }
      return {
        kty: "RSA",
        alg: "RS256",
        kid: POWERSYNC_JWT_KID,
        n: jwk.n,
        e: jwk.e,
      } satisfies PowerSyncJwksResult["keys"][number];
    },
    catch: (cause) =>
      new AuthError({
        message: "Failed to derive PowerSync RS256 public JWK.",
        status: 500,
        cause,
      }),
  });
}

function parseCommandJson(commandJson: string) {
  return Effect.try({
    try: () => JSON.parse(commandJson) as unknown,
    catch: (cause) =>
      new AuthError({
        message: "Invalid PowerSync orchestration command JSON.",
        status: 400,
        cause,
      }),
  }).pipe(
    Effect.flatMap((raw) =>
      decodeClientCommand(raw).pipe(
        Effect.mapError(
          (cause) =>
            new AuthError({
              message: "Invalid PowerSync orchestration command payload.",
              status: 400,
              cause,
            }),
        ),
      ),
    ),
  );
}

const readClientCommandRow = (
  sql: SqlClient.SqlClient,
  id: string,
): Effect.Effect<ClientCommandRow | null, AuthError> =>
  sql<ClientCommandRow>`
    SELECT
      id,
      command_id AS "commandId",
      command_json AS "commandJson",
      status,
      result_sequence AS "resultSequence",
      error
    FROM client_orchestration_commands
    WHERE id = ${id}
    LIMIT 1
  `.pipe(
    Effect.map((rows) => rows[0] ?? null),
    Effect.mapError((cause) => powerSyncSqlError("read command row", cause)),
  );

const claimClientCommandRow = (
  sql: SqlClient.SqlClient,
  id: string,
  now: string,
  staleBefore: string,
): Effect.Effect<ClientCommandRow | null, AuthError> =>
  sql<ClientCommandRow>`
    UPDATE client_orchestration_commands
    SET status = 'running',
        updated_at = ${now}
    WHERE id = ${id}
      AND (
        status = 'pending'
        OR (status = 'running' AND updated_at < ${staleBefore})
      )
    RETURNING
      id,
      command_id AS "commandId",
      command_json AS "commandJson",
      status,
      result_sequence AS "resultSequence",
      error
  `.pipe(
    Effect.map((rows) => rows[0] ?? null),
    Effect.mapError((cause) => powerSyncSqlError("claim command row", cause)),
  );

const markClientCommandAccepted = (
  sql: SqlClient.SqlClient,
  input: {
    readonly id: string;
    readonly resultSequence: number;
    readonly updatedAt: string;
  },
) =>
  sql`
    UPDATE client_orchestration_commands
    SET status = 'accepted',
        result_sequence = ${input.resultSequence},
        error = NULL,
        updated_at = ${input.updatedAt}
    WHERE id = ${input.id}
  `.pipe(Effect.mapError((cause) => powerSyncSqlError("mark command accepted", cause)));

const markClientCommandRejected = (
  sql: SqlClient.SqlClient,
  input: {
    readonly id: string;
    readonly error: string;
    readonly updatedAt: string;
  },
) =>
  sql`
    UPDATE client_orchestration_commands
    SET status = 'rejected',
        error = ${input.error},
        updated_at = ${input.updatedAt}
    WHERE id = ${input.id}
  `.pipe(Effect.mapError((cause) => powerSyncSqlError("mark command rejected", cause)));

function insertClientCommandRow(input: {
  readonly sql: SqlClient.SqlClient;
  readonly session: AuthenticatedSession;
  readonly id: string;
  readonly data: Record<string, unknown>;
  readonly now: string;
}) {
  const commandJson =
    typeof input.data.command_json === "string"
      ? input.data.command_json
      : JSON.stringify(input.data.command_json);
  return Effect.gen(function* () {
    const command = yield* parseCommandJson(commandJson);
    const createdAt =
      typeof input.data.created_at === "string" && input.data.created_at.length > 0
        ? input.data.created_at
        : input.now;

    yield* input.sql`
      INSERT INTO client_orchestration_commands (
        id,
        command_id,
        session_id,
        command_json,
        status,
        created_at,
        updated_at
      )
      VALUES (
        ${input.id},
        ${command.commandId},
        ${input.session.sessionId},
        ${commandJson},
        'pending',
        ${createdAt},
        ${input.now}
      )
      ON CONFLICT (id) DO NOTHING
    `.pipe(Effect.mapError((cause) => powerSyncSqlError("insert command row", cause)));

    return command.commandId;
  });
}

function processClientCommandRow(input: {
  readonly sql: SqlClient.SqlClient;
  readonly row: ClientCommandRow;
  readonly now: string;
}) {
  return Effect.gen(function* () {
    if (input.row.status === "accepted") {
      return input.row.commandId as CommandId;
    }
    if (input.row.status === "rejected") {
      return input.row.commandId as CommandId;
    }

    const command = yield* parseCommandJson(input.row.commandJson);
    const orchestrationEngine = yield* OrchestrationEngineService;
    const normalizedCommand = yield* normalizeDispatchCommand(command).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Failed to normalize PowerSync orchestration command.",
            status: 400,
            cause,
          }),
      ),
    );
    const result = yield* orchestrationEngine.dispatch(normalizedCommand).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: cause instanceof Error ? cause.message : "PowerSync command dispatch failed.",
            status: 400,
            cause,
          }),
      ),
    );
    yield* markClientCommandAccepted(input.sql, {
      id: input.row.id,
      resultSequence: result.sequence,
      updatedAt: input.now,
    });
    return command.commandId;
  }).pipe(
    Effect.catchTag("AuthError", (error) =>
      markClientCommandRejected(input.sql, {
        id: input.row.id,
        error: error.message,
        updatedAt: input.now,
      }).pipe(Effect.as(input.row.commandId as CommandId)),
    ),
  );
}

export const powerSyncCredentialsRouteLayer = HttpRouter.add(
  "GET",
  "/api/powersync/credentials",
  Effect.gen(function* () {
    const session = yield* authenticateOwnerSession;
    const config = yield* ServerConfig;
    const powerSync = yield* requirePowerSyncConfig(config);
    const issuedAt = yield* DateTime.now;
    const expiresAt = DateTime.addDuration(issuedAt, Duration.seconds(POWERSYNC_TOKEN_TTL_SECONDS));
    const issuer = config.powerSyncJwtIssuer ?? "t3code";
    const audience = config.powerSyncJwtAudience ?? "powersync";
    const privateKey = yield* createPowerSyncPrivateKey(powerSync.powerSyncJwtPrivateKey);
    const token = yield* Effect.promise(() =>
      new SignJWT({
        role: session.role,
        session_id: session.sessionId,
      })
        .setProtectedHeader({ alg: "RS256", kid: POWERSYNC_JWT_KID })
        .setSubject(session.subject)
        .setIssuer(issuer)
        .setAudience(audience)
        .setIssuedAt(Math.floor(DateTime.toEpochMillis(issuedAt) / 1000))
        .setExpirationTime(Math.floor(DateTime.toEpochMillis(expiresAt) / 1000))
        .sign(privateKey),
    );

    return HttpServerResponse.jsonUnsafe(
      {
        endpoint: powerSync.powerSyncUrl,
        token,
        expiresAt: toIso(expiresAt),
      } satisfies PowerSyncCredentialsResult,
      { status: 200 },
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const powerSyncJwksRouteLayer = HttpRouter.add(
  "GET",
  "/api/powersync/jwks",
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const powerSync = yield* requirePowerSyncConfig(config);
    const jwk = yield* createPowerSyncPublicJwk(powerSync.powerSyncJwtPrivateKey);
    return HttpServerResponse.jsonUnsafe(
      {
        keys: [jwk],
      } satisfies PowerSyncJwksResult,
      { status: 200 },
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const powerSyncUploadRouteLayer = HttpRouter.add(
  "POST",
  "/api/powersync/upload",
  Effect.gen(function* () {
    const session = yield* authenticateOwnerSession;
    const sql = yield* SqlClient.SqlClient;
    const input = yield* HttpServerRequest.schemaBodyJson(PowerSyncUploadInput).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Invalid PowerSync upload payload.",
            status: 400,
            cause,
          }),
      ),
    );

    const acceptedCommandIds: Array<CommandId> = [];
    for (const entry of input.batch) {
      if (entry.table !== CLIENT_COMMAND_TABLE) {
        return yield* new AuthError({
          message: `PowerSync writes to ${entry.table} are not allowed.`,
          status: 400,
        });
      }
      if (entry.op === "DELETE") {
        return yield* new AuthError({
          message: "PowerSync command deletion is not allowed.",
          status: 400,
        });
      }

      const data = entry.data ?? {};
      const nowDateTime = yield* DateTime.now;
      const now = toIso(nowDateTime);
      const staleBefore = toIso(
        DateTime.subtractDuration(nowDateTime, Duration.millis(RUNNING_COMMAND_STALE_MS)),
      );
      const commandId = yield* insertClientCommandRow({
        sql,
        session,
        id: entry.id,
        data,
        now,
      });
      const claimed =
        (yield* claimClientCommandRow(sql, entry.id, now, staleBefore)) ??
        (yield* readClientCommandRow(sql, entry.id));
      if (!claimed) {
        return yield* new AuthError({
          message: "PowerSync command row disappeared during upload.",
          status: 500,
        });
      }
      if (claimed.commandId !== commandId) {
        return yield* new AuthError({
          message: "PowerSync command id does not match the existing command row.",
          status: 400,
        });
      }
      const acceptedCommandId = yield* processClientCommandRow({ sql, row: claimed, now });
      acceptedCommandIds.push(acceptedCommandId);
    }

    return HttpServerResponse.jsonUnsafe(
      {
        acceptedCommandIds,
      } satisfies PowerSyncUploadResult,
      { status: 200 },
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);
