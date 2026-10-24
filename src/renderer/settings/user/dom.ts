// 元素在模块加载时绑定，空值约定由各面板决定。
function control<T extends HTMLElement | null>(id: string): T {
  return document.getElementById(id) as T;
}

export const avatarEl = control<HTMLElement | null>("user-avatar-el");
export const uploadAvatarBtn = control<HTMLButtonElement | null>("upload-avatar-btn");
export const userDefaultCityInput = control<HTMLInputElement | null>("user-default-city");
export const userNicknameInput = control<HTMLInputElement | null>("user-nickname");
export const userCallPrefInput = control<HTMLInputElement | null>("user-call-pref");
export const userBirthdayInput = control<HTMLInputElement | null>("user-birthday");
export const userTimezoneSelect = control<HTMLSelectElement | null>("user-timezone");
export const userGenderGroup = control<HTMLElement | null>("user-gender");
