import {
  attachEnvironmentDescriptor,
  createKnownEnvironment,
  type KnownEnvironment,
} from "@t3tools/client-runtime";
import {
  ExecutionEnvironmentDescriptor as ExecutionEnvironmentDescriptorSchema,
  type EnvironmentId,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";

import { BootstrapHttpError, retryTransientBootstrap } from "./auth";

import { readPrimaryEnvironmentTarget, resolvePrimaryEnvironmentHttpUrl } from "./target";

const SERVER_ENVIRONMENT_DESCRIPTOR_PATH = "/.well-known/t3/environment";
const PRIMARY_ENVIRONMENT_DESCRIPTOR_STORAGE_KEY = "t3code:primary-environment-descriptor:v1";
const isExecutionEnvironmentDescriptor = Schema.is(ExecutionEnvironmentDescriptorSchema);

interface PrimaryEnvironmentBootstrapState {
  readonly descriptor: ExecutionEnvironmentDescriptor | null;
  readonly setDescriptor: (descriptor: ExecutionEnvironmentDescriptor | null) => void;
  readonly reset: () => void;
}

const usePrimaryEnvironmentBootstrapStore = create<PrimaryEnvironmentBootstrapState>()((set) => ({
  descriptor: null,
  setDescriptor: (descriptor) => set({ descriptor }),
  reset: () => set({ descriptor: null }),
}));

let primaryEnvironmentDescriptorPromise: Promise<ExecutionEnvironmentDescriptor> | null = null;

function getPrimaryEnvironmentTargetKey(): string | null {
  const primaryTarget = readPrimaryEnvironmentTarget();
  if (!primaryTarget) {
    return null;
  }
  return `${primaryTarget.target.httpBaseUrl}\n${primaryTarget.target.wsBaseUrl}`;
}

function readStoredPrimaryEnvironmentDescriptor(): ExecutionEnvironmentDescriptor | null {
  if (typeof window === "undefined" || !("localStorage" in window)) {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(PRIMARY_ENVIRONMENT_DESCRIPTOR_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as {
      readonly targetKey?: unknown;
      readonly descriptor?: unknown;
    };
    if (
      parsed.targetKey !== getPrimaryEnvironmentTargetKey() ||
      !isExecutionEnvironmentDescriptor(parsed.descriptor)
    ) {
      return null;
    }
    return parsed.descriptor;
  } catch {
    return null;
  }
}

function writeStoredPrimaryEnvironmentDescriptor(
  descriptor: ExecutionEnvironmentDescriptor | null,
): void {
  if (typeof window === "undefined" || !("localStorage" in window)) {
    return;
  }

  try {
    if (!descriptor) {
      window.localStorage.removeItem(PRIMARY_ENVIRONMENT_DESCRIPTOR_STORAGE_KEY);
      return;
    }
    const targetKey = getPrimaryEnvironmentTargetKey();
    if (!targetKey) {
      return;
    }
    window.localStorage.setItem(
      PRIMARY_ENVIRONMENT_DESCRIPTOR_STORAGE_KEY,
      JSON.stringify({ targetKey, descriptor }),
    );
  } catch {
    // Storage failures should never block boot; the network descriptor refresh remains authoritative.
  }
}

function createPrimaryKnownEnvironment(input: {
  readonly source: KnownEnvironment["source"];
  readonly target: KnownEnvironment["target"];
}): KnownEnvironment | null {
  const descriptor = readPrimaryEnvironmentDescriptor();
  if (!descriptor) {
    return null;
  }

  return attachEnvironmentDescriptor(
    createKnownEnvironment({
      id: descriptor.environmentId,
      label: descriptor.label,
      source: input.source,
      target: input.target,
    }),
    descriptor,
  );
}

async function fetchPrimaryEnvironmentDescriptor(): Promise<ExecutionEnvironmentDescriptor> {
  return retryTransientBootstrap(async () => {
    const response = await fetch(
      resolvePrimaryEnvironmentHttpUrl(SERVER_ENVIRONMENT_DESCRIPTOR_PATH),
    );
    if (!response.ok) {
      throw new BootstrapHttpError({
        message: `Failed to load server environment descriptor (${response.status}).`,
        status: response.status,
      });
    }

    const descriptor = (await response.json()) as ExecutionEnvironmentDescriptor;
    writePrimaryEnvironmentDescriptor(descriptor);
    return descriptor;
  });
}

export function readPrimaryEnvironmentDescriptor(): ExecutionEnvironmentDescriptor | null {
  return (
    usePrimaryEnvironmentBootstrapStore.getState().descriptor ??
    readStoredPrimaryEnvironmentDescriptor()
  );
}

export function usePrimaryEnvironmentId(): EnvironmentId | null {
  const environmentId = usePrimaryEnvironmentBootstrapStore(
    (state) => state.descriptor?.environmentId ?? null,
  );
  return environmentId ?? readStoredPrimaryEnvironmentDescriptor()?.environmentId ?? null;
}

export function writePrimaryEnvironmentDescriptor(
  descriptor: ExecutionEnvironmentDescriptor | null,
): void {
  usePrimaryEnvironmentBootstrapStore.getState().setDescriptor(descriptor);
  writeStoredPrimaryEnvironmentDescriptor(descriptor);
}

export function getPrimaryKnownEnvironment(): KnownEnvironment | null {
  const primaryTarget = readPrimaryEnvironmentTarget();
  if (!primaryTarget) {
    return null;
  }

  return createPrimaryKnownEnvironment({
    source: primaryTarget.source,
    target: primaryTarget.target,
  });
}

export function resolveInitialPrimaryEnvironmentDescriptor(): Promise<ExecutionEnvironmentDescriptor> {
  const descriptor = readPrimaryEnvironmentDescriptor();
  if (descriptor) {
    writePrimaryEnvironmentDescriptor(descriptor);
    return Promise.resolve(descriptor);
  }

  if (primaryEnvironmentDescriptorPromise) {
    return primaryEnvironmentDescriptorPromise;
  }

  const nextPromise = fetchPrimaryEnvironmentDescriptor();
  primaryEnvironmentDescriptorPromise = nextPromise;
  return nextPromise.finally(() => {
    if (primaryEnvironmentDescriptorPromise === nextPromise) {
      primaryEnvironmentDescriptorPromise = null;
    }
  });
}

export function __resetPrimaryEnvironmentBootstrapForTests(): void {
  primaryEnvironmentDescriptorPromise = null;
  usePrimaryEnvironmentBootstrapStore.getState().reset();
  writeStoredPrimaryEnvironmentDescriptor(null);
}

export const resetPrimaryEnvironmentDescriptorForTests = __resetPrimaryEnvironmentBootstrapForTests;

export const __resetPrimaryEnvironmentDescriptorBootstrapForTests =
  __resetPrimaryEnvironmentBootstrapForTests;
