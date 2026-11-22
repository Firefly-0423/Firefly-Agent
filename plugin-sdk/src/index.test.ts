import { describe, expect, it } from "vitest";
import {
  definePlugin,
  PLUGIN_ERROR_CODES,
  PluginError,
  type PluginContext,
  type PluginErrorCode,
} from "./index";

describe("@firefly_wu/plugin-sdk entry", () => {
  it("exports all 9 Spec §6.1 error codes and constructs PluginError with retryable flag", () => {
    const expected: readonly PluginErrorCode[] = [
      "ERR_UNDECLARED",
      "ERR_PERMISSION",
      "ERR_REJECTED",
      "ERR_CANCELLED",
      "ERR_TIMEOUT",
      "ERR_INVALID_ARGUMENT",
      "ERR_RATE_LIMITED",
      "ERR_UNAVAILABLE",
      "ERR_INTERNAL",
    ];
    expect(PLUGIN_ERROR_CODES).toEqual(expected);

    const err = new PluginError("ERR_RATE_LIMITED", "Too many requests", true);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(PluginError);
    expect(err.name).toBe("PluginError");
    expect(err.code).toBe("ERR_RATE_LIMITED");
    expect(err.message).toBe("Too many requests");
    expect(err.retryable).toBe(true);

    const nonRetryable = new PluginError("ERR_UNDECLARED", "Missing permission");
    expect(nonRetryable.retryable).toBe(false);

    const rootCause = new Error("underlying");
    const wrapped = new PluginError("ERR_INTERNAL", "Failed", { retryable: true, cause: rootCause });
    expect(wrapped.retryable).toBe(true);
    expect(wrapped.cause).toBe(rootCause);
  });

  it("definePlugin returns the plugin object with preserved methods", async () => {
    const activated: string[] = [];
    const deactivated: string[] = [];
    const plugin = definePlugin({
      activate(ctx: PluginContext) {
        activated.push(ctx.id);
      },
      deactivate(reason) {
        deactivated.push(reason);
      },
    });

    expect(typeof plugin.activate).toBe("function");
    expect(typeof plugin.deactivate).toBe("function");
    await plugin.deactivate?.("disabled");
    expect(deactivated).toEqual(["disabled"]);
  });
});
