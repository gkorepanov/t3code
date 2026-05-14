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
const runId = `t3-ps-smoke-${Date.now()}`;
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
const step = (message) => console.log(`[smoke] ${message}`);
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
  console.log(`[smoke:${label}:logs]\n${logs}`);
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
      sub: "powersync-smoke",
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
       'powersync-smoke',
       'owner',
       'bearer-session-token',
       '${issuedAt}',
       '${expiresAt}',
       NULL,
       'PowerSync smoke',
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

async function main() {
  const [pgPort, t3Port, psPort, t3ProxyPort, psProxyPort, vitePort] = await Promise.all(
    Array.from({ length: 6 }, reservePort),
  );
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), `${runId}-base-`));
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), `${runId}-powersync-`));
  const dockerConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), `${runId}-docker-config-`));
  await fs.writeFile(path.join(dockerConfigDir, "config.json"), "{}");
  dockerEnv = { DOCKER_CONFIG: dockerConfigDir };
  const networkName = `${runId}-net`;
  const pgName = `${runId}-pg`;
  const psName = `${runId}-ps`;
  activeDockerNames = { pgName, psName };

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
  step("postgres is ready");
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

  const t3Proxy = createProxy("t3", `http://127.0.0.1:${t3Port}`);
  const psProxy = createProxy("powersync", `http://127.0.0.1:${psPort}`);
  await t3Proxy.listen(t3ProxyPort);
  await psProxy.listen(psProxyPort);
  step("proxies are listening");

  const databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${pgPort}/t3code`;
  const serverEnv = {
    T3CODE_DATABASE_URL: databaseUrl,
    T3CODE_POWERSYNC_URL: `http://127.0.0.1:${psProxyPort}`,
    T3CODE_POWERSYNC_JWT_PRIVATE_KEY: powerSyncPrivateKey,
    T3CODE_POWERSYNC_JWT_ISSUER: "t3code",
    T3CODE_POWERSYNC_JWT_AUDIENCE: "powersync",
    T3CODE_NO_BROWSER: "1",
  };
  step("starting t3 server");
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
  step("t3 server is ready");

  step("issuing postgres bearer token");
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
  step("bearer token issued");

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
  step("powersync publication created");

  step("writing powersync config");
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
  step("starting powersync service");
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

  step("starting vite");
  spawnProcess("bun", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort)], {
    cwd: path.join(repoRoot, "apps/web"),
    env: {
      VITE_HTTP_URL: `http://127.0.0.1:${t3ProxyPort}`,
      VITE_WS_URL: `ws://127.0.0.1:${t3ProxyPort}`,
    },
  });
  await waitForHttp(`http://127.0.0.1:${vitePort}/`);
  step("vite is ready");

  step("launching browser");
  const browser = await chromium.launch();
  cleanupTasks.push(async () => {
    await browser.close().catch(() => {});
  });
  const page = await browser.newPage();
  page.on("console", (message) => console.log(`[browser:${message.type()}] ${message.text()}`));
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/api/powersync") || url.includes(`:${psProxyPort}`)) {
      console.log(`[browser:request] ${request.method()} ${url}`);
    }
  });
  page.on("response", (response) => {
    const url = response.url();
    if (url.includes("/api/powersync") || url.includes(`:${psProxyPort}`)) {
      console.log(`[browser:response] ${response.status()} ${url}`);
    }
  });
  page.on("requestfailed", (request) => {
    const url = request.url();
    if (url.includes("/api/powersync") || url.includes(`:${psProxyPort}`)) {
      console.log(`[browser:failed] ${request.method()} ${url} ${request.failure()?.errorText}`);
    }
  });
  await page.goto(`http://127.0.0.1:${vitePort}/`);
  step("browser page loaded");

  const smokeConfig = {
    environmentId: `smoke-${Date.now()}`,
    httpBaseUrl: `http://127.0.0.1:${t3ProxyPort}`,
    bearerToken,
    workspaceRoot: baseDir,
  };

  step("bootstrapping browser powersync state");
  await page.evaluate(async (config) => {
    const { createRemotePowerSyncState } =
      await import("/src/environments/powersync/connection.ts");
    const snapshots = [];
    const statuses = [];
    const state = createRemotePowerSyncState({
      environmentId: config.environmentId,
      httpBaseUrl: config.httpBaseUrl,
      bearerToken: config.bearerToken,
      onShellSnapshot: (snapshot) => snapshots.push(snapshot),
    });
    state.__debugDb?.registerListener?.({
      statusChanged: (status) => {
        const json = status.toJSON();
        statuses.push(json);
        console.log(`[powersync-status] ${JSON.stringify(json)}`);
      },
    });
    state.subscribeShell((item) => snapshots.push(item.snapshot));
    await state.ensureBootstrapped();
    window.__t3PowerSyncSmoke = {
      state,
      snapshots,
      statuses,
      withTimeout: async (promise, timeoutMs, label) => {
        let timeoutId;
        try {
          return await Promise.race([
            promise,
            new Promise((_, reject) => {
              timeoutId = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
            }),
          ]);
        } finally {
          clearTimeout(timeoutId);
        }
      },
      waitForProject: async (title, timeoutMs = 45_000) => {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
          if (
            snapshots.some((snapshot) =>
              snapshot.projects.some((project) => project.title === title),
            )
          ) {
            return true;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error(`Timed out waiting for project ${title}`);
      },
      dispatchProject: async (title) => {
        const id = title.toLowerCase().replaceAll(" ", "-");
        return await state.dispatchCommand({
          type: "project.create",
          commandId: `cmd-${id}`,
          projectId: `project-${id}`,
          title,
          workspaceRoot: config.workspaceRoot,
          createWorkspaceRootIfMissing: true,
          defaultModelSelection: { instanceId: "codex", model: "gpt-5-codex" },
          createdAt: new Date().toISOString(),
        });
      },
      dispose: async () => await state.dispose(),
    };
  }, smokeConfig);
  step("browser powersync state bootstrapped");

  step("dispatching online command");
  await page.evaluate(async () => {
    await window.__t3PowerSyncSmoke.withTimeout(
      window.__t3PowerSyncSmoke.dispatchProject("Online Alpha"),
      60_000,
      "online dispatch",
    );
    await window.__t3PowerSyncSmoke.waitForProject("Online Alpha");
  });
  step("online command synced");

  step("dropping client network");
  t3Proxy.setOnline(false);
  psProxy.setOnline(false);
  await page.evaluate(() => {
    window.__offlineDispatch = window.__t3PowerSyncSmoke
      .dispatchProject("Offline Bravo")
      .then(() => ({ ok: true }))
      .catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
  });
  await sleep(2_000);

  step("dispatching direct remote command while browser is offline");
  const remoteCommand = {
    type: "project.create",
    commandId: "cmd-remote-charlie",
    projectId: "project-remote-charlie",
    title: "Remote Charlie",
    workspaceRoot: baseDir,
    createWorkspaceRootIfMissing: true,
    defaultModelSelection: { instanceId: "codex", model: "gpt-5-codex" },
    createdAt: new Date().toISOString(),
  };
  const directUpload = await fetch(`http://127.0.0.1:${t3Port}/api/powersync/upload`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearerToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      batch: [
        {
          op: "PUT",
          table: "client_orchestration_commands",
          id: remoteCommand.commandId,
          data: {
            command_json: JSON.stringify(remoteCommand),
            created_at: remoteCommand.createdAt,
          },
        },
      ],
    }),
  });
  if (!directUpload.ok) {
    throw new Error(`Direct upload failed: ${directUpload.status} ${await directUpload.text()}`);
  }
  step("direct remote command accepted");

  step("flapping client network");
  for (let i = 0; i < 3; i++) {
    t3Proxy.setOnline(true);
    psProxy.setOnline(true);
    await sleep(500);
    t3Proxy.setOnline(false);
    psProxy.setOnline(false);
    await sleep(300);
  }
  t3Proxy.setOnline(true);
  psProxy.setOnline(true);
  step("client network restored");

  const result = await page.evaluate(async () => {
    const offlineResult = await window.__offlineDispatch;
    await window.__t3PowerSyncSmoke.waitForProject("Offline Bravo", 60_000);
    await window.__t3PowerSyncSmoke.waitForProject("Remote Charlie", 60_000);
    const latest = window.__t3PowerSyncSmoke.snapshots.at(-1);
    await window.__t3PowerSyncSmoke.dispose();
    return {
      offlineResult,
      projectTitles: latest.projects.map((project) => project.title).toSorted(),
      snapshotSequence: latest.snapshotSequence,
    };
  });
  step("browser observed all synced projects");

  if (!result.offlineResult.ok) {
    throw new Error(`Offline dispatch failed after reconnect: ${result.offlineResult.error}`);
  }
  for (const title of ["Online Alpha", "Offline Bravo", "Remote Charlie"]) {
    if (!result.projectTitles.includes(title)) {
      throw new Error(`Missing project in synced UI read model: ${title}`);
    }
  }
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
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
