import * as Schema from "effect/Schema";

import { CommandId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PowerSyncCredentialsResult = Schema.Struct({
  endpoint: TrimmedNonEmptyString,
  token: TrimmedNonEmptyString,
  expiresAt: Schema.String,
});
export type PowerSyncCredentialsResult = typeof PowerSyncCredentialsResult.Type;

export const PowerSyncJwksResult = Schema.Struct({
  keys: Schema.Array(
    Schema.Struct({
      kty: Schema.Literal("RSA"),
      alg: Schema.Literal("RS256"),
      kid: TrimmedNonEmptyString,
      n: TrimmedNonEmptyString,
      e: TrimmedNonEmptyString,
    }),
  ),
});
export type PowerSyncJwksResult = typeof PowerSyncJwksResult.Type;

export const PowerSyncCrudOp = Schema.Literals(["PUT", "PATCH", "DELETE"]);
export type PowerSyncCrudOp = typeof PowerSyncCrudOp.Type;

export const PowerSyncCrudEntry = Schema.Struct({
  op: PowerSyncCrudOp,
  table: TrimmedNonEmptyString,
  id: TrimmedNonEmptyString,
  data: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export type PowerSyncCrudEntry = typeof PowerSyncCrudEntry.Type;

export const PowerSyncUploadInput = Schema.Struct({
  batch: Schema.Array(PowerSyncCrudEntry),
});
export type PowerSyncUploadInput = typeof PowerSyncUploadInput.Type;

export const PowerSyncUploadResult = Schema.Struct({
  acceptedCommandIds: Schema.Array(CommandId),
});
export type PowerSyncUploadResult = typeof PowerSyncUploadResult.Type;
