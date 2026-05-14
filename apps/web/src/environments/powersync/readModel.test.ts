import type { PowerSyncDatabase } from "@powersync/web";
import { describe, expect, it } from "vitest";

import { readPowerSyncShellSnapshot, readPowerSyncThreadDetail } from "./readModel";

type Row = Record<string, unknown>;

interface TableRows {
  readonly projection_projects: Row[];
  readonly projection_threads: Row[];
  readonly projection_thread_messages: Row[];
  readonly projection_thread_activities: Row[];
  readonly projection_thread_sessions: Row[];
  readonly projection_turns: Row[];
  readonly projection_thread_proposed_plans: Row[];
  readonly projection_state: Row[];
}

function makePowerSyncDb(rows: TableRows): PowerSyncDatabase {
  const activeThreadRows = (archived: boolean) =>
    rows.projection_threads.filter(
      (row) =>
        row.deleted_at === null && (archived ? row.archived_at !== null : row.archived_at === null),
    );

  const latestTurnRows = (threadRows: Array<Record<string, unknown>>) =>
    threadRows.flatMap((thread) =>
      rows.projection_turns.filter(
        (turn) => turn.thread_id === thread.thread_id && turn.turn_id === thread.latest_turn_id,
      ),
    );

  const sessionRows = (threadRows: Array<Record<string, unknown>>) =>
    rows.projection_thread_sessions.filter((session) =>
      threadRows.some((thread) => thread.thread_id === session.thread_id),
    );

  const tx = {
    getAll: async <T>(query: string, params?: readonly unknown[]): Promise<T[]> => {
      const sql = query.replace(/\s+/g, " ");
      const archived = sql.includes("archived_at IS NOT NULL");
      const threadRows = activeThreadRows(archived);
      const threadId = params?.[0];

      if (sql.includes("FROM projection_projects")) return rows.projection_projects as T[];
      if (sql.includes("FROM projection_state")) return rows.projection_state as T[];
      if (sql.includes("FROM projection_thread_messages")) {
        return rows.projection_thread_messages.filter((row) => row.thread_id === threadId) as T[];
      }
      if (sql.includes("FROM projection_thread_proposed_plans")) {
        return rows.projection_thread_proposed_plans.filter(
          (row) => row.thread_id === threadId,
        ) as T[];
      }
      if (sql.includes("FROM projection_thread_activities")) {
        return rows.projection_thread_activities.filter((row) => row.thread_id === threadId) as T[];
      }
      if (sql.includes("FROM projection_turns WHERE")) {
        return rows.projection_turns.filter(
          (row) => row.thread_id === threadId && row.checkpoint_turn_count !== null,
        ) as T[];
      }
      if (sql.includes("FROM projection_thread_sessions sessions")) {
        return sessionRows(threadRows) as T[];
      }
      if (sql.includes("JOIN projection_turns")) {
        return latestTurnRows(
          threadId === undefined
            ? threadRows
            : rows.projection_threads.filter((row) => row.thread_id === threadId),
        ) as T[];
      }
      if (sql.includes("FROM projection_threads")) return threadRows as T[];
      return [];
    },
    getOptional: async <T>(query: string, params: readonly unknown[]): Promise<T | null> => {
      const sql = query.replace(/\s+/g, " ");
      const threadId = params[0];
      if (sql.includes("JOIN projection_turns")) {
        const thread = rows.projection_threads.find((row) => row.thread_id === threadId);
        return (
          (thread === undefined
            ? undefined
            : (rows.projection_turns.find(
                (row) =>
                  row.thread_id === thread.thread_id && row.turn_id === thread.latest_turn_id,
              ) as T | undefined)) ?? null
        );
      }
      if (sql.includes("FROM projection_threads")) {
        return (
          (rows.projection_threads.find(
            (row) =>
              row.thread_id === threadId && row.deleted_at === null && row.archived_at === null,
          ) as T | undefined) ?? null
        );
      }
      if (sql.includes("FROM projection_thread_sessions")) {
        return (
          (rows.projection_thread_sessions.find((row) => row.thread_id === threadId) as
            | T
            | undefined) ?? null
        );
      }
      return null;
    },
  };

  return {
    readTransaction: async <T>(fn: (transaction: typeof tx) => Promise<T>) => fn(tx),
  } as unknown as PowerSyncDatabase;
}

function makeRows(): TableRows {
  const stateRows = [
    "projection.projects",
    "projection.threads",
    "projection.thread-messages",
    "projection.thread-proposed-plans",
    "projection.thread-activities",
    "projection.thread-sessions",
    "projection.checkpoints",
  ].map((projector, index) => ({
    projector,
    last_applied_sequence: 100 + index,
    updated_at: "2026-05-13T00:00:00.000Z",
  }));

  return {
    projection_projects: [
      {
        project_id: "project-1",
        title: "Project One",
        workspace_root: "/repo/one",
        scripts_json: "[]",
        created_at: "2026-05-13T00:00:00.000Z",
        updated_at: "2026-05-13T00:00:00.000Z",
        deleted_at: null,
        default_model_selection_json: JSON.stringify({
          instanceId: "codex",
          model: "gpt-5-codex",
        }),
      },
      {
        project_id: "project-2",
        title: "Project Two",
        workspace_root: "/repo/two",
        scripts_json: "[]",
        created_at: "2026-05-13T00:00:00.000Z",
        updated_at: "2026-05-13T00:00:00.000Z",
        deleted_at: null,
        default_model_selection_json: null,
      },
    ],
    projection_threads: [
      {
        thread_id: "thread-1",
        project_id: "project-1",
        title: "Active Thread",
        branch: "main",
        worktree_path: "/repo/one",
        latest_turn_id: "turn-1",
        created_at: "2026-05-13T00:00:00.000Z",
        updated_at: "2026-05-13T00:00:10.000Z",
        deleted_at: null,
        runtime_mode: "full-access",
        interaction_mode: "default",
        model_selection_json: JSON.stringify({ instanceId: "codex", model: "gpt-5-codex" }),
        archived_at: null,
        latest_user_message_at: "2026-05-13T00:00:01.000Z",
        pending_approval_count: 0,
        pending_user_input_count: 0,
        has_actionable_proposed_plan: 1,
      },
      {
        thread_id: "thread-2",
        project_id: "project-2",
        title: "Archived Thread",
        branch: null,
        worktree_path: null,
        latest_turn_id: null,
        created_at: "2026-05-13T00:00:00.000Z",
        updated_at: "2026-05-13T00:00:05.000Z",
        deleted_at: null,
        runtime_mode: "full-access",
        interaction_mode: "default",
        model_selection_json: JSON.stringify({ instanceId: "codex", model: "gpt-5-codex" }),
        archived_at: "2026-05-13T00:01:00.000Z",
        latest_user_message_at: null,
        pending_approval_count: 0,
        pending_user_input_count: 0,
        has_actionable_proposed_plan: 0,
      },
    ],
    projection_thread_messages: [
      {
        message_id: "msg-1",
        thread_id: "thread-1",
        turn_id: "turn-1",
        role: "user",
        text: "hello",
        is_streaming: 0,
        created_at: "2026-05-13T00:00:01.000Z",
        updated_at: "2026-05-13T00:00:01.000Z",
        attachments_json: null,
      },
    ],
    projection_thread_activities: [
      {
        activity_id: "event-1",
        thread_id: "thread-1",
        turn_id: "turn-1",
        tone: "neutral",
        kind: "agent",
        summary: "Agent saw message",
        payload_json: "{}",
        created_at: "2026-05-13T00:00:02.000Z",
        sequence: 101,
      },
    ],
    projection_thread_sessions: [
      {
        thread_id: "thread-1",
        status: "running",
        provider_name: "codex",
        provider_session_id: "session-1",
        provider_thread_id: "provider-thread-1",
        active_turn_id: "turn-1",
        last_error: null,
        updated_at: "2026-05-13T00:00:02.000Z",
        runtime_mode: "full-access",
        provider_instance_id: "codex",
      },
    ],
    projection_turns: [
      {
        thread_id: "thread-1",
        turn_id: "turn-1",
        pending_message_id: "msg-1",
        assistant_message_id: "msg-2",
        state: "running",
        requested_at: "2026-05-13T00:00:01.000Z",
        started_at: "2026-05-13T00:00:02.000Z",
        completed_at: null,
        checkpoint_turn_count: null,
        checkpoint_ref: null,
        checkpoint_status: null,
        checkpoint_files_json: "[]",
        source_proposed_plan_thread_id: null,
        source_proposed_plan_id: null,
      },
      {
        thread_id: "thread-1",
        turn_id: "turn-0",
        pending_message_id: null,
        assistant_message_id: "msg-old",
        state: "completed",
        requested_at: "2026-05-12T00:00:00.000Z",
        started_at: "2026-05-12T00:00:01.000Z",
        completed_at: "2026-05-12T00:00:02.000Z",
        checkpoint_turn_count: 1,
        checkpoint_ref: "checkpoint-1",
        checkpoint_status: "captured",
        checkpoint_files_json: "[]",
        source_proposed_plan_thread_id: null,
        source_proposed_plan_id: null,
      },
    ],
    projection_thread_proposed_plans: [
      {
        plan_id: "plan-1",
        thread_id: "thread-1",
        turn_id: "turn-1",
        plan_markdown: "Do it",
        created_at: "2026-05-13T00:00:03.000Z",
        updated_at: "2026-05-13T00:00:03.000Z",
        implemented_at: null,
        implementation_thread_id: null,
      },
    ],
    projection_state: stateRows,
  };
}

describe("PowerSync read model", () => {
  it("reconstructs shell snapshots from synced local projection rows", async () => {
    const db = makePowerSyncDb(makeRows());

    await expect(readPowerSyncShellSnapshot(db)).resolves.toMatchObject({
      snapshotSequence: 100,
      projects: [{ id: "project-1" }, { id: "project-2" }],
      threads: [
        {
          id: "thread-1",
          title: "Active Thread",
          latestTurn: { turnId: "turn-1", state: "running" },
          session: { status: "running", activeTurnId: "turn-1" },
          hasActionableProposedPlan: true,
        },
      ],
    });

    await expect(readPowerSyncShellSnapshot(db, { archived: true })).resolves.toMatchObject({
      projects: [{ id: "project-2" }],
      threads: [{ id: "thread-2", archivedAt: "2026-05-13T00:01:00.000Z" }],
    });
  });

  it("reads final thread detail after a long offline gap applies multiple deltas", async () => {
    const rows = makeRows();
    const db = makePowerSyncDb(rows);

    rows.projection_thread_messages.push({
      message_id: "msg-2",
      thread_id: "thread-1",
      turn_id: "turn-1",
      role: "assistant",
      text: "synced after reconnect",
      is_streaming: 0,
      created_at: "2026-05-13T00:00:04.000Z",
      updated_at: "2026-05-13T00:00:04.000Z",
      attachments_json: null,
    });
    rows.projection_thread_sessions[0] = {
      ...rows.projection_thread_sessions[0]!,
      status: "ready",
      active_turn_id: null,
      updated_at: "2026-05-13T00:00:05.000Z",
    };
    rows.projection_turns[0] = {
      ...rows.projection_turns[0]!,
      state: "completed",
      completed_at: "2026-05-13T00:00:05.000Z",
    };

    await expect(readPowerSyncThreadDetail(db, "thread-1")).resolves.toMatchObject({
      id: "thread-1",
      latestTurn: { turnId: "turn-1", state: "completed" },
      session: { status: "ready", activeTurnId: null },
      messages: [
        { id: "msg-1", text: "hello" },
        { id: "msg-2", text: "synced after reconnect" },
      ],
      proposedPlans: [{ id: "plan-1" }],
      activities: [{ id: "event-1", summary: "Agent saw message" }],
      checkpoints: [{ checkpointRef: "checkpoint-1", status: "captured" }],
    });
  });
});
