export type StructuredErrorDisposition =
  | "fail_closed" | "execution_policy" | "refresh_state" | "ask_user" | "repair";

export type StructuredErrorLayer = "business" | "schema" | "format" | "transport";

export type StructuredValidationError = {
  path?: string;
  disposition: StructuredErrorDisposition;
  code: string;
  layer: StructuredErrorLayer;
};
