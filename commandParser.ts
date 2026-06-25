import type { CouncilInput, CouncilMode, SecondOpinionInput, SecondOpinionMode } from "./types.js";

interface ParsedArgs {
  mode: CouncilMode;
  problem: string;
  constraints: string[];
  questionsToCouncil: string[];
  currentUnderstanding?: string;
}

interface ParsedSecondOpinionArgs {
  mode: SecondOpinionMode;
  problem: string;
  constraints: string[];
  questions: string[];
  currentUnderstanding?: string;
}

/**
 * Parse /opinion command arguments into a SecondOpinionInput.
 * 
 * Supports:
 * - /opinion "question"
 * - /opinion fix "bug description"
 * - /opinion ask "question"
 * - /opinion architecture "architecture question"
 * - /opinion "problem" --constraint "constraint" --question "question"
 * - Short flags: -c, -q, -u
 */
export function parseSecondOpinionCommandArgs(args: string | undefined): SecondOpinionInput {
  // Handle empty/undefined args
  if (!args || args.trim().length === 0) {
    throw new Error('Usage: /opinion [fix|ask|architecture|general] "problem" [--constraint "..."] [--question "..."]');
  }

  // Tokenize the input
  const tokens = tokenize(args);

  if (tokens.length === 0) {
    throw new Error('Usage: /opinion [fix|ask|architecture|general] "problem" [--constraint "..."] [--question "..."]');
  }

  const parsed: ParsedSecondOpinionArgs = {
    mode: "general",
    problem: "",
    constraints: [],
    questions: [],
  };

  let i = 0;

  // Check if first token is a mode
  const firstToken = tokens[i].toLowerCase();
  if (isSecondOpinionModeToken(firstToken)) {
    parsed.mode = normalizeSecondOpinionMode(firstToken);
    i++;
  }

  // First non-flag token is the problem
  if (i < tokens.length && !isFlag(tokens[i])) {
    parsed.problem = tokens[i];
    i++;
  } else if (parsed.problem === "" && i < tokens.length) {
    parsed.problem = tokens[i];
    i++;
  }

  // Parse remaining tokens as flags and values
  while (i < tokens.length) {
    const token = tokens[i];

    if (isFlag(token)) {
      const flagName = getFlagName(token);
      const nextToken = tokens[i + 1];

      // Check for missing value
      if (nextToken === undefined || isFlag(nextToken)) {
        throw new Error(`Missing value for ${token}`);
      }

      switch (flagName) {
        case "constraint":
        case "c":
          parsed.constraints.push(nextToken);
          break;
        case "question":
        case "q":
          parsed.questions.push(nextToken);
          break;
        case "understanding":
        case "u":
          parsed.currentUnderstanding = nextToken;
          break;
        default:
          throw new Error(`Unknown /opinion option: ${token}`);
      }

      i += 2;
    } else {
      // Non-flag token - treat as additional problem text
      if (parsed.problem) {
        parsed.problem += " " + token;
      } else {
        parsed.problem = token;
      }
      i++;
    }
  }

  // Validate
  if (!parsed.problem || parsed.problem.trim().length === 0) {
    throw new Error('Usage: /opinion [fix|ask|architecture|general] "problem" [--constraint "..."] [--question "..."]');
  }

  return {
    mode: parsed.mode,
    problem: parsed.problem.trim(),
    currentUnderstanding: parsed.currentUnderstanding,
    constraints: parsed.constraints,
    questions: parsed.questions,
    relevantFiles: [],
  };
}

function isSecondOpinionModeToken(token: string): boolean {
  return ["fix", "ask", "architecture", "arch", "general"].includes(token.toLowerCase());
}

function normalizeSecondOpinionMode(token: string): SecondOpinionMode {
  switch (token.toLowerCase()) {
    case "arch":
      return "architecture";
    case "architecture":
      return "architecture";
    case "fix":
      return "fix";
    case "ask":
      return "ask";
    case "general":
    default:
      return "general";
  }
}

/**
 * Parse /council command arguments into a CouncilInput.
 * 
 * Supports:
 * - /council ask "question"
 * - /council fix "bug description"
 * - /council architecture "architecture question"
 * - /council "plain question" (defaults to ask)
 * - /council fix "problem" --constraint "constraint" --question "question"
 * - Short flags: -c, -q, -u
 */
export function parseCouncilCommandArgs(args: string | undefined): CouncilInput {
  // Handle empty/undefined args
  if (!args || args.trim().length === 0) {
    throw new Error("Usage: /council [ask|fix|architecture] \"problem\" [--constraint \"...\"] [--question \"...\"]");
  }

  // Tokenize the input
  const tokens = tokenize(args);

  if (tokens.length === 0) {
    throw new Error("Usage: /council [ask|fix|architecture] \"problem\" [--constraint \"...\"] [--question \"...\"]");
  }

  const parsed: ParsedArgs = {
    mode: "ask",
    problem: "",
    constraints: [],
    questionsToCouncil: [],
  };

  let i = 0;

  // Check if first token is a mode
  const firstToken = tokens[i].toLowerCase();
  if (isModeToken(firstToken)) {
    parsed.mode = normalizeMode(firstToken);
    i++;
  }

  // If no mode provided, first token might be the problem (unquoted)
  if (i < tokens.length && !isFlag(tokens[i])) {
    // First non-flag token is the problem
    parsed.problem = tokens[i];
    i++;
  }

  // If we have "fix" or "ask" etc as the first token and it wasn't recognized as mode
  // Check if we need to treat it as problem if nothing else is there
  if (parsed.problem === "" && i < tokens.length) {
    parsed.problem = tokens[i];
    i++;
  }

  // Parse remaining tokens as flags and values
  while (i < tokens.length) {
    const token = tokens[i];

    if (isFlag(token)) {
      const flagName = getFlagName(token);
      const nextToken = tokens[i + 1];

      // Check for missing value
      if (nextToken === undefined || isFlag(nextToken)) {
        throw new Error(`Missing value for ${token}`);
      }

      switch (flagName) {
        case "constraint":
        case "c":
          parsed.constraints.push(nextToken);
          break;
        case "question":
        case "q":
          parsed.questionsToCouncil.push(nextToken);
          break;
        case "understanding":
        case "u":
          parsed.currentUnderstanding = nextToken;
          break;
        default:
          throw new Error(`Unknown /council option: ${token}`);
      }

      i += 2;
    } else {
      // Non-flag token - treat as additional problem text
      if (parsed.problem) {
        parsed.problem += " " + token;
      } else {
        parsed.problem = token;
      }
      i++;
    }
  }

  // Validate
  if (!parsed.problem || parsed.problem.trim().length === 0) {
    throw new Error("Usage: /council [ask|fix|architecture] \"problem\" [--constraint \"...\"] [--question \"...\"]");
  }

  return {
    mode: parsed.mode,
    problem: parsed.problem.trim(),
    currentUnderstanding: parsed.currentUnderstanding,
    constraints: parsed.constraints,
    questionsToCouncil: parsed.questionsToCouncil,
    relevantFiles: [],
  };
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote: '"' | "'" | null = null;
  let i = 0;

  while (i < input.length) {
    const char = input[i];

    // Handle quote switching
    if (inQuote && char === inQuote) {
      // End quoted string
      inQuote = null;
      i++;
      continue;
    }

    // Start quoted string
    if ((char === '"' || char === "'") && !inQuote) {
      inQuote = char;
      i++;
      continue;
    }

    // In quoted string - accumulate
    if (inQuote) {
      current += char;
      i++;
      continue;
    }

    // Whitespace outside quotes - separator
    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      i++;
      continue;
    }

    // Regular character
    current += char;
    i++;
  }

  // Flush remaining
  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function isModeToken(token: string): boolean {
  return ["ask", "fix", "architecture", "arch"].includes(token.toLowerCase());
}

function normalizeMode(token: string): CouncilMode {
  switch (token.toLowerCase()) {
    case "arch":
      return "architecture";
    case "architecture":
      return "architecture";
    case "fix":
      return "fix";
    case "ask":
    default:
      return "ask";
  }
}

function isFlag(token: string): boolean {
  return token.startsWith("--") || token.startsWith("-");
}

function getFlagName(token: string): string {
  // Remove leading dashes
  return token.replace(/^-+/, "");
}