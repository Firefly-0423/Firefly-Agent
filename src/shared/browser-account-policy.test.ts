import { describe, expect, it } from "vitest";
import { ACCOUNT_ACTION_LABEL_SOURCE, SENSITIVE_FIELD_SOURCE, isAccountPath } from "./browser-account-policy";

describe("account path policy", () => {
  it.each([
    "/login", "/Login/", "/users/sign_in", "/sign-in", "/signup", "/join", "/register", "/registration/new",
    "/logout", "/signout", "/oauth/authorize", "/oauth2/token", "/auth", "/sso/start", "/saml/acs",
    "/session", "/sessions/new", "/password/reset", "/forgot-password", "/2fa", "/mfa",
    "/checkout", "/cart/checkout/", "/payment", "/billing", "/wallet", "/settings", "/wp-login.php",
    "/login.php", "/signin.aspx", "/account/login",
  ])("blocks %s", (path) => {
    expect(isAccountPath(path)).toBe(true);
  });

  it.each([
    "/", "/docs/getting-started", "/blog/how-to-login-securely", "/products/join-us-today", "/loginfo",
    "/en-US/docs/Web/Security", "/authors/jane", "/oauthor", "/signing", "/accounts-payable-guide",
  ])("keeps ordinary page %s", (path) => {
    expect(isAccountPath(path)).toBe(false);
  });
});

describe("sensitive field and action patterns", () => {
  const field = new RegExp(SENSITIVE_FIELD_SOURCE, "i");
  const action = new RegExp(ACCOUNT_ACTION_LABEL_SOURCE, "i");

  it.each([
    "password", "Card number", "cc-number", "cc-csc", "cvv", "CVC", "iban", "routing number", "account_number",
    "tax id", "passport", "api-key", "private key", "seed phrase", "recovery code", "pin", "ssn", "one-time-code", "otp",
  ])("treats %s as credential-like", (text) => {
    expect(field.test(text)).toBe(true);
  });

  it.each(["search", "email subject", "spinner", "occupation", "shipping", "comment"])("allows %s", (text) => {
    expect(field.test(text)).toBe(false);
  });

  it.each(["Sign in", "log out", "Buy now", "Place order", "Checkout", "Pay", "Payment", "登录", "立即购买", "支付"])(
    "does not let the agent click %s", (label) => {
      expect(action.test(label)).toBe(true);
    });

  it.each(["Next page", "Payload", "Read more", "Count"])("lets the agent click %s", (label) => {
    expect(action.test(label)).toBe(false);
  });
});
