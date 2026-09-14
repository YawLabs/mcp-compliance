import { describe, expect, it } from "vitest";
import {
  INTERNAL_HOSTNAME_PATTERN,
  INTERNAL_IP_PATTERNS,
  STACK_TRACE_PATTERNS,
  WINDOWS_PATH_PATTERN,
} from "../checks/patterns.js";

/**
 * The leak signatures in src/checks/patterns.ts, exercised on the text
 * the suites actually scan: JSON-serialised error objects (so `\n` is a
 * two-character escape and a path separator is a doubled backslash) plus
 * the occasional raw non-JSON body.
 */

/** A JSON-RPC error object serialised the way the suites hold their samples. */
const json = (message: string) => JSON.stringify({ code: -32603, message });

function firstHit(patterns: RegExp[], text: string): string | null {
  for (const pattern of patterns) {
    const m = pattern.exec(text);
    if (m) return m[0];
  }
  return null;
}

describe("WINDOWS_PATH_PATTERN", () => {
  it("matches drive + 2 segments in the JSON-escaped form, any drive-letter case", () => {
    expect(WINDOWS_PATH_PATTERN.exec(json("ENOENT: open 'C:\\Users\\svc\\app\\config.json'"))?.[0]).toBe(
      "C:\\\\Users\\\\svc",
    );
    expect(WINDOWS_PATH_PATTERN.exec(json("open c:\\users\\svc\\app"))?.[0]).toBe("c:\\\\users\\\\svc");
    // Segments starting with a JSON escape letter are fine when the separator is doubled.
    expect(WINDOWS_PATH_PATTERN.exec(json("at C:\\temp\\node_modules\\x.js"))?.[0]).toBe("C:\\\\temp\\\\node_modules");
  });

  it("matches the raw (non-JSON) form too", () => {
    expect(WINDOWS_PATH_PATTERN.exec("ENOENT: open C:\\Users\\svc\\app")?.[0]).toBe("C:\\Users\\svc");
  });

  it("does not mistake an uppercase letter, a colon and a JSON newline/tab escape for a drive", () => {
    expect(WINDOWS_PATH_PATTERN.test(json("ERROR:\n  Expected string\n  Received number"))).toBe(false);
    expect(WINDOWS_PATH_PATTERN.test(json("Validation failed at X:\n\tname\n\tage"))).toBe(false);
    expect(WINDOWS_PATH_PATTERN.test(json("Schema mismatch at $.a:\r\n  b\r\n  c"))).toBe(false);
    expect(firstHit(STACK_TRACE_PATTERNS, json("ERROR:\n  Expected string\n  Received number"))).toBeNull();
  });

  it("is the Windows entry of STACK_TRACE_PATTERNS", () => {
    expect(STACK_TRACE_PATTERNS).toContain(WINDOWS_PATH_PATTERN);
    expect(firstHit(STACK_TRACE_PATTERNS, json("open c:\\users\\svc\\app"))).toBe("c:\\\\users\\\\svc");
  });
});

describe("IPv6 loopback", () => {
  it("matches ::1 in its usual forms", () => {
    expect(firstHit(INTERNAL_IP_PATTERNS, json("connect ECONNREFUSED ::1:5432"))).toBe("::1");
    expect(firstHit(INTERNAL_IP_PATTERNS, json("listening on [::1]:5432"))).toBe("::1");
    expect(firstHit(INTERNAL_IP_PATTERNS, json("upstream http://[::1]/health failed"))).toBe("::1");
    expect(firstHit(INTERNAL_IP_PATTERNS, "::1")).toBe("::1");
  });

  it("does not match a public address that merely ends in ::1", () => {
    expect(firstHit(INTERNAL_IP_PATTERNS, json("2001:db8::1 unreachable"))).toBeNull();
    expect(firstHit(INTERNAL_IP_PATTERNS, json("2001:db8::10 unreachable"))).toBeNull();
  });
});

describe("INTERNAL_HOSTNAME_PATTERN", () => {
  it("matches internal hostnames with two labels before the suffix", () => {
    expect(INTERNAL_HOSTNAME_PATTERN.exec(json("getaddrinfo ENOTFOUND db01.corp.internal"))?.[0]).toBe(
      "db01.corp.internal",
    );
    expect(INTERNAL_HOSTNAME_PATTERN.exec(json("connect to redis.svc.local failed"))?.[0]).toBe("redis.svc.local");
  });

  it("matches a single-label host only with hostname context: a port, a URL, a mailbox or a resolver error", () => {
    expect(INTERNAL_HOSTNAME_PATTERN.exec(json("upstream cache.lan:6379 refused"))?.[0]).toBe("cache.lan");
    expect(INTERNAL_HOSTNAME_PATTERN.exec(json("GET https://vault.internal/v1/secret"))?.[0]).toBe("vault.internal");
    expect(INTERNAL_HOSTNAME_PATTERN.exec(json("ssh deploy@build.corp refused"))?.[0]).toBe("build.corp");
    expect(INTERNAL_HOSTNAME_PATTERN.exec(json("getaddrinfo ENOTFOUND cache.internal"))?.[0]).toBe("cache.internal");
    expect(INTERNAL_HOSTNAME_PATTERN.exec(json("getaddrinfo EAI_AGAIN ldap.intranet"))?.[0]).toBe("ldap.intranet");
  });

  it("does not match a public hostname whose label merely starts with a suffix word", () => {
    for (const text of [
      "getaddrinfo ENOTFOUND foo.internal-api.example.com",
      "upstream api.corp-services.example.com refused",
      "see https://example.lan-party.com",
      "https://intranet.example.com/",
    ]) {
      expect(INTERNAL_HOSTNAME_PATTERN.exec(json(text))?.[0], text).toBeUndefined();
      expect(firstHit(INTERNAL_IP_PATTERNS, json(text)), text).toBeNull();
    }
  });

  it("does not match property paths, identifiers or dotted file names", () => {
    for (const text of [
      "TypeError: ctx.internal is not a function",
      "Cannot read ctx.local of undefined",
      "config key settings.local is invalid",
      "Model.Local failed",
      "cannot read settings.local.json",
      "package.lan.json missing",
    ]) {
      expect(INTERNAL_HOSTNAME_PATTERN.exec(json(text))?.[0], text).toBeUndefined();
      expect(firstHit(INTERNAL_IP_PATTERNS, json(text)), text).toBeNull();
    }
  });

  it("is the hostname entry of INTERNAL_IP_PATTERNS", () => {
    expect(INTERNAL_IP_PATTERNS).toContain(INTERNAL_HOSTNAME_PATTERN);
  });
});
