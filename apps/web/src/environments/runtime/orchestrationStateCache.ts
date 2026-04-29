import type { EnvironmentId, OrchestrationShellSnapshot, ThreadId } from "@t3tools/contracts";
import type { Thread } from "~/types";

const DB_NAME = "t3code-orchestration-state-cache";
const DB_VERSION = 1;
const ENVIRONMENT_STORE = "environments";
const THREAD_STORE = "threads";
const THREAD_ENVIRONMENT_INDEX = "byEnvironmentId";
const THREAD_LAST_ACCESSED_INDEX = "byLastAccessedAtMs";
const RECORD_VERSION = 1;

const MAX_THREAD_CACHE_BYTES = 200 * 1024 * 1024;
const MAX_THREAD_CACHE_COUNT = 200;

export interface CachedEnvironmentState {
  readonly shell: OrchestrationShellSnapshot | null;
  readonly threads: readonly CachedThreadDetailRecord[];
}

interface CachedEnvironmentShellRecord {
  readonly version: typeof RECORD_VERSION;
  readonly environmentId: EnvironmentId;
  readonly sequence: number;
  readonly snapshot: OrchestrationShellSnapshot;
  readonly updatedAtMs: number;
  readonly sizeBytes: number;
}

export interface CachedThreadDetailRecord {
  readonly version: typeof RECORD_VERSION;
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly sequence: number;
  readonly thread: Thread;
  readonly updatedAtMs: number;
  readonly lastAccessedAtMs: number;
  readonly sizeBytes: number;
}

interface PersistAppliedStateInput {
  readonly environmentId: EnvironmentId;
  readonly shell: OrchestrationShellSnapshot | null;
  readonly threadDetail?: {
    readonly threadId: ThreadId;
    readonly sequence: number;
    readonly thread: Thread;
  };
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function canUseIndexedDb(): boolean {
  return typeof globalThis.indexedDB !== "undefined";
}

function threadRecordKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return `${environmentId}\u0000${threadId}`;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener(
      "error",
      () => reject(request.error ?? new Error("IndexedDB request failed.")),
      { once: true },
    );
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener(
      "abort",
      () => reject(transaction.error ?? new Error("IndexedDB transaction aborted.")),
      { once: true },
    );
    transaction.addEventListener(
      "error",
      () => reject(transaction.error ?? new Error("IndexedDB transaction failed.")),
      { once: true },
    );
  });
}

function openDb(): Promise<IDBDatabase | null> {
  if (!canUseIndexedDb()) {
    return Promise.resolve(null);
  }
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve) => {
    const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ENVIRONMENT_STORE)) {
        db.createObjectStore(ENVIRONMENT_STORE, { keyPath: "environmentId" });
      }
      if (!db.objectStoreNames.contains(THREAD_STORE)) {
        const threadStore = db.createObjectStore(THREAD_STORE, { keyPath: "key" });
        threadStore.createIndex(THREAD_ENVIRONMENT_INDEX, "environmentId", { unique: false });
        threadStore.createIndex(THREAD_LAST_ACCESSED_INDEX, "lastAccessedAtMs", {
          unique: false,
        });
      }
    });
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => resolve(null), { once: true });
    request.addEventListener("blocked", () => resolve(null), { once: true });
  });

  return dbPromise;
}

function estimateJsonSizeBytes(value: unknown): number {
  const json = JSON.stringify(value);
  if (typeof Blob !== "undefined") {
    return new Blob([json]).size;
  }
  return json.length;
}

function createEnvironmentShellRecord(
  environmentId: EnvironmentId,
  snapshot: OrchestrationShellSnapshot,
): CachedEnvironmentShellRecord {
  const baseRecord = {
    version: RECORD_VERSION,
    environmentId,
    sequence: snapshot.snapshotSequence,
    snapshot,
    updatedAtMs: Date.now(),
    sizeBytes: 0,
  } satisfies CachedEnvironmentShellRecord;
  return {
    ...baseRecord,
    sizeBytes: estimateJsonSizeBytes(baseRecord),
  };
}

function createThreadDetailRecord(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly sequence: number;
  readonly thread: Thread;
}): CachedThreadDetailRecord {
  const now = Date.now();
  const baseRecord = {
    version: RECORD_VERSION,
    key: threadRecordKey(input.environmentId, input.threadId),
    environmentId: input.environmentId,
    threadId: input.threadId,
    sequence: input.sequence,
    thread: input.thread,
    updatedAtMs: now,
    lastAccessedAtMs: now,
    sizeBytes: 0,
  } satisfies CachedThreadDetailRecord;
  return {
    ...baseRecord,
    sizeBytes: estimateJsonSizeBytes(baseRecord),
  };
}

async function getAllThreadRecords(db: IDBDatabase): Promise<CachedThreadDetailRecord[]> {
  const transaction = db.transaction(THREAD_STORE, "readonly");
  const done = transactionDone(transaction);
  const records = (await requestToPromise(
    transaction.objectStore(THREAD_STORE).getAll(),
  )) as CachedThreadDetailRecord[];
  await done;
  return records.filter((record) => record.version === RECORD_VERSION);
}

async function enforceThreadCacheBudget(db: IDBDatabase): Promise<void> {
  const records = await getAllThreadRecords(db);
  let totalBytes = records.reduce((total, record) => total + record.sizeBytes, 0);
  let count = records.length;
  if (count <= MAX_THREAD_CACHE_COUNT && totalBytes <= MAX_THREAD_CACHE_BYTES) {
    return;
  }

  const transaction = db.transaction(THREAD_STORE, "readwrite");
  const done = transactionDone(transaction);
  const store = transaction.objectStore(THREAD_STORE);
  for (const record of records.toSorted(
    (left, right) =>
      left.lastAccessedAtMs - right.lastAccessedAtMs || left.updatedAtMs - right.updatedAtMs,
  )) {
    if (count <= MAX_THREAD_CACHE_COUNT && totalBytes <= MAX_THREAD_CACHE_BYTES) {
      break;
    }
    store.delete(record.key);
    count -= 1;
    totalBytes -= record.sizeBytes;
  }
  await done;
}

async function putEnvironmentShellIfNewer(
  store: IDBObjectStore,
  record: CachedEnvironmentShellRecord,
): Promise<void> {
  const existing = (await requestToPromise(store.get(record.environmentId))) as
    | CachedEnvironmentShellRecord
    | undefined;
  if (existing && existing.version === RECORD_VERSION && existing.sequence > record.sequence) {
    return;
  }
  store.put(record);
}

async function putThreadDetailIfNewer(
  store: IDBObjectStore,
  record: CachedThreadDetailRecord,
): Promise<void> {
  const existing = (await requestToPromise(store.get(record.key))) as
    | CachedThreadDetailRecord
    | undefined;
  if (existing && existing.version === RECORD_VERSION && existing.sequence > record.sequence) {
    return;
  }
  store.put(record);
}

export async function readCachedEnvironmentState(
  environmentId: EnvironmentId,
): Promise<CachedEnvironmentState> {
  const db = await openDb();
  if (!db) {
    return { shell: null, threads: [] };
  }

  const transaction = db.transaction([ENVIRONMENT_STORE, THREAD_STORE], "readonly");
  const done = transactionDone(transaction);
  const environmentRecord = (await requestToPromise(
    transaction.objectStore(ENVIRONMENT_STORE).get(environmentId),
  )) as CachedEnvironmentShellRecord | undefined;
  const threadRecords = (await requestToPromise(
    transaction.objectStore(THREAD_STORE).index(THREAD_ENVIRONMENT_INDEX).getAll(environmentId),
  )) as CachedThreadDetailRecord[];
  await done;

  return {
    shell: environmentRecord?.version === RECORD_VERSION ? environmentRecord.snapshot : null,
    threads: threadRecords.filter((record) => record.version === RECORD_VERSION),
  };
}

export async function persistCachedAppliedState(input: PersistAppliedStateInput): Promise<void> {
  const db = await openDb();
  if (!db) {
    return;
  }

  const shellRecord =
    input.shell === null ? null : createEnvironmentShellRecord(input.environmentId, input.shell);
  const threadRecord = input.threadDetail
    ? createThreadDetailRecord({
        environmentId: input.environmentId,
        threadId: input.threadDetail.threadId,
        sequence: input.threadDetail.sequence,
        thread: input.threadDetail.thread,
      })
    : null;

  if (threadRecord && threadRecord.sizeBytes > MAX_THREAD_CACHE_BYTES) {
    await deleteCachedThreadDetail(input.environmentId, threadRecord.threadId);
    return;
  }

  const transaction = db.transaction([ENVIRONMENT_STORE, THREAD_STORE], "readwrite");
  const done = transactionDone(transaction);
  if (shellRecord) {
    await putEnvironmentShellIfNewer(transaction.objectStore(ENVIRONMENT_STORE), shellRecord);
  }
  if (threadRecord) {
    await putThreadDetailIfNewer(transaction.objectStore(THREAD_STORE), threadRecord);
  }
  await done;

  if (threadRecord) {
    await enforceThreadCacheBudget(db);
  }
}

export async function touchCachedThreadDetail(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): Promise<void> {
  const db = await openDb();
  if (!db) {
    return;
  }

  const key = threadRecordKey(environmentId, threadId);
  const transaction = db.transaction(THREAD_STORE, "readwrite");
  const done = transactionDone(transaction);
  const store = transaction.objectStore(THREAD_STORE);
  const existing = (await requestToPromise(store.get(key))) as CachedThreadDetailRecord | undefined;
  if (existing?.version === RECORD_VERSION) {
    store.put({
      ...existing,
      lastAccessedAtMs: Date.now(),
    } satisfies CachedThreadDetailRecord);
  }
  await done;
}

export async function deleteCachedThreadDetail(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): Promise<void> {
  const db = await openDb();
  if (!db) {
    return;
  }

  const transaction = db.transaction(THREAD_STORE, "readwrite");
  const done = transactionDone(transaction);
  transaction.objectStore(THREAD_STORE).delete(threadRecordKey(environmentId, threadId));
  await done;
}

export async function clearCachedThreadDetailsForEnvironment(
  environmentId: EnvironmentId,
): Promise<void> {
  const db = await openDb();
  if (!db) {
    return;
  }

  const transaction = db.transaction(THREAD_STORE, "readwrite");
  const done = transactionDone(transaction);
  const store = transaction.objectStore(THREAD_STORE);
  const records = (await requestToPromise(
    store.index(THREAD_ENVIRONMENT_INDEX).getAll(environmentId),
  )) as CachedThreadDetailRecord[];
  for (const record of records) {
    store.delete(record.key);
  }
  await done;
}
