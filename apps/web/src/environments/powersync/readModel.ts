import type { PowerSyncDatabase } from "@powersync/web";
import {
  CheckpointRef,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import type {
  ChatAttachment,
  ModelSelection,
  OrchestrationCheckpointFile,
  OrchestrationCheckpointSummary,
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationProjectShell,
  OrchestrationProposedPlan,
  OrchestrationSession,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadActivity,
  OrchestrationThreadShell,
} from "@t3tools/contracts";

const REQUIRED_SNAPSHOT_PROJECTORS = [
  "projection.projects",
  "projection.threads",
  "projection.thread-messages",
  "projection.thread-proposed-plans",
  "projection.thread-activities",
  "projection.thread-sessions",
  "projection.checkpoints",
] as const;

interface ProjectionProjectRow {
  project_id: string;
  title: string;
  workspace_root: string;
  scripts_json: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  default_model_selection_json: string | null;
}

interface ProjectionThreadRow {
  thread_id: string;
  project_id: string;
  title: string;
  branch: string | null;
  worktree_path: string | null;
  latest_turn_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  runtime_mode: OrchestrationThread["runtimeMode"];
  interaction_mode: OrchestrationThread["interactionMode"];
  model_selection_json: string;
  archived_at: string | null;
  latest_user_message_at: string | null;
  pending_approval_count: number;
  pending_user_input_count: number;
  has_actionable_proposed_plan: number;
}

interface ProjectionMessageRow {
  message_id: string;
  thread_id: string;
  turn_id: string | null;
  role: OrchestrationMessage["role"];
  text: string;
  is_streaming: number;
  created_at: string;
  updated_at: string;
  attachments_json: string | null;
}

interface ProjectionActivityRow {
  activity_id: string;
  thread_id: string;
  turn_id: string | null;
  tone: OrchestrationThreadActivity["tone"];
  kind: string;
  summary: string;
  payload_json: string;
  created_at: string;
  sequence: number | null;
}

interface ProjectionSessionRow {
  thread_id: string;
  status: OrchestrationSession["status"];
  provider_name: string | null;
  active_turn_id: string | null;
  last_error: string | null;
  updated_at: string;
  runtime_mode: OrchestrationSession["runtimeMode"];
  provider_instance_id: string | null;
}

interface ProjectionTurnRow {
  thread_id: string;
  turn_id: string | null;
  state: string;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  assistant_message_id: string | null;
  checkpoint_turn_count: number | null;
  checkpoint_ref: string | null;
  checkpoint_status: OrchestrationCheckpointSummary["status"] | null;
  checkpoint_files_json: string;
  source_proposed_plan_thread_id: string | null;
  source_proposed_plan_id: string | null;
}

interface ProjectionProposedPlanRow {
  plan_id: string;
  thread_id: string;
  turn_id: string | null;
  plan_markdown: string;
  implemented_at: string | null;
  implementation_thread_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ProjectionStateRow {
  projector: string;
  last_applied_sequence: number;
  updated_at: string;
}

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

function parseNullableJson<T>(raw: string | null): T | null {
  return raw === null ? null : parseJson<T>(raw);
}

function optionalBrand<Value>(value: string | null, make: (value: string) => Value): Value | null {
  return value === null ? null : make(value);
}

function maxIso(left: string | null, right: string | null): string | null {
  if (right === null) return left;
  if (left === null) return right;
  return left > right ? left : right;
}

function computeSnapshotSequence(stateRows: ReadonlyArray<ProjectionStateRow>): number {
  if (stateRows.length === 0) {
    return 0;
  }
  const sequenceByProjector = new Map(
    stateRows.map((row) => [row.projector, row.last_applied_sequence] as const),
  );

  let minSequence = Number.POSITIVE_INFINITY;
  for (const projector of REQUIRED_SNAPSHOT_PROJECTORS) {
    const sequence = sequenceByProjector.get(projector);
    if (sequence === undefined) {
      return 0;
    }
    minSequence = Math.min(minSequence, sequence);
  }

  return Number.isFinite(minSequence) ? minSequence : 0;
}

function mapLatestTurn(row: ProjectionTurnRow): OrchestrationLatestTurn {
  return {
    turnId: TurnId.make(row.turn_id!),
    state:
      row.state === "error"
        ? "error"
        : row.state === "interrupted"
          ? "interrupted"
          : row.state === "completed"
            ? "completed"
            : "running",
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    assistantMessageId: optionalBrand(row.assistant_message_id, MessageId.make),
    ...(row.source_proposed_plan_thread_id !== null && row.source_proposed_plan_id !== null
      ? {
          sourceProposedPlan: {
            threadId: ThreadId.make(row.source_proposed_plan_thread_id),
            planId: row.source_proposed_plan_id,
          },
        }
      : {}),
  };
}

function mapSession(row: ProjectionSessionRow): OrchestrationSession {
  return {
    threadId: ThreadId.make(row.thread_id),
    status: row.status,
    providerName: row.provider_name,
    ...(row.provider_instance_id !== null
      ? { providerInstanceId: ProviderInstanceId.make(row.provider_instance_id) }
      : {}),
    runtimeMode: row.runtime_mode,
    activeTurnId: optionalBrand(row.active_turn_id, TurnId.make),
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

function mapProject(row: ProjectionProjectRow): OrchestrationProjectShell {
  return {
    id: ProjectId.make(row.project_id),
    title: row.title,
    workspaceRoot: row.workspace_root,
    repositoryIdentity: null,
    defaultModelSelection: parseNullableJson<ModelSelection>(row.default_model_selection_json),
    scripts: parseJson(row.scripts_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapThreadShell(input: {
  readonly row: ProjectionThreadRow;
  readonly latestTurn: OrchestrationLatestTurn | null;
  readonly session: OrchestrationSession | null;
}): OrchestrationThreadShell {
  return {
    id: ThreadId.make(input.row.thread_id),
    projectId: ProjectId.make(input.row.project_id),
    title: input.row.title,
    modelSelection: parseJson<ModelSelection>(input.row.model_selection_json),
    runtimeMode: input.row.runtime_mode,
    interactionMode: input.row.interaction_mode,
    branch: input.row.branch,
    worktreePath: input.row.worktree_path,
    latestTurn: input.latestTurn,
    createdAt: input.row.created_at,
    updatedAt: input.row.updated_at,
    archivedAt: input.row.archived_at,
    session: input.session,
    latestUserMessageAt: input.row.latest_user_message_at,
    hasPendingApprovals: input.row.pending_approval_count > 0,
    hasPendingUserInput: input.row.pending_user_input_count > 0,
    hasActionableProposedPlan: input.row.has_actionable_proposed_plan > 0,
  };
}

function mapProposedPlan(row: ProjectionProposedPlanRow): OrchestrationProposedPlan {
  return {
    id: row.plan_id,
    turnId: optionalBrand(row.turn_id, TurnId.make),
    planMarkdown: row.plan_markdown,
    implementedAt: row.implemented_at,
    implementationThreadId: optionalBrand(row.implementation_thread_id, ThreadId.make),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMessage(row: ProjectionMessageRow): OrchestrationMessage {
  return {
    id: MessageId.make(row.message_id),
    role: row.role,
    text: row.text,
    ...(row.attachments_json !== null
      ? { attachments: parseJson<ChatAttachment[]>(row.attachments_json) }
      : {}),
    turnId: optionalBrand(row.turn_id, TurnId.make),
    streaming: row.is_streaming === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapActivity(row: ProjectionActivityRow): OrchestrationThreadActivity {
  return {
    id: EventId.make(row.activity_id),
    tone: row.tone,
    kind: row.kind,
    summary: row.summary,
    payload: parseJson<unknown>(row.payload_json),
    turnId: optionalBrand(row.turn_id, TurnId.make),
    ...(row.sequence !== null ? { sequence: row.sequence } : {}),
    createdAt: row.created_at,
  };
}

function mapCheckpoint(row: ProjectionTurnRow): OrchestrationCheckpointSummary {
  return {
    turnId: TurnId.make(row.turn_id!),
    checkpointTurnCount: row.checkpoint_turn_count!,
    checkpointRef: CheckpointRef.make(row.checkpoint_ref!),
    status: row.checkpoint_status!,
    files: parseJson<OrchestrationCheckpointFile[]>(row.checkpoint_files_json),
    assistantMessageId: optionalBrand(row.assistant_message_id, MessageId.make),
    completedAt: row.completed_at!,
  };
}

export async function readPowerSyncShellSnapshot(
  db: PowerSyncDatabase,
  options?: { readonly archived?: boolean },
): Promise<OrchestrationShellSnapshot> {
  return db.readTransaction(async (tx) => {
    const archived = options?.archived === true;
    const [projectRows, threadRows, sessionRows, latestTurnRows, stateRows] = await Promise.all([
      tx.getAll<ProjectionProjectRow>(
        "SELECT * FROM projection_projects ORDER BY created_at ASC, project_id ASC",
      ),
      tx.getAll<ProjectionThreadRow>(
        archived
          ? `SELECT * FROM projection_threads
             WHERE deleted_at IS NULL AND archived_at IS NOT NULL
             ORDER BY project_id ASC, archived_at DESC, thread_id DESC`
          : `SELECT * FROM projection_threads
             WHERE deleted_at IS NULL AND archived_at IS NULL
             ORDER BY project_id ASC, created_at ASC, thread_id ASC`,
      ),
      tx.getAll<ProjectionSessionRow>(
        archived
          ? `SELECT sessions.*
             FROM projection_thread_sessions sessions
             INNER JOIN projection_threads threads ON threads.thread_id = sessions.thread_id
             WHERE threads.deleted_at IS NULL AND threads.archived_at IS NOT NULL
             ORDER BY sessions.thread_id ASC`
          : `SELECT sessions.*
             FROM projection_thread_sessions sessions
             INNER JOIN projection_threads threads ON threads.thread_id = sessions.thread_id
             WHERE threads.deleted_at IS NULL AND threads.archived_at IS NULL
             ORDER BY sessions.thread_id ASC`,
      ),
      tx.getAll<ProjectionTurnRow>(
        archived
          ? `SELECT turns.*
             FROM projection_threads threads
             JOIN projection_turns turns
               ON turns.thread_id = threads.thread_id
              AND turns.turn_id = threads.latest_turn_id
             WHERE threads.deleted_at IS NULL
               AND threads.archived_at IS NOT NULL
               AND threads.latest_turn_id IS NOT NULL
             ORDER BY turns.thread_id ASC`
          : `SELECT turns.*
             FROM projection_threads threads
             JOIN projection_turns turns
               ON turns.thread_id = threads.thread_id
              AND turns.turn_id = threads.latest_turn_id
             WHERE threads.deleted_at IS NULL
               AND threads.archived_at IS NULL
               AND threads.latest_turn_id IS NOT NULL
             ORDER BY turns.thread_id ASC`,
      ),
      tx.getAll<ProjectionStateRow>("SELECT * FROM projection_state"),
    ]);

    const latestTurnByThread = new Map(
      latestTurnRows.map((row) => [row.thread_id, mapLatestTurn(row)] as const),
    );
    const sessionByThread = new Map(sessionRows.map((row) => [row.thread_id, mapSession(row)]));
    const activeProjectIds = archived ? new Set(threadRows.map((row) => row.project_id)) : null;

    let updatedAt: string | null = null;
    for (const row of projectRows) updatedAt = maxIso(updatedAt, row.updated_at);
    for (const row of threadRows) updatedAt = maxIso(updatedAt, row.updated_at);
    for (const row of sessionRows) updatedAt = maxIso(updatedAt, row.updated_at);
    for (const row of latestTurnRows) {
      updatedAt = maxIso(
        maxIso(maxIso(updatedAt, row.requested_at), row.started_at),
        row.completed_at,
      );
    }
    for (const row of stateRows) updatedAt = maxIso(updatedAt, row.updated_at);

    return {
      snapshotSequence: computeSnapshotSequence(stateRows),
      projects: projectRows
        .filter(
          (row) =>
            row.deleted_at === null &&
            (activeProjectIds === null || activeProjectIds.has(row.project_id)),
        )
        .map(mapProject),
      threads: threadRows.map((row) =>
        mapThreadShell({
          row,
          latestTurn: latestTurnByThread.get(row.thread_id) ?? null,
          session: sessionByThread.get(row.thread_id) ?? null,
        }),
      ),
      updatedAt: updatedAt ?? "1970-01-01T00:00:00.000Z",
    };
  });
}

export async function readPowerSyncThreadDetail(
  db: PowerSyncDatabase,
  threadId: string,
): Promise<OrchestrationThread | null> {
  return db.readTransaction(async (tx) => {
    const threadRow = await tx.getOptional<ProjectionThreadRow>(
      `SELECT * FROM projection_threads
       WHERE thread_id = ? AND deleted_at IS NULL AND archived_at IS NULL
       LIMIT 1`,
      [threadId],
    );
    if (!threadRow) {
      return null;
    }

    const [messageRows, proposedPlanRows, activityRows, checkpointRows, latestTurnRow, sessionRow] =
      await Promise.all([
        tx.getAll<ProjectionMessageRow>(
          `SELECT * FROM projection_thread_messages
           WHERE thread_id = ?
           ORDER BY created_at ASC, message_id ASC`,
          [threadId],
        ),
        tx.getAll<ProjectionProposedPlanRow>(
          `SELECT * FROM projection_thread_proposed_plans
           WHERE thread_id = ?
           ORDER BY created_at ASC, plan_id ASC`,
          [threadId],
        ),
        tx.getAll<ProjectionActivityRow>(
          `SELECT * FROM projection_thread_activities
           WHERE thread_id = ?
           ORDER BY sequence ASC, created_at ASC, activity_id ASC`,
          [threadId],
        ),
        tx.getAll<ProjectionTurnRow>(
          `SELECT * FROM projection_turns
           WHERE thread_id = ? AND checkpoint_turn_count IS NOT NULL
           ORDER BY checkpoint_turn_count ASC`,
          [threadId],
        ),
        tx.getOptional<ProjectionTurnRow>(
          `SELECT turns.*
           FROM projection_threads threads
           JOIN projection_turns turns
             ON turns.thread_id = threads.thread_id
            AND turns.turn_id = threads.latest_turn_id
           WHERE threads.thread_id = ?
             AND threads.deleted_at IS NULL
             AND threads.archived_at IS NULL
           LIMIT 1`,
          [threadId],
        ),
        tx.getOptional<ProjectionSessionRow>(
          `SELECT * FROM projection_thread_sessions
           WHERE thread_id = ?
           LIMIT 1`,
          [threadId],
        ),
      ]);

    return {
      id: ThreadId.make(threadRow.thread_id),
      projectId: ProjectId.make(threadRow.project_id),
      title: threadRow.title,
      modelSelection: parseJson<ModelSelection>(threadRow.model_selection_json),
      runtimeMode: threadRow.runtime_mode,
      interactionMode: threadRow.interaction_mode,
      branch: threadRow.branch,
      worktreePath: threadRow.worktree_path,
      latestTurn: latestTurnRow ? mapLatestTurn(latestTurnRow) : null,
      createdAt: threadRow.created_at,
      updatedAt: threadRow.updated_at,
      archivedAt: threadRow.archived_at,
      deletedAt: null,
      messages: messageRows.map(mapMessage),
      proposedPlans: proposedPlanRows.map(mapProposedPlan),
      activities: activityRows.map(mapActivity),
      checkpoints: checkpointRows.map(mapCheckpoint),
      session: sessionRow ? mapSession(sessionRow) : null,
    };
  });
}
