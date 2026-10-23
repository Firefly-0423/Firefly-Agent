import type { SettingsApi, GeneralSettings } from "./shared/types";
import { t } from "./i18n";

/** Provider choice enables availability; recording still requires a composer click. */
export async function bindDesktopAsrSettings(root: Document, api?: Pick<SettingsApi, "getGeneral" | "saveGeneral">): Promise<void> {
  const form = root.querySelector<HTMLFormElement>("#desktop-asr-form");
  if (!form || !api) return;
  const status = form.querySelector<HTMLElement>('[role="status"]')!;
  const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
  const fields = ["asrEngine", "asrMosslandKey", "asrAliyunAppKey", "asrAliyunAccessKeyId", "asrAliyunAccessKeySecret", "asrLanguage"] as const;
  const control = (name: typeof fields[number]) => form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
  const visibility = (): void => { for (const group of form.querySelectorAll<HTMLElement>('[data-asr-provider]')) group.hidden = group.dataset.asrProvider !== control("asrEngine").value; };
  const lock = (locked: boolean): void => { submit.disabled = locked; for (const name of fields) control(name).disabled = locked; };
  lock(true);
  let loaded = false;
  let saving = false;
  control("asrEngine").addEventListener("change", visibility);
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (!loaded || saving) return;
    if (!["off", "mossland", "aliyun"].includes(control("asrEngine").value)) { status.textContent = t("settings.desktopAsr.localUnavailable"); return; }
    const patch = Object.fromEntries(fields.map(name => [name, control(name).value.trim()])) as Partial<GeneralSettings>;
    saving = true; lock(true); status.textContent = t("settings.desktopAsr.saving");
    void api.saveGeneral(patch).then(() => { status.textContent = t("settings.desktopAsr.saved"); }, () => { status.textContent = t("settings.desktopAsr.saveFailed"); }).finally(() => { saving = false; lock(false); });
  });
  try {
    const values = await api.getGeneral();
    for (const name of fields) control(name).value = String(values[name] ?? (name === "asrEngine" ? "off" : name === "asrLanguage" ? "zh" : ""));
    visibility(); loaded = true; lock(false);
  } catch { status.textContent = t("settings.desktopAsr.loadFailed"); lock(true); }
}
