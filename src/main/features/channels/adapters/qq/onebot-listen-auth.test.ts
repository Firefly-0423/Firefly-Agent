import { expect, it } from "vitest";
import { resolveQqListenAuthRequirement } from "./onebot-reverse-ws";

type Interfaces = Parameters<typeof resolveQqListenAuthRequirement>[1];
function networks(wsl: boolean): Interfaces {
  return { [wsl ? "Contract WSL adapter" : "Contract Ethernet"]: [{
    address: wsl ? "172.29.32.1" : "192.168.45.7", netmask: "255.255.255.0", family: "IPv4",
    mac: "10:20:30:40:50:60", internal: false, cidr: wsl ? "172.29.32.1/24" : "192.168.45.7/24",
  }] };
}

it.each([true, false])("resolves auto authentication requirements with WSL=%s", wsl => {
  const expected = {
    ok: true, requiresAccessToken: wsl, resolvedHost: wsl ? "172.29.32.1" : "127.0.0.1",
    resolvedMode: wsl ? "wsl" : "loopback",
  };
  expect(resolveQqListenAuthRequirement({ listenMode: "auto" }, networks(wsl))).toStrictEqual(expected);
  expect(resolveQqListenAuthRequirement({ listenMode: "loopback" }, networks(wsl)).requiresAccessToken).toEqual(false);
});

it("requires authentication on a detected WSL interface but does not mislabel discovery failure", () => {
  expect(resolveQqListenAuthRequirement({ listenMode: "wsl" }, networks(true))).toStrictEqual({
    ok: true, resolvedMode: "wsl", resolvedHost: "172.29.32.1", requiresAccessToken: true,
  });
  const missing = resolveQqListenAuthRequirement({ listenMode: "wsl" }, networks(false));
  expect(missing.ok).toEqual(false);
  expect(missing.requiresAccessToken).toEqual(false);
  expect(missing.error).toContain("WSL");
});

it.each(["localhost", "::ffff:127.0.0.1", "[::1]", "  127.0.0.1  ", "LOCALHOST", "::1", "127.0.0.1"])(
  "permits custom loopback spelling %s without authentication", customHost => {
    const requirement = resolveQqListenAuthRequirement({ listenMode: "custom", customHost }, networks(false));
    expect(requirement.ok).toEqual(true);
    expect(requirement.requiresAccessToken).toEqual(false);
    expect(requirement.resolvedHost).toEqual(customHost.trim());
  },
);

it.each(["172.29.32.1", "192.168.45.7", "::", "0.0.0.0"])("requires a token at custom address %s", customHost => {
  expect(resolveQqListenAuthRequirement({ listenMode: "custom", customHost }, networks(false)).requiresAccessToken).toEqual(true);
});

it("returns a resolution failure for a blank custom address", () => {
  const result = resolveQqListenAuthRequirement({ customHost: "\t ", listenMode: "custom" }, networks(false));
  expect(result.ok).toEqual(false);
  expect(result.requiresAccessToken).toEqual(false);
});

it.each([undefined, "unrecognized-mode"])("normalizes invalid mode %s to auto on either network layout", listenMode => {
  for (const wsl of [true, false]) expect(resolveQqListenAuthRequirement({ listenMode }, networks(wsl)))
    .toStrictEqual(resolveQqListenAuthRequirement({ listenMode: "auto" }, networks(wsl)));
});
