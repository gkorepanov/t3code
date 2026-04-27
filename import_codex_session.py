#!/usr/bin/env python3
import argparse
import json
import os
import sqlite3
import subprocess
import sys
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path


DEFAULT_MODEL = "gpt-5.4"


@dataclass
class Message:
    role: str
    text: str
    created_at: str
    turn_id: str | None
    message_id: str = ""


@dataclass
class Turn:
    turn_id: str
    requested_at: str | None = None
    started_at: str | None = None
    completed_at: str | None = None
    state: str = "completed"
    assistant_message_id: str | None = None
    user_message_at: str | None = None
    last_message_at: str | None = None


@dataclass
class ParsedSession:
    codex_id: str
    source_path: Path
    title: str
    workspace_root: str
    created_at: str
    updated_at: str
    model: str
    messages: list[Message]
    turns: dict[str, Turn]


def dumps(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def read_jsonl(path: Path):
    with path.open("r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError as exc:
                raise RuntimeError(f"Invalid JSON at {path}:{line_no}: {exc}") from exc


def find_session_path(codex_home: Path, codex_id: str) -> Path:
    sessions_dir = codex_home / "sessions"
    if not sessions_dir.exists():
        raise FileNotFoundError(f"Codex sessions directory does not exist: {sessions_dir}")

    filename_matches = sorted(sessions_dir.rglob(f"*{codex_id}*.jsonl"))
    if filename_matches:
        return filename_matches[-1]

    for path in sorted(sessions_dir.rglob("*.jsonl")):
        try:
            first = next(read_jsonl(path))
        except (StopIteration, RuntimeError):
            continue
        payload = first.get("payload") or {}
        if (
            first.get("type") == "session_meta"
            and payload.get("id") == codex_id
        ) or (payload.get("type") == "session_meta" and payload.get("id") == codex_id):
            return path

    raise FileNotFoundError(f"Codex session was not found under {sessions_dir}: {codex_id}")


def title_from_index(codex_home: Path, codex_id: str) -> str | None:
    index_path = codex_home / "session_index.jsonl"
    if not index_path.exists():
        return None
    for row in read_jsonl(index_path):
        if row.get("id") == codex_id:
            title = (row.get("thread_name") or "").strip()
            return title or None
    return None


def text_from_payload(payload: dict) -> str:
    text = payload.get("message")
    if isinstance(text, str):
        return text.strip()

    items = payload.get("items")
    if isinstance(items, list):
        parts = []
        for item in items:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "\n\n".join(part.strip() for part in parts if part.strip()).strip()

    return ""


def ensure_turn(turns: dict[str, Turn], turn_id: str) -> Turn:
    turn = turns.get(turn_id)
    if turn is None:
        turn = Turn(turn_id=turn_id)
        turns[turn_id] = turn
    return turn


def update_turn_for_message(turn: Turn, message: Message) -> None:
    if turn.requested_at is None:
        turn.requested_at = message.created_at
    turn.last_message_at = message.created_at
    if message.role == "user":
        turn.user_message_at = message.created_at
        turn.requested_at = message.created_at
    elif message.role == "assistant":
        turn.assistant_message_id = message.message_id or turn.assistant_message_id


def fallback_title(messages: list[Message]) -> str:
    for message in messages:
        if message.role == "user":
            line = message.text.replace("\n", " ").strip()
            if len(line) > 80:
                return line[:77] + "..."
            if line:
                return line
    return "Imported Codex thread"


def parse_session(path: Path, codex_home: Path, codex_id: str) -> ParsedSession:
    rows = list(read_jsonl(path))
    if not rows:
        raise RuntimeError(f"Codex session file is empty: {path}")

    meta = {}
    messages: list[Message] = []
    turns: dict[str, Turn] = {}
    current_turn_id: str | None = None
    model: str | None = None
    first_timestamp: str | None = None
    last_timestamp: str | None = None

    def register_timestamp(value: str | None) -> None:
        nonlocal first_timestamp, last_timestamp
        if not value:
            return
        if first_timestamp is None or value < first_timestamp:
            first_timestamp = value
        if last_timestamp is None or value > last_timestamp:
            last_timestamp = value

    for row in rows:
        row_type = row.get("type")
        timestamp = row.get("timestamp")
        register_timestamp(timestamp)

        if row_type == "session_meta":
            meta = row.get("payload") or {}
            register_timestamp(meta.get("timestamp"))
            continue

        if row_type == "turn_context":
            context = row.get("payload") if isinstance(row.get("payload"), dict) else row
            turn_id = context.get("turn_id")
            if isinstance(turn_id, str) and turn_id:
                current_turn_id = turn_id
                ensure_turn(turns, turn_id)
            row_model = context.get("model")
            if isinstance(row_model, str) and row_model:
                model = row_model
            continue

        if row_type != "event_msg":
            continue

        payload = row.get("payload") or {}
        payload_type = payload.get("type")

        if payload_type == "session_meta":
            meta = payload
            register_timestamp(payload.get("timestamp"))
            continue

        if payload_type == "task_started":
            turn_id = payload.get("turn_id")
            if isinstance(turn_id, str) and turn_id:
                current_turn_id = turn_id
                turn = ensure_turn(turns, turn_id)
                turn.started_at = timestamp or turn.started_at
                if turn.requested_at is None:
                    turn.requested_at = timestamp
            continue

        if payload_type == "task_complete":
            turn_id = payload.get("turn_id") or current_turn_id
            if isinstance(turn_id, str) and turn_id:
                turn = ensure_turn(turns, turn_id)
                turn.completed_at = timestamp or turn.completed_at
                turn.state = "completed"
                final_text = (payload.get("last_agent_message") or "").strip()
                if final_text:
                    duplicate = (
                        messages
                        and messages[-1].role == "assistant"
                        and messages[-1].turn_id == turn_id
                        and messages[-1].text == final_text
                    )
                    if not duplicate:
                        messages.append(Message("assistant", final_text, timestamp or turn.completed_at, turn_id))
                current_turn_id = None
            continue

        if payload_type in ("turn_aborted", "task_aborted"):
            turn_id = payload.get("turn_id") or current_turn_id
            if isinstance(turn_id, str) and turn_id:
                turn = ensure_turn(turns, turn_id)
                turn.completed_at = timestamp or turn.completed_at
                turn.state = "interrupted"
                current_turn_id = None
            continue

        if payload_type == "user_message":
            text = text_from_payload(payload)
            if text:
                messages.append(Message("user", text, timestamp or last_timestamp or "", current_turn_id))
            continue

        if payload_type == "agent_message":
            text = text_from_payload(payload)
            if text:
                turn_id = payload.get("turn_id") or current_turn_id
                if not isinstance(turn_id, str):
                    turn_id = current_turn_id
                messages.append(Message("assistant", text, timestamp or last_timestamp or "", turn_id))
            continue

    if not meta:
        raise RuntimeError(f"Codex session metadata was not found in {path}")
    if meta.get("id") != codex_id:
        raise RuntimeError(f"Session id mismatch: expected {codex_id}, got {meta.get('id')}")

    if not messages:
        raise RuntimeError(f"No user/assistant messages found in {path}")

    for index, message in enumerate(messages):
        turn_part = message.turn_id or "no-turn"
        message.message_id = f"{message.role}:{codex_id}:{turn_part}:{index:06d}"
        if message.turn_id:
            update_turn_for_message(ensure_turn(turns, message.turn_id), message)

    for turn in turns.values():
        if turn.started_at is None:
            turn.started_at = turn.requested_at
        if turn.completed_at is None:
            turn.completed_at = turn.last_message_at or turn.started_at or turn.requested_at
            if turn.completed_at:
                turn.state = "interrupted"
        if turn.requested_at is None:
            turn.requested_at = turn.started_at or turn.completed_at

    title = title_from_index(codex_home, codex_id) or fallback_title(messages)
    workspace_root = meta.get("cwd") or str(Path.cwd())
    created_at = messages[0].created_at or meta.get("timestamp") or first_timestamp
    updated_at = last_timestamp or messages[-1].created_at or created_at

    return ParsedSession(
        codex_id=codex_id,
        source_path=path,
        title=title,
        workspace_root=workspace_root,
        created_at=created_at,
        updated_at=updated_at,
        model=model or DEFAULT_MODEL,
        messages=messages,
        turns=turns,
    )


def git_branch(workspace_root: str) -> str | None:
    try:
        result = subprocess.run(
            ["git", "-C", workspace_root, "rev-parse", "--abbrev-ref", "HEAD"],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )
    except Exception:
        return None
    branch = result.stdout.strip()
    return branch if branch and branch != "HEAD" else None


def one_or_none(cursor: sqlite3.Cursor, query: str, params=()):
    row = cursor.execute(query, params).fetchone()
    return row[0] if row else None


def append_event(
    cursor: sqlite3.Cursor,
    aggregate_kind: str,
    stream_id: str,
    event_type: str,
    occurred_at: str,
    command_id: str,
    correlation_id: str,
    payload: dict,
    actor_kind: str = "client",
) -> None:
    stream_version = cursor.execute(
        """
        SELECT COALESCE(MAX(stream_version) + 1, 0)
        FROM orchestration_events
        WHERE aggregate_kind = ? AND stream_id = ?
        """,
        (aggregate_kind, stream_id),
    ).fetchone()[0]
    cursor.execute(
        """
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, '{}')
        """,
        (
            f"event:codex-sync:{uuid.uuid4()}",
            aggregate_kind,
            stream_id,
            stream_version,
            event_type,
            occurred_at,
            command_id,
            correlation_id,
            actor_kind,
            dumps(payload),
        ),
    )


def project_created_payload(project_id: str, title: str, workspace_root: str, created_at: str, updated_at: str) -> dict:
    return {
        "projectId": project_id,
        "title": title,
        "workspaceRoot": workspace_root,
        "scripts": [],
        "defaultModelSelection": None,
        "createdAt": created_at,
        "updatedAt": updated_at,
    }


def thread_created_payload(
    thread_id: str,
    project_id: str,
    title: str,
    branch: str | None,
    model_selection: dict,
    created_at: str,
    updated_at: str,
) -> dict:
    return {
        "threadId": thread_id,
        "projectId": project_id,
        "title": title,
        "branch": branch,
        "worktreePath": None,
        "runtimeMode": "full-access",
        "interactionMode": "default",
        "modelSelection": model_selection,
        "createdAt": created_at,
        "updatedAt": updated_at,
    }


def thread_session_set_payload(thread_id: str, updated_at: str) -> dict:
    return {
        "threadId": thread_id,
        "session": {
            "threadId": thread_id,
            "status": "ready",
            "providerName": "codex",
            "runtimeMode": "full-access",
            "activeTurnId": None,
            "lastError": None,
            "updatedAt": updated_at,
        },
    }


def message_sent_payload(thread_id: str, message: Message) -> dict:
    return {
        "threadId": thread_id,
        "messageId": message.message_id,
        "turnId": message.turn_id,
        "role": message.role,
        "text": message.text,
        "attachments": [],
        "streaming": False,
        "createdAt": message.created_at,
        "updatedAt": message.created_at,
    }


def provider_runtime_payload(session: ParsedSession, model_selection: dict, last_runtime_event_at: str) -> dict:
    return {
        "cwd": session.workspace_root,
        "model": session.model,
        "activeTurnId": None,
        "lastError": None,
        "modelSelection": model_selection,
        "lastRuntimeEvent": "codex-sync.import",
        "lastRuntimeEventAt": last_runtime_event_at,
    }


def upsert_provider_resume_binding(
    cursor: sqlite3.Cursor,
    thread_id: str,
    session: ParsedSession,
    model_selection: dict,
) -> None:
    last_seen_at = now_iso()
    cursor.execute(
        """
        INSERT INTO provider_session_runtime (
          thread_id,
          provider_name,
          adapter_key,
          runtime_mode,
          status,
          last_seen_at,
          resume_cursor_json,
          runtime_payload_json
        )
        VALUES (?, 'codex', 'codex', 'full-access', 'stopped', ?, ?, ?)
        ON CONFLICT (thread_id)
        DO UPDATE SET
          provider_name = 'codex',
          adapter_key = 'codex',
          runtime_mode = 'full-access',
          status = CASE
            WHEN provider_session_runtime.status = 'running' THEN provider_session_runtime.status
            ELSE excluded.status
          END,
          last_seen_at = excluded.last_seen_at,
          resume_cursor_json = excluded.resume_cursor_json,
          runtime_payload_json = excluded.runtime_payload_json
        """,
        (
            thread_id,
            last_seen_at,
            dumps({"threadId": session.codex_id}),
            dumps(provider_runtime_payload(session, model_selection, last_seen_at)),
        ),
    )


def repair_existing_import(conn: sqlite3.Connection, session: ParsedSession, thread_id: str) -> dict:
    cursor = conn.cursor()
    thread_row = cursor.execute(
        """
        SELECT thread_id, project_id, title, branch, created_at, updated_at
        FROM projection_threads
        WHERE thread_id = ?
        """,
        (thread_id,),
    ).fetchone()
    if thread_row is None:
        raise RuntimeError(f"Imported thread projection row is missing: {thread_id}")

    project_row = cursor.execute(
        """
        SELECT project_id, title, workspace_root, created_at, updated_at
        FROM projection_projects
        WHERE project_id = ?
        """,
        (thread_row["project_id"],),
    ).fetchone()
    if project_row is None:
        raise RuntimeError(f"Imported project projection row is missing: {thread_row['project_id']}")

    messages = cursor.execute(
        """
        SELECT message_id, role, text, created_at, turn_id
        FROM projection_thread_messages
        WHERE thread_id = ?
        ORDER BY created_at ASC, message_id ASC
        """,
        (thread_id,),
    ).fetchall()
    messages_by_id = {
        row["message_id"]: Message(
            role=row["role"],
            text=row["text"],
            created_at=row["created_at"],
            turn_id=row["turn_id"],
            message_id=row["message_id"],
        )
        for row in messages
    }
    model_selection = {"provider": "codex", "model": session.model}

    cursor.execute("BEGIN")
    try:
        cursor.execute(
            "UPDATE projection_threads SET model_selection_json = ?, runtime_mode = 'full-access', interaction_mode = 'default' WHERE thread_id = ?",
            (dumps(model_selection), thread_id),
        )
        cursor.execute(
            """
            UPDATE projection_thread_sessions
            SET provider_name = 'codex',
                provider_thread_id = ?,
                runtime_mode = 'full-access',
                status = CASE WHEN status = 'stopped' THEN 'ready' ELSE status END
            WHERE thread_id = ?
            """,
            (session.codex_id, thread_id),
        )
        upsert_provider_resume_binding(cursor, thread_id, session, model_selection)

        project_payload = project_created_payload(
            project_row["project_id"],
            project_row["title"],
            project_row["workspace_root"],
            project_row["created_at"],
            project_row["updated_at"],
        )
        thread_payload = thread_created_payload(
            thread_id,
            thread_row["project_id"],
            thread_row["title"],
            thread_row["branch"],
            model_selection,
            thread_row["created_at"],
            thread_row["updated_at"],
        )
        session_updated_at = one_or_none(
            cursor,
            "SELECT updated_at FROM projection_thread_sessions WHERE thread_id = ?",
            (thread_id,),
        ) or thread_row["updated_at"]
        session_payload = thread_session_set_payload(thread_id, session_updated_at)

        cursor.execute(
            """
            UPDATE orchestration_events
            SET payload_json = ?
            WHERE stream_id = ? AND event_type = 'project.created'
            """,
            (dumps(project_payload), project_row["project_id"]),
        )
        cursor.execute(
            """
            UPDATE orchestration_events
            SET payload_json = ?
            WHERE stream_id = ? AND event_type = 'thread.created'
            """,
            (dumps(thread_payload), thread_id),
        )
        cursor.execute(
            """
            UPDATE orchestration_events
            SET payload_json = ?
            WHERE stream_id = ? AND event_type = 'thread.session-set'
            """,
            (dumps(session_payload), thread_id),
        )

        event_rows = cursor.execute(
            """
            SELECT sequence, payload_json
            FROM orchestration_events
            WHERE stream_id = ? AND event_type = 'thread.message-sent'
            """,
            (thread_id,),
        ).fetchall()
        repaired_messages = 0
        for event_row in event_rows:
            payload = json.loads(event_row["payload_json"])
            message = messages_by_id.get(payload.get("messageId"))
            if message is None:
                continue
            cursor.execute(
                "UPDATE orchestration_events SET payload_json = ? WHERE sequence = ?",
                (dumps(message_sent_payload(thread_id, message)), event_row["sequence"]),
            )
            repaired_messages += 1

        conn.commit()
    except Exception:
        conn.rollback()
        raise

    return {
        "repaired_message_events": repaired_messages,
        "provider_resume_thread_id": session.codex_id,
        "model": session.model,
    }


def import_session(db_path: Path, session: ParsedSession, dry_run: bool = False) -> dict:
    if not db_path.exists():
        raise FileNotFoundError(f"T3 Code database does not exist: {db_path}")

    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout = 5000")
        conn.execute("PRAGMA foreign_keys = ON")

        existing_thread = one_or_none(
            conn.cursor(),
            "SELECT thread_id FROM projection_threads WHERE thread_id LIKE ? LIMIT 1",
            (f"thread:codex-sync:{session.codex_id}:%",),
        )
        if existing_thread:
            repair = {} if dry_run else repair_existing_import(conn, session, existing_thread)
            message_count = conn.execute(
                "SELECT COUNT(*) FROM projection_thread_messages WHERE thread_id = ?",
                (existing_thread,),
            ).fetchone()[0]
            turn_count = conn.execute(
                "SELECT COUNT(*) FROM projection_turns WHERE thread_id = ?",
                (existing_thread,),
            ).fetchone()[0]
            return {
                "status": "already_imported",
                "thread_id": existing_thread,
                "message_count": message_count,
                "turn_count": turn_count,
                "db_path": str(db_path),
                **({"repair": repair} if repair else {}),
            }

        project_row = conn.execute(
            """
            SELECT project_id
            FROM projection_projects
            WHERE workspace_root = ? AND deleted_at IS NULL
            ORDER BY updated_at DESC
            LIMIT 1
            """,
            (session.workspace_root,),
        ).fetchone()
        project_id = project_row["project_id"] if project_row else None
        project_created = project_id is None
        if project_id is None:
            project_id = f"project:codex-sync:{session.workspace_root}:{uuid.uuid4()}"

        thread_id = f"thread:codex-sync:{session.codex_id}:{uuid.uuid4()}"
        command_id = f"codex-sync:thread:{session.codex_id}:{uuid.uuid4()}"
        correlation_id = command_id
        history_command_id = f"codex-sync:history:{session.codex_id}:{uuid.uuid4()}"
        model_selection = {"provider": "codex", "model": session.model}
        latest_user_message_at = max(
            (message.created_at for message in session.messages if message.role == "user"),
            default=session.created_at,
        )
        latest_turn_id = max(
            session.turns.values(),
            key=lambda turn: turn.completed_at or turn.last_message_at or turn.started_at or "",
        ).turn_id if session.turns else None
        branch = git_branch(session.workspace_root)

        if dry_run:
            return {
                "status": "dry_run",
                "thread_id": thread_id,
                "project_id": project_id,
                "message_count": len(session.messages),
                "turn_count": len(session.turns),
                "db_path": str(db_path),
            }

        cursor = conn.cursor()
        cursor.execute("BEGIN")
        try:
            if project_created:
                project_title = Path(session.workspace_root).name or session.workspace_root
                append_event(
                    cursor,
                    "project",
                    project_id,
                    "project.created",
                    session.created_at,
                    command_id,
                    correlation_id,
                    project_created_payload(
                        project_id,
                        project_title,
                        session.workspace_root,
                        session.created_at,
                        session.updated_at,
                    ),
                )
                cursor.execute(
                    """
                    INSERT INTO projection_projects (
                      project_id,
                      title,
                      workspace_root,
                      scripts_json,
                      created_at,
                      updated_at,
                      deleted_at,
                      default_model_selection_json
                    )
                    VALUES (?, ?, ?, '[]', ?, ?, NULL, NULL)
                    """,
                    (project_id, project_title, session.workspace_root, session.created_at, session.updated_at),
                )

            append_event(
                cursor,
                "thread",
                thread_id,
                "thread.created",
                session.created_at,
                command_id,
                correlation_id,
                thread_created_payload(
                    thread_id,
                    project_id,
                    session.title,
                    branch,
                    model_selection,
                    session.created_at,
                    session.updated_at,
                ),
            )
            cursor.execute(
                """
                INSERT INTO projection_threads (
                  thread_id,
                  project_id,
                  title,
                  branch,
                  worktree_path,
                  latest_turn_id,
                  created_at,
                  updated_at,
                  deleted_at,
                  runtime_mode,
                  interaction_mode,
                  model_selection_json,
                  archived_at,
                  latest_user_message_at,
                  pending_approval_count,
                  pending_user_input_count,
                  has_actionable_proposed_plan
                )
                VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, 'full-access', 'default', ?, NULL, ?, 0, 0, 0)
                """,
                (
                    thread_id,
                    project_id,
                    session.title,
                    branch,
                    latest_turn_id,
                    session.created_at,
                    session.updated_at,
                    dumps(model_selection),
                    latest_user_message_at,
                ),
            )

            append_event(
                cursor,
                "thread",
                thread_id,
                "thread.session-set",
                session.updated_at,
                command_id,
                correlation_id,
                thread_session_set_payload(thread_id, session.updated_at),
            )
            cursor.execute(
                """
                INSERT INTO projection_thread_sessions (
                  thread_id,
                  status,
                  provider_name,
                  provider_session_id,
                  provider_thread_id,
                  active_turn_id,
                  last_error,
                  updated_at,
                  runtime_mode
                )
                VALUES (?, 'ready', 'codex', NULL, ?, NULL, NULL, ?, 'full-access')
                """,
                (thread_id, session.codex_id, session.updated_at),
            )
            upsert_provider_resume_binding(cursor, thread_id, session, model_selection)

            for message in session.messages:
                append_event(
                    cursor,
                    "thread",
                    thread_id,
                    "thread.message-sent",
                    message.created_at,
                    history_command_id,
                    correlation_id,
                    message_sent_payload(thread_id, message),
                )
                cursor.execute(
                    """
                    INSERT INTO projection_thread_messages (
                      message_id,
                      thread_id,
                      turn_id,
                      role,
                      text,
                      is_streaming,
                      created_at,
                      updated_at,
                      attachments_json
                    )
                    VALUES (?, ?, ?, ?, ?, 0, ?, ?, '[]')
                    """,
                    (
                        message.message_id,
                        thread_id,
                        message.turn_id,
                        message.role,
                        message.text,
                        message.created_at,
                        message.created_at,
                    ),
                )

            for turn in session.turns.values():
                cursor.execute(
                    """
                    INSERT INTO projection_turns (
                      thread_id,
                      turn_id,
                      pending_message_id,
                      assistant_message_id,
                      state,
                      requested_at,
                      started_at,
                      completed_at,
                      checkpoint_turn_count,
                      checkpoint_ref,
                      checkpoint_status,
                      checkpoint_files_json,
                      source_proposed_plan_thread_id,
                      source_proposed_plan_id
                    )
                    VALUES (?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, '[]', NULL, NULL)
                    """,
                    (
                        thread_id,
                        turn.turn_id,
                        turn.assistant_message_id,
                        turn.state,
                        turn.requested_at,
                        turn.started_at,
                        turn.completed_at,
                    ),
                )

            conn.commit()
        except Exception:
            conn.rollback()
            raise

    return {
        "status": "imported",
        "thread_id": thread_id,
        "project_id": project_id,
        "message_count": len(session.messages),
        "turn_count": len(session.turns),
        "db_path": str(db_path),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Import a Codex JSONL session into the T3 Code SQLite state DB.")
    parser.add_argument("codex_thread_id")
    parser.add_argument("--db", default=os.environ.get("T3CODE_DB", "~/.t3/userdata/state.sqlite"))
    parser.add_argument("--codex-home", default=os.environ.get("CODEX_HOME", "~/.codex"))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    codex_home = Path(args.codex_home).expanduser()
    db_path = Path(args.db).expanduser()
    source_path = find_session_path(codex_home, args.codex_thread_id)
    session = parse_session(source_path, codex_home, args.codex_thread_id)
    result = import_session(db_path, session, dry_run=args.dry_run)
    result["source_path"] = str(source_path)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1)
