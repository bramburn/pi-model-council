import type {
  CouncilInput,
  CouncilMode,
  SecondOpinionInput,
  SecondOpinionMode,
} from "./types.js";

// ─── Limits ────────────────────────────────────────────────────────────────────
// Slash-command arguments flow directly into LLM prompts. We apply tight
// limits so a typo or a malicious paste can't push 100k tokens into the
// council/opinion pipeline. Adjust if you legitimately need larger inputs.
const MAX_PROBLEM_CHARS = 8_000;
const MAX_UNDERSTANDING_CHARS = 2_000;
const MAX_CONSTRAINT_OR_QUESTION_CHARS = 1_000;
const MAX_CONSTRAINTS = 20;
const MAX_QUESTIONS = 20;
const MAX_TOKENS = 200;
const MAX_TOKEN_CHARS = 4_000;

// Usage strings are built once and reused so the two parsers stay in sync.
const COUNCIL_USAGE =
  'Usage: /council [ask|fix|architecture] "problem" ' +
  '[--constraint "..."] [--question "..."] [--understanding "..."]';
const OPINION_USAGE =
  'Usage: /opinion [fix|ask|architecture|general] "problem" ' +
  '[--constraint "..."] [--question "..."] [--understanding "..."]';

// ─── Shared parser ────────────────────────────────────────────────────────────

interface CommonArgs {
  problem: string;
  constraints: string[];
  questions: string[];
  currentUnderstanding?: string;
}

interface ParserConfig {
  validModes: ReadonlySet<string>;
  /** Map a (lowercased) mode token to the canonical mode value. */
  normalizeMode: (token: string) => string;
  /** Default mode when none is supplied. */
  defaultMode: string;
  /** Question field name on the output shape ("questions" vs "questionsToCouncil"). */
  questionField: "questions" | "questionsToCouncil";
  usage: string;
}

function parseCommon(args: string | undefined, config: ParserConfig): CommonArgs & { mode: string } {
  if (!args || args.trim().length === 0) {
    throw new Error(config.usage);
  }

  // 1. Normalise the full input to NFC Unicode so visually similar chars
  //    (e.g. Cyrillic 'а' vs Latin 'a') can't slip past the mode allow-list.
  const normalised = args.normalize("NFC");

  // 2. Tokenize respecting quoted strings and `\` escapes inside quotes.
  //    Also flags unterminated quotes so the user sees a clear error
  //    instead of a silently-truncated prompt.
  let tokens: string[];
  try {
    tokens = tokenize(normalised);
  } catch (err) {
    throw new Error(`${config.usage}\n\n${err instanceof Error ? err.message : String(err)}`);
  }
  if (tokens.length === 0) {
    throw new Error(config.usage);
  }
  if (tokens.length > MAX_TOKENS) {
    throw new Error(
      `Too many arguments (${tokens.length} > ${MAX_TOKENS}). ` +
        `Quote multi-word values to keep the count down.`,
    );
  }

  // 3. Strip control characters from each token (null bytes, terminal
  //    escape codes, etc.). These can break prompt rendering or smuggle
  //    prompt-injection payloads past the LLM.
  tokens = tokens.map(stripControlChars);
  // Drop any token that became empty after stripping.
  tokens = tokens.filter((t) => t.length > 0);

  // 4. Detect mode token (optional, first position).
  let mode = config.defaultMode;
  let i = 0;
  if (config.validModes.has(tokens[0].toLowerCase())) {
    mode = config.normalizeMode(tokens[0].toLowerCase());
    i++;
  }

  // 5. First non-flag token is the problem. Remaining non-flag tokens
  //    (after mode and flags) are appended to the problem with spaces.
  const parsed: CommonArgs = {
    problem: "",
    constraints: [],
    questions: [],
  };

  while (i < tokens.length) {
    const token = tokens[i];

    if (isFlag(token)) {
      const flagName = getFlagName(token);
      const nextToken = tokens[i + 1];

      if (nextToken === undefined) {
        throw new Error(
          `Missing value for ${token}.\n\n${config.usage}`,
        );
      }
      if (isFlag(nextToken)) {
        throw new Error(
          `Missing value for ${token} (got another flag "${nextToken}" instead).\n\n${config.usage}`,
        );
      }

      switch (flagName) {
        case "constraint":
        case "c":
          if (parsed.constraints.length >= MAX_CONSTRAINTS) {
            throw new Error(`Too many --constraint flags (max ${MAX_CONSTRAINTS}).`);
          }
          if (nextToken.length > MAX_CONSTRAINT_OR_QUESTION_CHARS) {
            throw new Error(
              `--constraint value too long (${nextToken.length} > ${MAX_CONSTRAINT_OR_QUESTION_CHARS} chars).`,
            );
          }
          parsed.constraints.push(nextToken);
          break;
        case "question":
        case "q":
          if (parsed.questions.length >= MAX_QUESTIONS) {
            throw new Error(`Too many --question flags (max ${MAX_QUESTIONS}).`);
          }
          if (nextToken.length > MAX_CONSTRAINT_OR_QUESTION_CHARS) {
            throw new Error(
              `--question value too long (${nextToken.length} > ${MAX_CONSTRAINT_OR_QUESTION_CHARS} chars).`,
            );
          }
          parsed.questions.push(nextToken);
          break;
        case "understanding":
        case "u":
          if (parsed.currentUnderstanding !== undefined) {
            throw new Error("--understanding provided more than once.");
          }
          if (nextToken.length > MAX_UNDERSTANDING_CHARS) {
            throw new Error(
              `--understanding value too long (${nextToken.length} > ${MAX_UNDERSTANDING_CHARS} chars).`,
            );
          }
          parsed.currentUnderstanding = nextToken;
          break;
        default:
          throw new Error(
            `Unknown option: ${token}\n\n${config.usage}`,
          );
      }

      i += 2;
    } else {
      // Non-flag token - concatenate onto problem so unquoted multi-word
      // problems still work.
      parsed.problem = parsed.problem
        ? `${parsed.problem} ${token}`
        : token;
      i++;
    }
  }

  parsed.problem = parsed.problem.trim();

  if (parsed.problem.length === 0) {
    throw new Error(config.usage);
  }
  if (parsed.problem.length > MAX_PROBLEM_CHARS) {
    throw new Error(
      `Problem too long (${parsed.problem.length} > ${MAX_PROBLEM_CHARS} chars). ` +
        `Move supporting detail into --constraint or --understanding.`,
    );
  }

  return { ...parsed, mode };
}

// ─── Public entry points ──────────────────────────────────────────────────────

const COUNCIL_CONFIG: ParserConfig = {
  validModes: new Set(["ask", "fix", "architecture", "arch"]),
  normalizeMode: (t) => (t === "arch" ? "architecture" : t),
  defaultMode: "ask",
  questionField: "questionsToCouncil",
  usage: COUNCIL_USAGE,
};

const OPINION_CONFIG: ParserConfig = {
  validModes: new Set(["fix", "ask", "architecture", "arch", "general"]),
  normalizeMode: (t) => (t === "arch" ? "architecture" : t),
  defaultMode: "general",
  questionField: "questions",
  usage: OPINION_USAGE,
};

export function parseCouncilCommandArgs(args: string | undefined): CouncilInput {
  const parsed = parseCommon(args, COUNCIL_CONFIG);
  const result: CouncilInput = {
    mode: parsed.mode as CouncilMode,
    problem: parsed.problem,
    constraints: parsed.constraints,
    relevantFiles: [],
  };
  if (parsed.currentUnderstanding !== undefined) {
    result.currentUnderstanding = parsed.currentUnderstanding;
  }
  result.questionsToCouncil = parsed.questions;
  return result;
}

export function parseSecondOpinionCommandArgs(args: string | undefined): SecondOpinionInput {
  const parsed = parseCommon(args, OPINION_CONFIG);
  const result: SecondOpinionInput = {
    mode: parsed.mode as SecondOpinionMode,
    problem: parsed.problem,
    constraints: parsed.constraints,
    relevantFiles: [],
  };
  if (parsed.currentUnderstanding !== undefined) {
    result.currentUnderstanding = parsed.currentUnderstanding;
  }
  result.questions = parsed.questions;
  return result;
}

// ─── Tokenizer ────────────────────────────────────────────────────────────────

/**
 * Split an input string into tokens, respecting double- and single-quoted
 * strings. Inside a quoted string, `\` is treated as an escape character
 * (so `"foo \"bar\""` becomes `foo "bar"`).
 *
 * Throws on an unterminated quote so callers can surface a clear error
 * instead of silently truncating the user's prompt.
 */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote: '"' | "'" | null = null;
  let hasContentInCurrent = false;

  const flush = (): void => {
    if (hasContentInCurrent) {
      if (current.length > MAX_TOKEN_CHARS) {
        throw new Error(
          `A single argument is too long (${current.length} > ${MAX_TOKEN_CHARS} chars). ` +
            `Split it into smaller pieces or move detail into --constraint / --understanding.`,
        );
      }
      tokens.push(current);
      current = "";
      hasContentInCurrent = false;
    }
  };

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (inQuote !== null) {
      if (char === "\\" && i + 1 < input.length) {
        // Escape: keep the next char verbatim. This handles \" \' \\ \n etc.
        current += input[i + 1];
        i++;
        hasContentInCurrent = true;
        continue;
      }
      if (char === inQuote) {
        // Close quote.
        inQuote = null;
        continue;
      }
      current += char;
      hasContentInCurrent = true;
      continue;
    }

    if (char === '"' || char === "'") {
      // Open quote. Flush whatever we've accumulated as a bare token first.
      flush();
      inQuote = char;
      hasContentInCurrent = true;
      continue;
    }

    if (/\s/.test(char)) {
      flush();
      continue;
    }

    current += char;
    hasContentInCurrent = true;
  }

  if (inQuote !== null) {
    throw new Error(`Unterminated ${inQuote === '"' ? "double" : "single"} quote in argument.`);
  }

  flush();
  return tokens;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isFlag(token: string): boolean {
  return token.startsWith("--") || (token.startsWith("-") && token.length > 1);
}

function getFlagName(token: string): string {
  return token.replace(/^-+/, "");
}

/**
 * Strip ASCII control characters (including null bytes, tab, newline,
 * and terminal escape sequences) from a token. We keep printable chars,
 * non-ASCII Unicode, and most whitespace already-stripped by the caller.
 *
 * Why: raw control bytes pasted into a prompt can:
 *   - break rendering in terminals or downstream tools
 *   - smuggle ANSI escape sequences that change the user's display
 *   - confuse JSON parsing if a control byte ends up in a model response
 */
function stripControlChars(token: string): string {
  // eslint-disable-next-line no-control-regex
  return token.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}