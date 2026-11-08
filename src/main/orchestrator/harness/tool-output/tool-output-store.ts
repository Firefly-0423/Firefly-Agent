import type * as Contract from "./types";

// Keep the store's public type surface separate from its implementations.
export type ToolOutputStore = Contract.ToolOutputStore;
export type ToolOutputRef = Contract.ToolOutputRef;
export type PutToolOutputInput = Contract.PutToolOutputInput;
export type ReadToolOutputInput = Contract.ReadToolOutputInput;
export type ReadToolOutputResult = Contract.ReadToolOutputResult;
export type FindToolOutputInput = Contract.FindToolOutputInput;
export type FindToolOutputResult = Contract.FindToolOutputResult;
