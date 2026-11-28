export {
  EXTERNAL_DATA_TAG,
  EXTERNAL_DATA_UNTRUSTED_POLICY,
  escapeExternalDataAttribute,
  escapeExternalDataText,
  wrapExternalData,
  type ExternalDataEnvelope,
} from "./boundary";
export {
  MAX_PLUGIN_CONTEXT_CHARS,
  MAX_PLUGIN_CONTEXT_TOTAL_CHARS,
  PLUGIN_CONTEXT_TIMEOUT_MS,
  createPluginContextService,
  type CollectPluginContextInput,
  type CollectPluginContextResult,
  type CollectedContextEntry,
  type PluginContextHost,
  type PluginContextService,
  type PluginContextServiceOptions,
  type RegisteredContextProvider,
} from "./context-service";
