import { describe, it, expect } from "vitest";
import {
  parseCouncilCommandArgs,
  parseSecondOpinionCommandArgs,
} from "../commandParser.js";

describe("parseCouncilCommandArgs — basic parsing", () => {
  it("parses a quoted problem", () => {
    const result = parseCouncilCommandArgs('"Why is the test failing?"');
    expect(result.problem).toBe("Why is the test failing?");
    expect(result.mode).toBe("ask");
  });

  it("parses an explicit mode + quoted problem", () => {
    const result = parseCouncilCommandArgs('fix "Login fails on Safari"');
    expect(result.mode).toBe("fix");
    expect(result.problem).toBe("Login fails on Safari");
  });

  it("recognises 'arch' as alias for 'architecture'", () => {
    const result = parseCouncilCommandArgs('arch "Where should auth live?"');
    expect(result.mode).toBe("architecture");
  });

  it("parses --constraint and --question flags", () => {
    const result = parseCouncilCommandArgs(
      'fix "broken" --constraint "no breaking changes" --question "What about edge cases?"',
    );
    expect(result.constraints).toEqual(["no breaking changes"]);
    expect(result.questionsToCouncil).toEqual(["What about edge cases?"]);
  });

  it("parses short flag aliases (-c, -q, -u)", () => {
    const result = parseCouncilCommandArgs(
      'fix "broken" -c "constraint 1" -q "question 1" -u "context"',
    );
    expect(result.constraints).toEqual(["constraint 1"]);
    expect(result.questionsToCouncil).toEqual(["question 1"]);
    expect(result.currentUnderstanding).toBe("context");
  });

  it("concatenates unquoted multi-word problems with spaces", () => {
    const result = parseCouncilCommandArgs("fix login fails on safari");
    expect(result.problem).toBe("login fails on safari");
  });
});

describe("parseCouncilCommandArgs — security hardening", () => {
  it("throws on null bytes in tokens", () => {
    // The tokenizer strips control chars, so a token containing only
    // null bytes becomes empty and is dropped — leaving nothing to use
    // as the problem, which correctly throws.
    expect(() => parseCouncilCommandArgs("\u0000")).toThrow();
  });

  it("throws on unterminated double quote", () => {
    expect(() => parseCouncilCommandArgs('fix "unterminated problem'))
      .toThrow(/Unterminated double quote/);
  });

  it("throws on unterminated single quote", () => {
    expect(() => parseCouncilCommandArgs("fix 'unterminated"))
      .toThrow(/Unterminated single quote/);
  });

  it("respects escaped quotes inside double-quoted strings", () => {
    const result = parseCouncilCommandArgs('fix "He said \\"hello\\""');
    expect(result.problem).toBe('He said "hello"');
  });

  it("throws on missing flag value", () => {
    expect(() => parseCouncilCommandArgs("fix broken --constraint"))
      .toThrow(/Missing value for --constraint/);
  });

  it("throws on flag where the next token is itself a flag", () => {
    expect(() => parseCouncilCommandArgs("fix broken --constraint --save"))
      .toThrow(/Missing value for --constraint/);
  });

  it("throws on unknown flag", () => {
    expect(() => parseCouncilCommandArgs("fix broken --bogus value"))
      .toThrow(/Unknown option: --bogus/);
  });

  it("rejects excessive constraint count", () => {
    const parts: string[] = ["fix broken"];
    for (let i = 0; i < 25; i++) parts.push(`--constraint c${i}`);
    expect(() => parseCouncilCommandArgs(parts.join(" ")))
      .toThrow(/Too many --constraint/);
  });

  it("rejects oversized problem", () => {
    // The MAX_TOKEN_CHARS limit (4000) fires first inside the tokenizer,
    // before the MAX_PROBLEM_CHARS limit (8000) is checked at the end.
    const huge = "x".repeat(5_000);
    expect(() => parseCouncilCommandArgs(`fix "${huge}"`))
      .toThrow(/too long/i);
  });

  it("rejects oversized token", () => {
    const huge = "x".repeat(5_000);
    expect(() => parseCouncilCommandArgs(`fix "${huge}"`))
      .toThrow(/too long/i);
  });

  it("error messages include the full usage line", () => {
    try {
      parseCouncilCommandArgs("--bogus value");
      throw new Error("expected parseCouncilCommandArgs to throw");
    } catch (err) {
      expect((err as Error).message).toContain("Usage:");
    }
  });

  it("rejects duplicate --understanding flags", () => {
    expect(() => parseCouncilCommandArgs("fix broken -u first -u second"))
      .toThrow(/--understanding provided more than once/);
  });
});

describe("parseSecondOpinionCommandArgs — security hardening", () => {
  it("parses a basic question", () => {
    const result = parseSecondOpinionCommandArgs('"Is this refactor worth it?"');
    expect(result.problem).toBe("Is this refactor worth it?");
    expect(result.mode).toBe("general");
  });

  it("accepts 'general' as a valid mode (council-only modes are rejected)", () => {
    const result = parseSecondOpinionCommandArgs('general "test"');
    expect(result.mode).toBe("general");
  });

  it("rejects unknown mode in the first slot and falls back to general", () => {
    // 'foo' is not a valid opinion mode, so the parser treats it as
    // part of the problem and defaults the mode to 'general'.
    const result = parseSecondOpinionCommandArgs('foo "bar"');
    expect(result.mode).toBe("general");
    expect(result.problem).toBe("foo bar");
  });

  it("applies the same unterminated-quote error as council", () => {
    expect(() => parseSecondOpinionCommandArgs("'unterminated"))
      .toThrow(/Unterminated single quote/);
  });
});
