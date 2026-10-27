import { describe, expect, it } from "vitest";
import { diffContexts, parseReport, reproduceStatements, unqualifiedTables } from "./context";

const report = (values: Record<string, unknown>) => parseReport(JSON.stringify({ onyx_context: 1, ...values }));

describe("execution contexts", () => {
  it("parses a pasted report, wrapped or not", () => {
    expect(parseReport(` onyx_context\n----\n {"onyx_context":1,"TimeZone":"UTC"}\n(1 row)`).values.TimeZone).toBe("UTC");
    expect(() => parseReport(`{"x":1}`)).toThrow(/isn't a Onyx context report/);
  });

  it("separates differences, incidental fields and unknowns", () => {
    const app = report({ search_path: "app, public", TimeZone: "UTC", backend_pid: 1, current_user: "app_user" });
    const onyx = report({ search_path: '"$user", public', TimeZone: "UTC", backend_pid: 2, current_user: "postgres" });
    const d = diffContexts(app, onyx);
    const by = (f: string) => d.find((x) => x.field === f)!;
    expect(by("search_path").different).toBe(true);
    expect(by("TimeZone").different).toBe(false);
    expect(by("backend_pid").incidental).toBe(true);
    // Never captured by a database view: unknown on both sides, not "same".
    expect(by("parameter_types")).toMatchObject({ appProvenance: "unknown", different: false });
    expect(reproduceStatements(d, new Set(["search_path", "current_user", "backend_pid"]))).toEqual(["SELECT set_config('search_path', 'app, public', false)", "SET ROLE app_user"]);
  });

  it("finds unqualified tables", () => {
    expect(unqualifiedTables("SELECT * FROM orders o JOIN public.items i ON true JOIN \"Users\" u ON true WHERE x IN (SELECT 1 FROM generate_series(1,2))")).toEqual(["orders", '"Users"']);
  });
});
