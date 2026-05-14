import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS client_orchestration_commands (
      id TEXT PRIMARY KEY,
      command_id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL,
      command_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      result_sequence INTEGER,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_client_orchestration_commands_session_created
    ON client_orchestration_commands(session_id, created_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_client_orchestration_commands_status_updated
    ON client_orchestration_commands(status, updated_at)
  `;
});
