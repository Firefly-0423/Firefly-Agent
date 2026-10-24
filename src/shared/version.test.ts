import { describe, it, expect } from "vitest";
import { isNewerVersion, isValidPluginVersion } from "./version";

describe("plugin release version syntax", () => {
  it.each([
    "0.4.0", "3.12.7", " 2.3.4 ", "2.0.0-beta.3", "0.12.0-beta.3", "2.0.0-alpha",
    "2.0.0-alpha.beta.3", "2.0.0+build.321", "2.0.0-beta.3+build.654",
  ])("allows the complete SemVer string %s", version => {
    expect(isValidPluginVersion(version)).toEqual(true);
  });
  it.each([
    "02.3.4", "2.03.4", "2.3.04", "2.0", "2.0.0.0", "v2.0.0", "2.b.0", "2.0.0-", "2.0.0-beta..3", "",
  ])("disallows malformed release %s", version => {
    expect(isValidPluginVersion(version)).toEqual(false);
  });
});

describe("release upgrade decisions", () => {
  it.each([
    ["3.12.0", "3.9.0", true], ["3.9.0", "3.12.0", false],
    ["4.0.0", "3.99.99", true], ["3.0.2", "3.0.1", true],
    ["3.0.0", "3.0.0", false], ["invalid", "3.0.0", false], ["3.0.0", "3.0", false],
    ["0.12.0", "0.12.0-beta.3", true], ["0.12.0-beta.3", "0.12.0", false], ["3.0.0", "3.0.0-beta", true],
    ["3.0.0+build.4", "3.0.0+build.3", false], ["3.0.0+build.3", "3.0.0", false], ["3.0.0", "3.0.0+build.3", false],
  ])("compares candidate %s against %s as %s", (candidate, baseline, upgrade) => {
    expect(isNewerVersion(candidate, baseline)).toEqual(upgrade);
  });

  it("orders prerelease identifiers by numeric value, ASCII and prefix length", () => {
    const releases = ["alpha", "alpha.1", "alpha.beta", "beta", "beta.2", "beta.11", "rc.1", ""]
      .map(suffix => `3.0.0${suffix ? `-${suffix}` : ""}`);
    for (let index = 1; index < releases.length; index++) {
      expect(isNewerVersion(releases[index], releases[index - 1])).toEqual(true);
      expect(isNewerVersion(releases[index - 1], releases[index])).toEqual(false);
    }
  });
});