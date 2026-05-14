export {
  getEnvironmentHttpBaseUrl,
  getSavedEnvironmentRecord,
  getSavedEnvironmentRuntimeState,
  hasSavedEnvironmentRegistryHydrated,
  listSavedEnvironmentRecords,
  resetSavedEnvironmentRegistryStoreForTests,
  resetSavedEnvironmentRuntimeStoreForTests,
  resolveEnvironmentHttpUrl,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
  waitForSavedEnvironmentRegistryHydration,
  type SavedEnvironmentRecord,
  type SavedEnvironmentRuntimeState,
} from "./catalog";

export {
  addSavedEnvironment,
  connectDesktopSshEnvironment,
  disconnectSavedEnvironment,
  ensureEnvironmentConnectionBootstrapped,
  getPrimaryEnvironmentConnection,
  hydrateCachedPrimaryPowerSyncShellSnapshot,
  readEnvironmentConnection,
  reconnectSavedEnvironment,
  removeSavedEnvironment,
  requireEnvironmentConnection,
  resetEnvironmentServiceForTests,
  startEnvironmentConnectionService,
  subscribeEnvironmentConnections,
} from "./service";

export type { EnvironmentConnection } from "./connection";
