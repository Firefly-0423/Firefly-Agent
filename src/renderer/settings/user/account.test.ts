// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyTranslations, setLocale } from "../i18n";
import {
  buildAccountCardView,
  getAccountState,
  renderAccountCardDom,
  type AccountState,
} from "./account";

const html = fs.readFileSync(path.resolve("src/renderer/settings/index.html"), "utf8");

function mountAccountCard(): HTMLElement {
  const start = html.indexOf('<div class="settings-list account-card" id="account-card">');
  const end = html.indexOf('<h2 class="settings-group-title"><span data-i18n="panel.user.profileTitle">');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const root = document.createElement("div");
  root.innerHTML = html.slice(start, end);
  document.body.innerHTML = "";
  document.body.append(root);
  return root;
}

afterEach(() => {
  setLocale("zh-CN");
  document.body.innerHTML = "";
});

describe("account state view model", () => {
  it("reports the current runtime state as signed-out, with no fake sign-in", () => {
    expect(getAccountState()).toEqual({ status: "signed-out" });
  });

  it("builds a disabled login view for signed-out state", () => {
    const view = buildAccountCardView({ status: "signed-out" });
    expect(view).toEqual({
      status: "signed-out",
      displayName: null,
      email: null,
      avatarUrl: null,
      loginDisabled: true,
    });
  });

  it("keeps trimmed name and email, and https avatars, for signed-in state", () => {
    const state: AccountState = {
      status: "signed-in",
      displayName: "  流萤用户  ",
      email: " user@example.com ",
      avatarUrl: "https://cdn.example.com/a.png",
    };
    const view = buildAccountCardView(state);
    expect(view.status).toBe("signed-in");
    expect(view.displayName).toBe("流萤用户");
    expect(view.email).toBe("user@example.com");
    expect(view.avatarUrl).toBe("https://cdn.example.com/a.png");
    expect(view.loginDisabled).toBe(true);
  });

  it("falls back for missing or unusable signed-in fields", () => {
    const view = buildAccountCardView({ status: "signed-in", displayName: "   " });
    expect(view.displayName).toBeNull();
    expect(view.email).toBeNull();
    expect(view.avatarUrl).toBeNull();
  });

  it("rejects non-https and malformed avatar urls", () => {
    for (const avatarUrl of ["javascript:alert(1)", "http://insecure.example/a.png", "data:image/png;base64,AAAA", "not a url", ""]) {
      expect(buildAccountCardView({ status: "signed-in", displayName: "a", avatarUrl }).avatarUrl).toBeNull();
    }
  });
});

describe("account card DOM", () => {
  it("renders the signed-out row with a disabled login button and the coming-soon hint", () => {
    const root = mountAccountCard();
    renderAccountCardDom(buildAccountCardView({ status: "signed-out" }));

    const signedOut = root.querySelector<HTMLElement>("#account-signed-out")!;
    const signedIn = root.querySelector<HTMLElement>("#account-signed-in")!;
    const loginButton = root.querySelector<HTMLButtonElement>("#account-login-btn")!;

    expect(signedOut.hidden).toBe(false);
    expect(signedIn.hidden).toBe(true);
    expect(loginButton.disabled).toBe(true);
    expect(root.textContent).toContain("即将开放");
    expect(signedOut.textContent).toContain("未登录");
  });

  it("renders the signed-in row with name, email, avatar and logout button", () => {
    const root = mountAccountCard();
    renderAccountCardDom(
      buildAccountCardView({
        status: "signed-in",
        displayName: "流萤用户",
        email: "user@example.com",
        avatarUrl: "https://cdn.example.com/a.png",
      }),
    );

    expect(root.querySelector<HTMLElement>("#account-signed-out")!.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>("#account-signed-in")!.hidden).toBe(false);
    expect(root.querySelector("#account-display-name")!.textContent).toBe("流萤用户");
    const email = root.querySelector<HTMLElement>("#account-email")!;
    expect(email.hidden).toBe(false);
    expect(email.textContent).toBe("user@example.com");
    const img = root.querySelector<HTMLImageElement>("#account-avatar-img")!;
    expect(img.hidden).toBe(false);
    expect(img.getAttribute("src")).toBe("https://cdn.example.com/a.png");
    expect(root.querySelector<HTMLElement>("#account-avatar-placeholder")!.hidden).toBe(true);
    expect(root.querySelector("#account-logout-btn")).not.toBeNull();
  });

  it("uses placeholders and hides absent fields for a signed-in state without optional data", () => {
    const root = mountAccountCard();
    renderAccountCardDom(buildAccountCardView({ status: "signed-in", displayName: "" }));

    expect(root.querySelector("#account-display-name")!.textContent).toBe("未命名账号");
    expect(root.querySelector<HTMLElement>("#account-email")!.hidden).toBe(true);
    expect(root.querySelector<HTMLImageElement>("#account-avatar-img")!.hidden).toBe(true);
    expect(root.querySelector<HTMLImageElement>("#account-avatar-img")!.hasAttribute("src")).toBe(false);
    expect(root.querySelector<HTMLElement>("#account-avatar-placeholder")!.hidden).toBe(false);
  });

  it("clears signed-in fields again when the state goes back to signed-out", () => {
    const root = mountAccountCard();
    renderAccountCardDom(buildAccountCardView({ status: "signed-in", displayName: "流萤用户", email: "u@example.com" }));
    renderAccountCardDom(buildAccountCardView({ status: "signed-out" }));

    expect(root.querySelector("#account-display-name")!.textContent).toBe("");
    expect(root.querySelector<HTMLElement>("#account-email")!.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>("#account-signed-out")!.hidden).toBe(false);
  });

  it("ships the signed-in rows hidden by default in the markup", () => {
    const root = mountAccountCard();
    expect(root.querySelector<HTMLElement>("#account-signed-in")!.hidden).toBe(true);
    expect(root.querySelector<HTMLButtonElement>("#account-login-btn")!.disabled).toBe(true);
  });

  it("translates the unnamed placeholder into English", () => {
    setLocale("en");
    const root = mountAccountCard();
    applyTranslations(root);
    renderAccountCardDom(buildAccountCardView({ status: "signed-in", displayName: "" }));
    expect(root.querySelector("#account-display-name")!.textContent).toBe("Unnamed account");
  });
});
