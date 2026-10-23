// The host and plugin vocabularies are checked in the direction they cross the boundary.
import type { PluginChannelCapability, PluginIncomingMessage, PluginTool, PluginToolContext } from "../../plugins/types";
import type { ChannelCapability, IncomingMessage } from "../channels/types";
import type { ToolRiskLevel } from "../permission-policy";
import type { ToolContext } from "../orchestrator/tools/registry/tool-context";
import type { ToolDefinition, ToolEffectKind, VerificationPolicy } from "../orchestrator/tools/registry/tool-registry";
import type { ConversationMode } from "../../shared/chat-types";

type MustHold<Proof extends true> = Proof;
type Assignable<Source, Destination> = Source extends Destination ? true : false;

// Plugin declarations are narrower than the host's accepted policy values.
type RiskBoundary = MustHold<Assignable<NonNullable<PluginTool["risk"]>, ToolRiskLevel>>;
type EffectsBoundary = MustHold<Assignable<NonNullable<PluginTool["effectKind"]>, ToolEffectKind>>;
type VerificationBoundary = MustHold<Assignable<NonNullable<PluginTool["verificationPolicy"]>, VerificationPolicy>>;
type LedgerBoundary = MustHold<Assignable<NonNullable<PluginTool["ledgerPolicy"]>, NonNullable<ToolDefinition["ledgerPolicy"]>>>;
type ModeBoundary = MustHold<Assignable<NonNullable<PluginTool["modes"]>[number], ConversationMode>>;

// Capabilities flow into the host; normalized context and inbound messages flow out.
type CapabilityBoundary = MustHold<Assignable<PluginChannelCapability, ChannelCapability>>;
type ExecutionContextBoundary = MustHold<Assignable<ToolContext, PluginToolContext>>;
type InboundBoundary = MustHold<Assignable<IncomingMessage, PluginIncomingMessage>>;
// Outgoing plugin parts intentionally admit additional kinds and are not constrained here.