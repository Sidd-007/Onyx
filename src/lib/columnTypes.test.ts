import { describe, expect, it } from "vitest";
import { inferKind, typeKind } from "./columnTypes";

describe("typeKind", () => {
  it("groups Postgres and MySQL types", () => {
    expect(typeKind("int unsigned")).toBe("number");
    expect(typeKind("bigint")).toBe("number");
    expect(typeKind("numeric(10,2)")).toBe("number");
    expect(typeKind("varchar(255)")).toBe("text");
    expect(typeKind("character varying")).toBe("text");
    expect(typeKind("timestamp with time zone")).toBe("date");
    expect(typeKind("datetime")).toBe("date");
    expect(typeKind("time without time zone")).toBe("time");
    expect(typeKind("jsonb")).toBe("json");
    expect(typeKind("tinyint(1)")).toBe("bool");
    expect(typeKind("boolean")).toBe("bool");
    expect(typeKind("bytea")).toBe("binary");
    expect(typeKind(undefined)).toBe("text");
  });
});


describe("inferring kinds from values", () => {
  it("spots numbers, booleans and JSON", () => {
    expect(inferKind(["1", "2.5", null, "-3"])).toBe("number");
    expect(inferKind(["1", "007"])).toBe("text");
    expect(inferKind(["12345678901234567890"])).toBe("text");
    expect(inferKind(["true", "FALSE"])).toBe("bool");
    expect(inferKind(['{"a":1}', "[1,2]"])).toBe("json");
    expect(inferKind(["{not json"])).toBe("text");
    expect(inferKind([null, null])).toBe("text");
  });
});
