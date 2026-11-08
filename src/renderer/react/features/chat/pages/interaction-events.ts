import type { SettingsApprovalApi } from "./chat-page-bridge";
import { permissionInteraction } from "./chat-page-normalizers";
import { normalizePopQuizCard, type ComposerInteraction } from "../components/run-presentation";

type ListenerHost = {
  deliver(runId: string | undefined, card: () => ComposerInteraction, stage: "waiting_permission" | "waiting_user"): void;
  remove(kind: "permission" | "quiz", id: string): void;
};

export function observePermissionEvents(api: SettingsApprovalApi, host: ListenerHost): () => void {
  const request = api.onPermissionApprovalRequest(value => host.deliver(value.runId, () => permissionInteraction(value), "waiting_permission"));
  const settled = api.onPermissionApprovalSettled(value => host.remove("permission", value.id));
  return () => { request(); settled(); };
}

export function observeQuizEvents(api: SettingsApprovalApi, host: ListenerHost): () => void {
  const request = api.onPopQuizRequest(value => {
    const card = normalizePopQuizCard(value);
    if (card) host.deliver(value.runId, () => card, "waiting_user");
  });
  const settled = api.onPopQuizSettled(value => {
    if (value.reason !== "submitted") host.remove("quiz", value.quizId);
  });
  return () => { request(); settled(); };
}
