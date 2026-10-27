import { describe, expect, it } from "vitest";
import { isSensitive, mask, maskJson, shown } from "./privacy";

describe("privacy mode", () => {
  it("masks personal columns and values that look personal", () => {
    expect(shown("email", "ann@gmail.com", true)).toBe("a•••@•••.com");
    expect(shown("note", "ann@gmail.com", true)).toBe("a•••@•••.com");
    expect(shown("phone_number", "+91 98765 43210", true)).toBe("••••••••••");
    expect(shown("api_token", "abc", true)).toBe("••••");
    expect(shown("note", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig", true)).toMatch(/^•+$/);
    expect(isSensitive("status", "paid")).toBe(false);
    expect(isSensitive("created_at", "2026-10-01 10:00:00")).toBe(false);
    expect(isSensitive("total", "123.45")).toBe(false);
    expect(shown("email", "ann@gmail.com", false)).toBe("ann@gmail.com");
    expect(mask("x")).toBe("••••");
  });

  it("masks documents by key and value", () => {
    expect(maskJson({ _id: { $oid: "65f1a2b3c4d5e6f708192a3b" }, profile: { email: "a@b.co", city: "Pune" }, phones: ["+1 415 555 0100"] })).toEqual({
      _id: { $oid: "65f1a2b3c4d5e6f708192a3b" },
      profile: { email: "a•••@•••.co", city: "Pune" },
      phones: ["••••••••••"],
    });
  });
});
