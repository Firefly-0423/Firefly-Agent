import {
  avatarEl, uploadAvatarBtn, userDefaultCityInput, userNicknameInput, userCallPrefInput,
  userBirthdayInput, userTimezoneSelect, userGenderGroup,
} from "./dom";
import { TIMEZONE_OPTIONS, normalizeTimezoneOptionValue } from "../timezone-options";
import { subscribeLocaleChanged } from "../i18n";
import { buildAccountCardView, getAccountState, renderAccountCardDom } from "./account";

// 先查询头像元素，再绑定事件和读取资料。
const avatarImg = avatarEl?.querySelector<HTMLImageElement>("img");
const avatarPlaceholder = avatarEl?.querySelector<HTMLElement>("span");

function showAvatar(dataUrl: string | null): void {
  if (!dataUrl || !avatarEl) return;
  if (!avatarEl) return;
  let picture = avatarEl.querySelector("img");
  if (picture === null) {
    picture = document.createElement("img");
    picture.style.width = "100%";
    picture.style.height = "100%";
    picture.style.borderRadius = "50%";
    picture.style.objectFit = "cover";
    avatarEl.appendChild(picture);
  }
  picture.src = dataUrl;
  if (avatarPlaceholder) avatarPlaceholder.style.display = "none";
}

async function loadUserProfile(): Promise<void> {
  try {
    const picture = await window.user?.getAvatar();
    if (picture) showAvatar(picture);
    if (uploadAvatarBtn) uploadAvatarBtn.disabled = false;
    const saved = await window.user?.getProfile();
    if (!saved) return;
    if (userNicknameInput) userNicknameInput.value = String(saved.nickname ?? "");
    if (userCallPrefInput) userCallPrefInput.value = String(saved.callPreference ?? "");
    if (userBirthdayInput) userBirthdayInput.value = String(saved.birthday ?? "");
    if (userDefaultCityInput) userDefaultCityInput.value = String(saved.defaultCity ?? "");
    if (userTimezoneSelect) userTimezoneSelect.value = normalizeTimezoneOptionValue(saved.timezone);
    const selectedGender = String(saved.gender ?? "secret");
    userGenderGroup?.querySelectorAll(".gender-select__btn").forEach(button => {
      button.classList.toggle("is-active", (button as HTMLElement).dataset.gender === selectedGender);
    });
  } catch {
    console.warn("[settings] load user profile failed");
  }
}

function bindUserProfileSave(input: HTMLInputElement | null, field: string, live = false): void {
  if (input === null) return;
  let pending: number | undefined;
  const persist = (): void => {
    if (pending !== undefined) window.clearTimeout(pending);
    pending = undefined;
    void window.user?.saveProfile({ [field]: input.value.trim() });
  };
  if (live) input.addEventListener("input", () => {
    if (pending !== undefined) window.clearTimeout(pending);
    pending = window.setTimeout(persist, 180);
  });
  input.addEventListener("change", persist);
  input.addEventListener("blur", persist);
}

function bindTimezone(): void {
  const control = userTimezoneSelect;
  if (!control) return;
  for (const timezone of TIMEZONE_OPTIONS) {
    const option = document.createElement("option");
    option.value = timezone.value;
    option.textContent = timezone.label;
    control.appendChild(option);
  }
  control.addEventListener("change", () => {
    const chosen = control.value;
    const validated = normalizeTimezoneOptionValue(chosen);
    if (validated !== chosen) {
      control.value = validated;
      return;
    }
    void window.user?.saveProfile({ timezone: validated });
  });
}
function bindGender(): void {
  const group = userGenderGroup;
  if (!group) return;
  group.querySelectorAll(".gender-select__btn").forEach(button => {
    button.addEventListener("click", () => {
      const gender = (button as HTMLElement).dataset.gender;
      if (!gender) return;
      group.querySelectorAll(".gender-select__btn").forEach(other => other.classList.remove("is-active"));
      button.classList.add("is-active");
      void window.user?.saveProfile({ gender });
    });
  });
}

function bindTextFields(): void {
  bindUserProfileSave(userNicknameInput, "nickname", true);
  bindUserProfileSave(userCallPrefInput, "callPreference");
  bindUserProfileSave(userBirthdayInput, "birthday");
  bindUserProfileSave(userDefaultCityInput, "defaultCity");
}
bindTextFields();
bindTimezone();
bindGender();
uploadAvatarBtn?.addEventListener("click", async () => {
  try {
    const uploaded = await window.user?.uploadAvatar();
    if (uploaded?.avatarPath) {
      const refreshed = await window.user?.getAvatar();
      if (refreshed) showAvatar(refreshed);
    }
  } catch (failure) {
    console.error("[settings] upload avatar failed", failure);
  }
});

const renderAccountCard = (): void => {
  renderAccountCardDom(buildAccountCardView(getAccountState()));
};
renderAccountCard();
subscribeLocaleChanged(renderAccountCard);
void loadUserProfile();
