import { describe, expect, test } from "bun:test";
import { sanitizeOutboundText } from "../sanitize.js";

describe("sanitizeOutboundText", () => {
  test("drops footnote citations entirely", () => {
    expect(
      sanitizeOutboundText(
        "memory gains are modest.[[1]](https://pubmed.ncbi.nlm.nih.gov/39070254/) worth a try",
      ),
    ).toBe("memory gains are modest. worth a try");
    expect(
      sanitizeOutboundText("flat for insomnia [1](https://example.com/x) in adults"),
    ).toBe("flat for insomnia in adults");
  });

  test("unwraps inline links, keeping text and url", () => {
    expect(sanitizeOutboundText("see [the docs](https://example.com/docs)")).toBe(
      "see the docs (https://example.com/docs)",
    );
  });

  test("strips bold and headers, keeps content", () => {
    expect(sanitizeOutboundText("**not pure bro science**, but modest")).toBe(
      "not pure bro science, but modest",
    );
    expect(sanitizeOutboundText("## the plan\ndo less")).toBe("the plan\ndo less");
  });

  test("drops code fence lines, keeps the code", () => {
    expect(sanitizeOutboundText("```ts\nconst x = 1;\n```")).toBe("const x = 1;");
  });

  test("leaves human plain text alone", () => {
    const cases = [
      "you are *IT*",
      "snake_case_everywhere is fine",
      "- pasta\n- garlic bread",
      "2 * 3 = 6 and 4*5=20",
      "a (parenthetical) aside",
    ];
    for (const text of cases) {
      expect(sanitizeOutboundText(text)).toBe(text);
    }
  });

  test("strips leaked leading metadata annotations, leaves human brackets", () => {
    expect(sanitizeOutboundText("[msg:2065238330000000000] exactly")).toBe("exactly");
    expect(sanitizeOutboundText('[replying to Zach: "ok"] sounds good')).toBe(
      "sounds good",
    );
    expect(sanitizeOutboundText("[conversation: a:b] hey")).toBe("hey");
    // mid-sentence and non-metadata brackets are untouched
    expect(sanitizeOutboundText("that was wild [sic] honestly")).toBe(
      "that was wild [sic] honestly",
    );
    expect(sanitizeOutboundText("[citation needed] obviously")).toBe(
      "[citation needed] obviously",
    );
  });

  test("cleans dangling space before punctuation after citation removal", () => {
    expect(sanitizeOutboundText("works [[2]](https://x.test) , mostly")).toBe(
      "works, mostly",
    );
  });
});
