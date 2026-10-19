import { expect, test } from "vitest";
import { redactSecrets } from "./redact";

test("masks known secrets and key-value patterns", () => {
  expect(redactSecrets("pw hunter22 end", ["hunter22"])).toBe("pw *** end");
  expect(redactSecrets("NZWH_PASSWORD=abc123 x", [])).toBe("NZWH_PASSWORD=*** x");
  expect(redactSecrets('token: "zzz"', [])).toBe('token: "***"');
  expect(redactSecrets("keep ab", ["ab", undefined])).toBe("keep ab");
});

test("CapSolver credentials are redacted by field name", () => {
  for (const name of ["clientKey", "apiKey", "api_key", "CAPSOLVER_API_KEY", "TWOCAPTCHA_API_KEY", "AUTOCAPTCHA_API_KEY"])
    expect(redactSecrets(`${name}=super-secret`, [])).toBe(`${name}=***`);
});
