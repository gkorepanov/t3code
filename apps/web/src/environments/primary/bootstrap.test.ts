import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvironmentId } from "@t3tools/contracts";

import {
  getPrimaryKnownEnvironment,
  resolveInitialPrimaryEnvironmentDescriptor,
  resetPrimaryEnvironmentDescriptorForTests,
  writePrimaryEnvironmentDescriptor,
} from ".";

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
    },
    status: 200,
    ...init,
  });
}

const BASE_ENVIRONMENT = {
  environmentId: "environment-local",
  label: "Local environment",
  platform: {
    os: "darwin",
    arch: "arm64",
  },
  serverVersion: "0.0.0-test",
  capabilities: {
    repositoryIdentity: true,
    powerSync: false,
  },
};
const PRIMARY_ENVIRONMENT_DESCRIPTOR_STORAGE_KEY = "t3code:primary-environment-descriptor:v1";

function createLocalStorageStub(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  } as Storage;
}

function installTestBrowser(url: string) {
  vi.stubGlobal("window", {
    location: new URL(url),
    history: {
      replaceState: vi.fn(),
    },
    localStorage: createLocalStorageStub(),
  });
}

describe("environmentBootstrap", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    installTestBrowser("http://localhost/");
  });

  afterEach(() => {
    resetPrimaryEnvironmentDescriptorForTests();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("attaches the bootstrapped environment descriptor to the primary environment", () => {
    vi.stubGlobal("window", {
      location: {
        origin: "http://localhost:3773",
      },
      desktopBridge: undefined,
    });
    writePrimaryEnvironmentDescriptor({
      environmentId: EnvironmentId.make("environment-local"),
      label: "Bootstrapped environment",
      platform: {
        os: "darwin",
        arch: "arm64",
      },
      serverVersion: "0.0.0-test",
      capabilities: {
        repositoryIdentity: true,
        powerSync: false,
      },
    });

    expect(getPrimaryKnownEnvironment()).toEqual({
      id: "environment-local",
      label: "Bootstrapped environment",
      source: "window-origin",
      environmentId: "environment-local",
      target: {
        httpBaseUrl: "http://localhost:3773/",
        wsBaseUrl: "ws://localhost:3773/",
      },
    });
  });

  it("reuses an in-flight descriptor bootstrap request", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(BASE_ENVIRONMENT));
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([
      resolveInitialPrimaryEnvironmentDescriptor(),
      resolveInitialPrimaryEnvironmentDescriptor(),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("http://localhost/.well-known/t3/environment");
  });

  it("hydrates the primary environment descriptor from local storage before network refresh", async () => {
    window.localStorage.setItem(
      PRIMARY_ENVIRONMENT_DESCRIPTOR_STORAGE_KEY,
      JSON.stringify({
        targetKey: "http://localhost/\nws://localhost/",
        descriptor: BASE_ENVIRONMENT,
      }),
    );
    vi.stubGlobal("fetch", vi.fn<typeof fetch>());

    expect(getPrimaryKnownEnvironment()?.environmentId).toBe(BASE_ENVIRONMENT.environmentId);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses https descriptor urls when the primary environment uses wss", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(BASE_ENVIRONMENT));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VITE_HTTP_URL", "https://remote.example.com");
    vi.stubEnv("VITE_WS_URL", "wss://remote.example.com");

    await expect(resolveInitialPrimaryEnvironmentDescriptor()).resolves.toEqual(BASE_ENVIRONMENT);
    expect(fetchMock).toHaveBeenCalledWith("https://remote.example.com/.well-known/t3/environment");
  });

  it("derives the websocket url when only VITE_HTTP_URL is configured", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(BASE_ENVIRONMENT));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VITE_HTTP_URL", "https://remote.example.com");

    await expect(resolveInitialPrimaryEnvironmentDescriptor()).resolves.toEqual(BASE_ENVIRONMENT);
    expect(fetchMock).toHaveBeenCalledWith("https://remote.example.com/.well-known/t3/environment");
    expect(getPrimaryKnownEnvironment()?.target).toEqual({
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
    });
  });

  it("derives the http url when only VITE_WS_URL is configured", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(BASE_ENVIRONMENT));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VITE_WS_URL", "wss://remote.example.com");

    await expect(resolveInitialPrimaryEnvironmentDescriptor()).resolves.toEqual(BASE_ENVIRONMENT);
    expect(fetchMock).toHaveBeenCalledWith("https://remote.example.com/.well-known/t3/environment");
    expect(getPrimaryKnownEnvironment()?.target).toEqual({
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
    });
  });

  it("uses the current origin as the descriptor base for local dev environments", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(BASE_ENVIRONMENT));
    vi.stubGlobal("fetch", fetchMock);
    installTestBrowser("http://localhost:5735/");

    await expect(resolveInitialPrimaryEnvironmentDescriptor()).resolves.toEqual(BASE_ENVIRONMENT);
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:5735/.well-known/t3/environment");
  });

  it("uses the vite proxy for desktop-managed loopback descriptor requests during local dev", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(BASE_ENVIRONMENT));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VITE_DEV_SERVER_URL", "http://127.0.0.1:5733");
    vi.stubGlobal("window", {
      location: new URL("http://127.0.0.1:5733/"),
      history: {
        replaceState: vi.fn(),
      },
      desktopBridge: {
        getLocalEnvironmentBootstrap: () => ({
          label: "Local environment",
          httpBaseUrl: "http://127.0.0.1:3773",
          wsBaseUrl: "ws://127.0.0.1:3773",
          bootstrapToken: "desktop-bootstrap-token",
        }),
      },
    });

    await expect(resolveInitialPrimaryEnvironmentDescriptor()).resolves.toEqual(BASE_ENVIRONMENT);
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:5733/.well-known/t3/environment");
  });
});
