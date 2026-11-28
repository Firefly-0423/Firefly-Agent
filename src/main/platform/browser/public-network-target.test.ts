import { describe, expect, it } from "vitest";
import { isPublicNetworkAddress, parseConnectAuthority } from "./public-network-target";

describe("browser public network targets", () => {
  it.each(["93.184.216.34", "8.8.8.8", "2001:4860:4860::8888", "2606:4700:4700::1111"])("accepts global unicast %s", (ip) => {
    expect(isPublicNetworkAddress(ip)).toBe(true);
  });
  it.each(["", "example.com", "127.0.0.1", "0.1.2.3", "10.0.0.1", "100.64.0.1", "169.254.169.254", "172.16.0.1", "192.168.0.1", "192.0.0.9", "192.0.2.1", "192.88.99.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255", "::", "::1", "fc00::1", "fe80::1", "fe80::1%1", "ff02::1", "::ffff:127.0.0.1", "::ffff:93.184.216.34", "2001:db8::1", "2002:0808:0808::1", "64:ff9b::808:808", "3fff::1", "2001::1"])("rejects special or ambiguous %s", (ip) => {
    expect(isPublicNetworkAddress(ip)).toBe(false);
  });
  it.each(["example.com:443", "EXAMPLE.COM:443", "93.184.216.34:443", "[2606:4700:4700::1111]:443"])("parses explicit HTTPS authority %s", (value) => {
    expect(parseConnectAuthority(value)?.port).toBe(443);
  });
  it.each(["example.com", "example.com:80", "example.com:0443", "https://example.com:443", "user@example.com:443", "example.com:443/path", "example.com:443?x", "example.com:443#x", "example.com.:443", "bad_name.com:443", "-bad.com:443", "localhost:443", "[fe80::1%1]:443", "example%2ecom:443", " example.com:443", "example.com:443\r\n"])("rejects authority ambiguity %s", (value) => {
    expect(parseConnectAuthority(value)).toBeNull();
  });
});
