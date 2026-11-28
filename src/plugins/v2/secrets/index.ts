export {
  PLUGIN_ERROR_CODES,
  PluginError,
  isPluginError,
  type PluginErrorCode,
} from "./errors";
export {
  PLUGIN_ID_MAX_LENGTH,
  PLUGIN_ID_MIN_LENGTH,
  PLUGIN_ID_PATTERN,
  PLUGIN_SECRETS_DIRECTORY_NAME,
  SECRET_KEY_PATTERN,
  assertSafePluginSecretsPaths,
  assertValidPluginId,
  assertValidSecretKey,
  resolveDefaultDataRoot,
  resolvePluginSecretsDir,
  resolvePluginSecretsFile,
} from "./paths";
export {
  createPluginSecretsService,
  resolveElectronSafeStorage,
  type PluginSecretsService,
  type PluginSecretsServiceOptions,
  type SafeStorageLike,
  type ScopedPluginSecrets,
} from "./secrets-service";
export {
  bindPluginSecretsRpc,
  type BindPluginSecretsRpcOptions,
} from "./rpc";
