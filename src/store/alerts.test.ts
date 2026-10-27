import { describe, expect, it } from "vitest";
import { evaluate } from "./alerts";

describe("query alerts", () => {
  it("evaluates conditions", () => {
    expect(evaluate({ condition: "rows", threshold: 0 }, [["1"]])).toEqual({ firing: true, value: "1 row" });
    expect(evaluate({ condition: "none", threshold: 0 }, [])).toEqual({ firing: true, value: "0 rows" });
    expect(evaluate({ condition: "above", threshold: 100 }, [["150"]]).firing).toBe(true);
    expect(evaluate({ condition: "below", threshold: 100 }, [["150"]]).firing).toBe(false);
    expect(evaluate({ condition: "above", threshold: 1 }, [["n/a"]]).firing).toBe(false);
  });
});
