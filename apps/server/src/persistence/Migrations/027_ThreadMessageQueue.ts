import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_message_queue (
      queue_item_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      command_id TEXT NOT NULL UNIQUE,
      message_id TEXT NOT NULL UNIQUE,
      text TEXT NOT NULL,
      attachments_json TEXT NOT NULL,
      model_selection_json TEXT,
      title_seed TEXT,
      runtime_mode TEXT NOT NULL,
      interaction_mode TEXT NOT NULL,
      source_proposed_plan_thread_id TEXT,
      source_proposed_plan_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_message_queue_thread_created
    ON thread_message_queue(thread_id, created_at, queue_item_id)
  `;
});
