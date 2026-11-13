/** Wire/storage-visible version label only. It does not confer source or actor authority. */
export const PRODUCTION_ESTIMATOR_VERSION = "firefly-prepared-estimate-v1";
export function isProductionEstimateIdentity(value: { framingVersion?: unknown; transport?: unknown }): boolean {
  if (typeof value.framingVersion !== "string") return false;
  const match = /^firefly-prepared-estimate-v1:(openai|responses|anthropic):([1-9][0-9]*):[a-f0-9]{16}$/.exec(value.framingVersion);
  return !!match && match[1] === value.transport && Number.isSafeInteger(Number(match[2]));
}
