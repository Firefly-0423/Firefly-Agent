import { expect, it } from "vitest";
import { causeCodes } from "./runtime";

it("names the failure chain by identifiers only, leaving messages out of the log", () => {
  const reset = Object.assign(new Error("Client network socket disconnected before secure TLS connection was established to sk-secret"), { code: "ECONNRESET" });
  const error = Object.assign(new Error("Connection error."), { name: "APIConnectionError", cause: new TypeError("fetch failed", { cause: reset }) });
  expect(causeCodes(error)).toBe("APIConnectionError <- TypeError <- Error:ECONNRESET");
  expect(causeCodes("plain")).toBe("");
});

it("never logs a provider error's code, which comes from the response body", () => {
  const provider = Object.assign(new Error("bad"), { name: "BadRequestError", status: 400, code: "ECANARY_FROM_BODY" });
  expect(causeCodes(provider)).toBe("BadRequestError:400");
  expect(causeCodes(Object.assign(new Error("x"), { code: "SYNTHETIC_SECRET_ERROR_CANARY" }))).toBe("Error");
});
