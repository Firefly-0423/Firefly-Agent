import { isDeepStrictEqual } from "node:util";
import Ajv from "ajv";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import type { JsonSchemaType, JsonSchemaValidator, jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";
import { raceWithSignal } from "../utils/abort-utils";

type McpTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];
type OutputValidator = ReturnType<AjvJsonSchemaValidator["getValidator"]>;
const MAX_PAGES = 100;
const MAX_TOOLS = 10_000;
const DISCOVERY_TIMEOUT_MS = 60_000;
const uriResolver = new Ajv().opts.uriResolver!;
const SCHEMA_MAPS = new Set(["$defs", "definitions", "properties", "patternProperties", "dependencies", "dependentSchemas"]);
const SCHEMA_ARRAYS = new Set(["items", "prefixItems", "allOf", "anyOf", "oneOf"]);
const LITERAL_VALUES = new Set(["const", "default", "enum", "examples", "required"]);
const normalizeId = (id: string) => id.replace(/#\/?$/, "");

/** Check resource identities before the SDK's cache lookup; retain its formats and cross-schema refs. */
export function createMcpSchemaValidator(): jsonSchemaValidator {
  const shared = new AjvJsonSchemaValidator();
  const compiled = new WeakMap<JsonSchemaType, OutputValidator>();
  const resources = new Map<string, Record<string, unknown>>();
  function reserve(id: string, schema: Record<string, unknown>): void {
    if (!id) return;
    const normalized = { ...schema, ...(typeof schema.$id === "string" ? { $id: id } : {}) };
    const previous = resources.get(id);
    if (previous && !isDeepStrictEqual(previous, normalized)) throw new Error(`Conflicting MCP output schema resource: ${id}`);
    resources.set(id, normalized);
  }
  function inspect(value: unknown, base: string): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const schema = value as Record<string, unknown>;
    if (typeof schema.$id === "string") {
      base = normalizeId(uriResolver.resolve(base, normalizeId(schema.$id)));
      reserve(base, schema);
    }
    for (const anchor of [schema.$anchor, schema.$dynamicAnchor]) {
      if (base && typeof anchor === "string") reserve(uriResolver.resolve(base, `#${anchor}`), schema);
    }
    // Visit schema positions, keeping literal const/default/enum/example data opaque.
    for (const [key, child] of Object.entries(schema)) {
      if (LITERAL_VALUES.has(key)) continue;
      if (Array.isArray(child)) {
        if (SCHEMA_ARRAYS.has(key)) for (const item of child) inspect(item, base);
      } else if (SCHEMA_MAPS.has(key) && child && typeof child === "object") {
        for (const item of Object.values(child)) inspect(item, base);
      } else inspect(child, base);
    }
  }
  return {
    getValidator<T>(schema: JsonSchemaType) {
      let validator = compiled.get(schema);
      if (!validator) {
        inspect(schema, "");
        validator = shared.getValidator(schema);
        compiled.set(schema, validator);
      }
      return validator as JsonSchemaValidator<T>;
    },
  };
}

/** SDK listTools replaces its metadata cache per page. Keep a complete, connection-owned catalog. */
export async function discoverMcpToolCatalog(client: Client, connectionSignal: AbortSignal, provider = createMcpSchemaValidator()) {
  const controller = new AbortController();
  const onClose = () => controller.abort(new Error("MCP connection closed during discovery"));
  connectionSignal.addEventListener("abort", onClose, { once: true });
  if (connectionSignal.aborted) onClose();
  const deadline = Date.now() + DISCOVERY_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(new Error("MCP discovery deadline exceeded")), DISCOVERY_TIMEOUT_MS);
  const checkActive = () => {
    if (Date.now() >= deadline && !controller.signal.aborted) controller.abort(new Error("MCP discovery deadline exceeded"));
    if (controller.signal.aborted) throw controller.signal.reason;
  };
  try {
    const tools: McpTool[] = [], names = new Set<string>(), cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; ; page++) {
      checkActive();
      if (page >= MAX_PAGES) throw new Error("MCP discovery page limit exceeded");
      const pending = client.listTools(cursor === undefined ? undefined : { cursor },
        { signal: controller.signal, timeout: Math.max(1, deadline - Date.now()) });
      // Observe late failures even if a transport aborts synchronously inside listTools.
      void pending.catch(() => {});
      const result = await raceWithSignal(pending, controller.signal);
      checkActive();
      if (tools.length + result.tools.length > MAX_TOOLS) throw new Error("MCP discovery tool limit exceeded");
      for (const tool of result.tools) {
        if (names.has(tool.name)) throw new Error(`Duplicate MCP tool name: ${tool.name}`);
        names.add(tool.name);
        tools.push(tool);
      }
      if (result.nextCursor === undefined) break;
      if (cursors.has(result.nextCursor)) throw new Error("MCP discovery cursor cycle");
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }

    const validators = new Map<string, OutputValidator>();
    for (const tool of tools) {
      checkActive();
      const schema = tool.outputSchema;
      if (!schema) continue;
      validators.set(tool.name, provider.getValidator(schema));
    }
    checkActive();
    return {
      tools,
      validateResult(tool: McpTool, result: Awaited<ReturnType<Client["callTool"]>>): void {
        const validator = validators.get(tool.name);
        if (!validator) return;
        if (result.structuredContent === undefined) {
          if (result.isError !== true) throw new Error(`MCP tool ${tool.name} did not return required structured content`);
          return;
        }
        const validation = validator(result.structuredContent);
        if (!validation.valid) throw new Error(`MCP tool ${tool.name} output schema validation failed: ${validation.errorMessage}`);
      },
    };
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    connectionSignal.removeEventListener("abort", onClose);
  }
}
