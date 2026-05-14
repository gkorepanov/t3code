import fs from "node:fs/promises";
import crypto from "node:crypto";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(new URL("../../..", import.meta.url).pathname);
const requireFromWeb = createRequire(path.join(repoRoot, "apps/web/package.json"));
const { chromium } = requireFromWeb("playwright");
const runId = `t3-hosted-ps-smoke-${Date.now()}`;
const powerSyncPrivateKey = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: {
    type: "pkcs8",
    format: "pem",
  },
  publicKeyEncoding: {
    type: "spki",
    format: "pem",
  },
}).privateKey;
const cleanupTasks = [];
let dockerEnv = {};
let activeDockerNames = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (message) => console.log(`[hosted-smoke] ${message}`);
const base64Url = (input) => Buffer.from(input).toString("base64url");

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        server.close(() => reject(new Error("Failed to reserve port.")));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function spawnProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    if (options.inherit) process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
    if (options.inherit) process.stderr.write(chunk);
  });
  cleanupTasks.push(async () => {
    if (child.exitCode === null && !child.killed) {
      child.kill("SIGTERM");
      await sleep(500);
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    }
  });
  return {
    child,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

async function run(command, args, options = {}) {
  const proc = spawnProcess(command, args, options);
  const exitCode = await new Promise((resolve) => proc.child.once("exit", resolve));
  if (exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${exitCode}\n${proc.stdout}\n${proc.stderr}`,
    );
  }
  return proc.stdout.trim();
}

async function waitFor(name, fn, timeoutMs = 60_000) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${name}${lastError ? `: ${lastError.message}` : ""}`);
}

async function waitForHttp(url, timeoutMs = 60_000) {
  return await waitFor(
    url,
    async () => {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      return response.ok;
    },
    timeoutMs,
  );
}

function createProxy(name, targetBaseUrl) {
  let online = true;
  const targetBase = new URL(targetBaseUrl);
  const server = http.createServer((request, response) => {
    if (!online) {
      response.writeHead(503, { "content-type": "text/plain" });
      response.end(`${name} offline`);
      return;
    }
    const targetUrl = new URL(request.url ?? "/", targetBase);
    const proxyRequest = http.request(
      targetUrl,
      {
        method: request.method,
        headers: {
          ...request.headers,
          host: targetUrl.host,
        },
      },
      (proxyResponse) => {
        response.writeHead(proxyResponse.statusCode ?? 502, proxyResponse.headers);
        proxyResponse.pipe(response);
      },
    );
    proxyRequest.on("error", (error) => {
      response.writeHead(502, { "content-type": "text/plain" });
      response.end(error.message);
    });
    request.pipe(proxyRequest);
  });
  server.on("upgrade", (request, socket, head) => {
    if (!online) {
      socket.destroy();
      return;
    }
    const targetSocket = net.connect(Number(targetBase.port), targetBase.hostname, () => {
      targetSocket.write(
        `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n` +
          Object.entries({ ...request.headers, host: targetBase.host })
            .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`)
            .join("\r\n") +
          "\r\n\r\n",
      );
      if (head.length > 0) targetSocket.write(head);
      socket.pipe(targetSocket);
      targetSocket.pipe(socket);
    });
    targetSocket.on("error", () => socket.destroy());
  });
  cleanupTasks.push(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    listen: async (port) =>
      await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve)),
    setOnline: (next) => {
      online = next;
    },
  };
}

async function docker(args) {
  return await run("docker", args, { env: dockerEnv, inherit: true });
}

async function dumpDockerLogs(label, name) {
  if (!name) return;
  const logs = await run("docker", ["logs", "--tail", "250", name], { env: dockerEnv }).catch(
    (error) => String(error?.message ?? error),
  );
  console.log(`[hosted-smoke:${label}:logs]\n${logs}`);
}

async function issuePostgresBearerSession(input) {
  const sessionId = crypto.randomUUID();
  const issuedAtMs = Date.now();
  const expiresAtMs = issuedAtMs + 30 * 24 * 60 * 60 * 1000;
  const issuedAt = new Date(issuedAtMs).toISOString();
  const expiresAt = new Date(expiresAtMs).toISOString();
  const payload = base64Url(
    JSON.stringify({
      v: 1,
      kind: "session",
      sid: sessionId,
      sub: "hosted-powersync-smoke",
      role: "owner",
      method: "bearer-session-token",
      iat: issuedAtMs,
      exp: expiresAtMs,
    }),
  );
  const signature = crypto
    .createHmac("sha256", input.signingSecret)
    .update(payload)
    .digest("base64url");
  await docker([
    "exec",
    input.pgName,
    "psql",
    "-U",
    "postgres",
    "-d",
    "t3code",
    "-c",
    `INSERT INTO auth_sessions (
       session_id,
       subject,
       role,
       method,
       issued_at,
       expires_at,
       revoked_at,
       client_label,
       client_ip_address,
       client_user_agent,
       client_device_type,
       client_os,
       client_browser,
       last_connected_at
     ) VALUES (
       '${sessionId}',
       'hosted-powersync-smoke',
       'owner',
       'bearer-session-token',
       '${issuedAt}',
       '${expiresAt}',
       NULL,
       'Hosted PowerSync smoke',
       NULL,
       NULL,
       'unknown',
       NULL,
       NULL,
       NULL
     );`,
  ]);
  return `${payload}.${signature}`;
}

async function writeFakeCodexBinary(input) {
  const source = `#!/usr/bin/env node
import fs from "node:fs";

const logPath = process.env.T3CODE_FAKE_CODEX_LOG;
const threads = new Map();

if (process.argv[2] === "exec") {
  const outputIndex = process.argv.indexOf("--output-last-message");
  if (outputIndex >= 0 && process.argv[outputIndex + 1]) {
    fs.writeFileSync(process.argv[outputIndex + 1], JSON.stringify({ title: "Hosted Smoke Turn" }));
  }
  process.exit(0);
}

function write(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function respond(id, result) {
  write({ id, result });
}

function respondError(id, code, message) {
  write({ id, error: { code, message } });
}

function record(event) {
  if (!logPath) return;
  fs.appendFileSync(logPath, JSON.stringify({ ...event, at: new Date().toISOString() }) + "\\n");
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function makeThread(id, cwd, model) {
  const existing = threads.get(id);
  if (existing) return existing;
  const now = nowSeconds();
  const thread = {
    id,
    cliVersion: "fake-codex-app-server/0.0.0",
    createdAt: now,
    cwd,
    ephemeral: false,
    modelProvider: "openai",
    preview: "",
    sessionId: "session-" + id,
    source: "appServer",
    status: { type: "idle" },
    turns: [],
    updatedAt: now,
  };
  threads.set(id, thread);
  return thread;
}

function textFromInput(input) {
  if (!Array.isArray(input)) return "";
  return input
    .filter((item) => item && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\\n");
}

function emitTurn(threadId, turnId, text) {
  const startedAt = nowSeconds();
  write({
    method: "turn/started",
    params: {
      threadId,
      turn: { id: turnId, items: [], itemsView: "full", startedAt, status: "inProgress" },
    },
  });
  write({
    method: "item/agentMessage/delta",
    params: {
      threadId,
      turnId,
      itemId: "item-" + turnId,
      delta: "Fake agent received: " + text,
    },
  });
  write({
    method: "turn/completed",
    params: {
      threadId,
      turn: {
        id: turnId,
        items: [],
        itemsView: "full",
        startedAt,
        completedAt: nowSeconds(),
        durationMs: 1,
        status: "completed",
      },
    },
  });
}

function handleRequest(message) {
  const id = message.id;
  switch (message.method) {
    case "initialize":
      respond(id, {
        userAgent: "fake-codex-app-server/0.0.0",
        codexHome: process.cwd(),
        platformFamily: process.platform === "win32" ? "windows" : "unix",
        platformOs: process.platform === "darwin" ? "macos" : process.platform,
      });
      return;
    case "initialized":
      record({ method: "initialized" });
      return;
    case "account/read":
      respond(id, {
        account: { type: "chatgpt", email: "fake-codex@example.test", planType: "plus" },
        requiresOpenaiAuth: false,
      });
      return;
    case "skills/list":
      respond(id, { data: [{ cwd: process.cwd(), errors: [], skills: [] }] });
      return;
    case "model/list":
      respond(id, {
        data: [
          {
            id: "gpt-5-codex",
            model: "gpt-5-codex",
            displayName: "gpt-5-codex",
            description: "Fake Codex smoke model",
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [
              { reasoningEffort: "medium", description: "Medium" },
              { reasoningEffort: "high", description: "High" },
            ],
          },
          {
            id: "gpt-5.3-codex",
            model: "gpt-5.3-codex",
            displayName: "gpt-5.3-codex",
            description: "Fake Codex smoke model",
            hidden: false,
            isDefault: false,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }],
          },
        ],
        nextCursor: null,
      });
      return;
    case "thread/start": {
      const providerThreadId = "provider-thread-" + cryptoRandom();
      const cwd = message.params?.cwd ?? process.cwd();
      const model = message.params?.model ?? "gpt-5-codex";
      const thread = makeThread(providerThreadId, cwd, model);
      respond(id, {
        cwd,
        model,
        modelProvider: "openai",
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: { type: "dangerFullAccess" },
        thread,
      });
      write({ method: "thread/started", params: { thread } });
      record({ method: "thread/start", params: message.params, providerThreadId });
      return;
    }
    case "thread/resume": {
      const providerThreadId = message.params?.threadId ?? "provider-thread-" + cryptoRandom();
      const cwd = message.params?.cwd ?? process.cwd();
      const model = message.params?.model ?? "gpt-5-codex";
      const thread = makeThread(providerThreadId, cwd, model);
      respond(id, {
        cwd,
        model,
        modelProvider: "openai",
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: { type: "dangerFullAccess" },
        thread,
      });
      record({ method: "thread/resume", params: message.params, providerThreadId });
      return;
    }
    case "thread/read": {
      const providerThreadId = message.params?.threadId ?? "provider-thread-missing";
      respond(id, { thread: makeThread(providerThreadId, process.cwd(), "gpt-5-codex") });
      return;
    }
    case "turn/start": {
      const text = textFromInput(message.params?.input);
      const threadId = message.params?.threadId;
      const turnId = "turn-" + cryptoRandom();
      record({ method: "turn/start", params: message.params, text, threadId, turnId });
      respond(id, {
        turn: {
          id: turnId,
          items: [],
          itemsView: "full",
          startedAt: nowSeconds(),
          status: "inProgress",
        },
      });
      setTimeout(() => emitTurn(threadId, turnId, text), 10);
      return;
    }
    case "turn/interrupt":
      respond(id, { status: "ok" });
      return;
    default:
      if (id !== undefined) respondError(id, -32601, "Unhandled request: " + message.method);
  }
}

function cryptoRandom() {
  return Math.random().toString(36).slice(2) + "-" + Date.now().toString(36);
}

let remainder = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  remainder += chunk;
  const lines = remainder.split("\\n");
  remainder = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const message = JSON.parse(trimmed);
    if ("method" in message) handleRequest(message);
  }
});

process.stdin.on("end", () => process.exit(0));
`;
  await fs.writeFile(input.binaryPath, source);
  await fs.chmod(input.binaryPath, 0o755);
}

async function dispatchRemoteCommand(input) {
  const response = await fetch(`http://127.0.0.1:${input.t3Port}/api/powersync/upload`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.bearerToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      batch: [
        {
          op: "PUT",
          table: "client_orchestration_commands",
          id: input.command.commandId,
          data: {
            command_json: JSON.stringify(input.command),
            created_at: input.command.createdAt ?? new Date().toISOString(),
          },
        },
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Direct PowerSync upload failed: ${response.status} ${await response.text()}`);
  }
  return await response.json();
}

async function readFakeCodexLog(logPath) {
  const raw = await fs.readFile(logPath, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function main() {
  const [pgPort, t3Port, psPort, t3ProxyPort, psProxyPort] = await Promise.all(
    Array.from({ length: 5 }, reservePort),
  );
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), `${runId}-base-`));
  const workspaceRoot = path.join(baseDir, "workspace");
  const fakeCodexHome = path.join(baseDir, "fake-codex-home");
  const fakeCodexPath = path.join(baseDir, "fake-codex-app-server.mjs");
  const fakeCodexLogPath = path.join(baseDir, "fake-codex-events.jsonl");
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), `${runId}-powersync-`));
  const dockerConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), `${runId}-docker-config-`));
  await fs.mkdir(path.join(baseDir, "userdata"), { recursive: true });
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.mkdir(fakeCodexHome, { recursive: true });
  await fs.writeFile(path.join(dockerConfigDir, "config.json"), "{}");
  await writeFakeCodexBinary({ binaryPath: fakeCodexPath });
  await fs.writeFile(
    path.join(baseDir, "userdata/settings.json"),
    JSON.stringify(
      {
        providers: {
          codex: {
            enabled: true,
            binaryPath: fakeCodexPath,
            homePath: fakeCodexHome,
            customModels: ["gpt-5-codex", "gpt-5.3-codex"],
          },
          claudeAgent: { enabled: false },
          cursor: { enabled: false },
          opencode: { enabled: false },
        },
        textGenerationModelSelection: { instanceId: "codex", model: "gpt-5-codex" },
      },
      null,
      2,
    ),
  );

  dockerEnv = { DOCKER_CONFIG: dockerConfigDir };
  const networkName = `${runId}-net`;
  const pgName = `${runId}-pg`;
  const psName = `${runId}-ps`;
  activeDockerNames = { pgName, psName };

  step("building hosted web assets");
  await run("bun", ["run", "build"], { cwd: path.join(repoRoot, "apps/web"), inherit: true });

  step("creating docker network");
  await docker(["network", "create", networkName]);
  cleanupTasks.push(async () => {
    await docker(["network", "rm", networkName]).catch(() => "");
  });

  step("starting postgres");
  await docker([
    "run",
    "-d",
    "--name",
    pgName,
    "--network",
    networkName,
    "-p",
    `${pgPort}:5432`,
    "-e",
    "POSTGRES_PASSWORD=postgres",
    "-e",
    "POSTGRES_DB=t3code",
    "postgres:16-alpine",
    "-c",
    "wal_level=logical",
    "-c",
    "max_replication_slots=10",
    "-c",
    "max_wal_senders=10",
  ]);
  cleanupTasks.push(async () => {
    await docker(["rm", "-f", pgName]).catch(() => "");
  });
  await waitFor("postgres", () =>
    docker(["exec", pgName, "pg_isready", "-U", "postgres"])
      .then(() => true)
      .catch(() => false),
  );
  await waitFor("postgres stable query", () =>
    docker(["exec", pgName, "psql", "-U", "postgres", "-d", "postgres", "-c", "SELECT 1;"])
      .then(() => true)
      .catch(() => false),
  );
  await docker([
    "exec",
    pgName,
    "psql",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-c",
    "CREATE DATABASE powersync_storage;",
  ]);
  step("postgres is ready");

  const t3Proxy = createProxy("t3", `http://127.0.0.1:${t3Port}`);
  const psProxy = createProxy("powersync", `http://127.0.0.1:${psPort}`);
  await t3Proxy.listen(t3ProxyPort);
  await psProxy.listen(psProxyPort);
  step("proxies are listening");

  const serverEnv = {
    T3CODE_DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${pgPort}/t3code`,
    T3CODE_POWERSYNC_URL: `http://127.0.0.1:${psProxyPort}`,
    T3CODE_POWERSYNC_JWT_PRIVATE_KEY: powerSyncPrivateKey,
    T3CODE_POWERSYNC_JWT_ISSUER: "t3code",
    T3CODE_POWERSYNC_JWT_AUDIENCE: "powersync",
    T3CODE_FAKE_CODEX_LOG: fakeCodexLogPath,
    T3CODE_NO_BROWSER: "1",
  };
  step("starting hosted t3 serve");
  spawnProcess(
    "node",
    [
      "apps/server/src/bin.ts",
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(t3Port),
      "--base-dir",
      baseDir,
      "--no-browser",
    ],
    { env: serverEnv },
  );
  await waitForHttp(`http://127.0.0.1:${t3Port}/api/auth/session`);
  const descriptorResponse = await fetch(`http://127.0.0.1:${t3Port}/.well-known/t3/environment`);
  if (!descriptorResponse.ok) {
    throw new Error(
      `Environment descriptor failed: ${descriptorResponse.status} ${await descriptorResponse.text()}`,
    );
  }
  const descriptor = await descriptorResponse.json();
  if (descriptor.capabilities?.powerSync !== true) {
    throw new Error(`Hosted server did not advertise PowerSync: ${JSON.stringify(descriptor)}`);
  }
  step(`t3 serve is ready (${descriptor.environmentId})`);

  const bearerToken = await issuePostgresBearerSession({
    pgName,
    signingSecret: await fs.readFile(path.join(baseDir, "userdata/secrets/server-signing-key.bin")),
  });
  const credentialProbe = await fetch(`http://127.0.0.1:${t3Port}/api/powersync/credentials`, {
    headers: { authorization: `Bearer ${bearerToken}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!credentialProbe.ok) {
    throw new Error(
      `PowerSync credential probe failed: ${credentialProbe.status} ${await credentialProbe.text()}`,
    );
  }
  step("owner session is ready");

  step("creating powersync publication");
  await docker([
    "exec",
    pgName,
    "psql",
    "-U",
    "postgres",
    "-d",
    "t3code",
    "-c",
    "DROP PUBLICATION IF EXISTS powersync; CREATE PUBLICATION powersync FOR ALL TABLES;",
  ]);

  step("starting powersync service");
  await fs.writeFile(
    path.join(configDir, "service.yaml"),
    `
telemetry:
  disable_telemetry_sharing: true
replication:
  connections:
    - type: postgresql
      uri: postgresql://postgres:postgres@${pgName}:5432/t3code
      sslmode: disable
storage:
  type: postgresql
  uri: postgresql://postgres:postgres@${pgName}:5432/powersync_storage
  sslmode: disable
port: 8080
sync_config:
  path: /config/sync-rules.yaml
client_auth:
  jwks_uri: http://host.docker.internal:${t3Port}/api/powersync/jwks
  audience: ["powersync", "t3code-powersync"]
api:
  tokens:
    - smoke-token
system:
  logging:
    level: info
    format: text
`.trimStart(),
  );
  await fs.copyFile(
    path.join(repoRoot, "powersync/sync-rules.yaml"),
    path.join(configDir, "sync-rules.yaml"),
  );
  await docker([
    "run",
    "-d",
    "--name",
    psName,
    "--network",
    networkName,
    "--add-host",
    "host.docker.internal:host-gateway",
    "-p",
    `${psPort}:8080`,
    "-v",
    `${configDir}:/config:ro`,
    "journeyapps/powersync-service:latest",
    "start",
    "-c",
    "/config/service.yaml",
  ]);
  cleanupTasks.push(async () => {
    await docker(["rm", "-f", psName]).catch(() => "");
  });
  await waitForHttp(`http://127.0.0.1:${psPort}/probes/liveness`, 120_000);
  step("powersync service is live");

  step("launching browser against hosted t3 serve");
  const browser = await chromium.launch();
  cleanupTasks.push(async () => {
    await browser.close().catch(() => {});
  });
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: "t3_session",
      value: bearerToken,
      domain: "127.0.0.1",
      path: "/",
      expires: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const page = await context.newPage();
  page.on("console", (message) => console.log(`[browser:${message.type()}] ${message.text()}`));
  page.on("request", (request) => {
    const url = request.url();
    if (
      url.includes("/api/powersync") ||
      url.includes(`:${psProxyPort}`) ||
      url.startsWith(`ws://127.0.0.1:${t3ProxyPort}`)
    ) {
      console.log(`[browser:request] ${request.method()} ${url}`);
    }
  });
  page.on("requestfailed", (request) => {
    const url = request.url();
    if (url.includes("/api/powersync") || url.includes(`:${psProxyPort}`)) {
      console.log(`[browser:failed] ${request.method()} ${url} ${request.failure()?.errorText}`);
    }
  });
  await page.goto(`http://127.0.0.1:${t3ProxyPort}/`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
  step("hosted browser page loaded");

  const projectId = `project-${runId}`;
  const threadId = `thread-${runId}`;
  const modelSelection = { instanceId: "codex", model: "gpt-5-codex" };
  const projectTitle = "Hosted Remote Alpha";
  const threadTitle = "Hosted Remote Thread Alpha";
  const createdAt = new Date().toISOString();
  await dispatchRemoteCommand({
    t3Port,
    bearerToken,
    command: {
      type: "project.create",
      commandId: `cmd-${runId}-project-alpha`,
      projectId,
      title: projectTitle,
      workspaceRoot,
      createWorkspaceRootIfMissing: true,
      defaultModelSelection: modelSelection,
      createdAt,
    },
  });
  await dispatchRemoteCommand({
    t3Port,
    bearerToken,
    command: {
      type: "thread.create",
      commandId: `cmd-${runId}-thread-alpha`,
      threadId,
      projectId,
      title: threadTitle,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    },
  });
  await page.getByText(projectTitle).waitFor({ timeout: 90_000 });
  await page.getByText(threadTitle).waitFor({ timeout: 90_000 });
  step("browser observed remote-created project and thread through PowerSync");

  await page.goto(`http://127.0.0.1:${t3ProxyPort}/${descriptor.environmentId}/${threadId}`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByTestId("composer-editor").waitFor({ timeout: 60_000 });

  step("dropping browser network");
  t3Proxy.setOnline(false);
  psProxy.setOnline(false);

  const uiMessage = `hosted browser queued message ${runId}`;
  await page.getByTestId("composer-editor").fill(uiMessage);
  await page.getByRole("button", { name: "Send message" }).click();
  await sleep(1_500);

  const remoteProjectTitle = "Hosted Remote Bravo";
  await dispatchRemoteCommand({
    t3Port,
    bearerToken,
    command: {
      type: "project.create",
      commandId: `cmd-${runId}-project-bravo`,
      projectId: `project-${runId}-bravo`,
      title: remoteProjectTitle,
      workspaceRoot: path.join(baseDir, "remote-bravo-workspace"),
      createWorkspaceRootIfMissing: true,
      defaultModelSelection: modelSelection,
      createdAt: new Date().toISOString(),
    },
  });
  step("remote server accepted update while browser was offline");

  step("flapping browser network");
  for (let i = 0; i < 4; i++) {
    t3Proxy.setOnline(true);
    psProxy.setOnline(true);
    await sleep(350);
    t3Proxy.setOnline(false);
    psProxy.setOnline(false);
    await sleep(250);
  }
  t3Proxy.setOnline(true);
  psProxy.setOnline(true);
  step("browser network restored");

  await page.getByText(remoteProjectTitle).waitFor({ timeout: 120_000 });
  await waitFor(
    "fake codex received browser message",
    async () => {
      const events = await readFakeCodexLog(fakeCodexLogPath);
      return events.some((event) => event.method === "turn/start" && event.text === uiMessage);
    },
    120_000,
  );
  await page.getByText(`Fake agent received: ${uiMessage}`).waitFor({ timeout: 120_000 });
  step("browser queued turn reached fake Codex and agent reply synced back");

  const events = await readFakeCodexLog(fakeCodexLogPath);
  const turnStart = events.find(
    (event) => event.method === "turn/start" && event.text === uiMessage,
  );
  console.log(
    JSON.stringify(
      {
        ok: true,
        environmentId: descriptor.environmentId,
        projectTitles: [projectTitle, remoteProjectTitle],
        uiMessage,
        fakeCodexTurnId: turnStart?.turnId ?? null,
      },
      null,
      2,
    ),
  );
}

try {
  await main();
} catch (error) {
  await dumpDockerLogs("powersync", activeDockerNames?.psName);
  await dumpDockerLogs("postgres", activeDockerNames?.pgName);
  throw error;
} finally {
  for (const task of cleanupTasks.toReversed()) {
    await task().catch(() => {});
  }
}
