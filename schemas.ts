import { Type } from "@sinclair/typebox";

export const secondOpinionInputSchema = Type.Object({
  problem: Type.String({
    description: "The problem, question, or technical decision to get a second opinion on.",
  }),
  mode: Type.Optional(Type.Union([
    Type.Literal("fix"),
    Type.Literal("ask"),
    Type.Literal("architecture"),
    Type.Literal("general"),
  ])),
  currentUnderstanding: Type.Optional(Type.String({
    description: "Your current understanding or proposed approach.",
  })),
  relevantFiles: Type.Optional(Type.Array(Type.Object({
    path: Type.String(),
    summary: Type.String(),
    importantSnippets: Type.Optional(Type.String()),
  }))),
  constraints: Type.Optional(Type.Array(Type.String())),
  questions: Type.Optional(Type.Array(Type.String())),
});

export const councilInputSchema = Type.Object({
  mode: Type.Union([
    Type.Literal("fix"),
    Type.Literal("ask"),
    Type.Literal("architecture"),
  ]),
  problem: Type.String({
    description: "The problem, question, or architecture decision to ask the council about.",
  }),
  currentUnderstanding: Type.Optional(Type.String({
    description: "The main Pi model's current understanding or proposed approach.",
  })),
  relevantFiles: Type.Optional(Type.Array(Type.Object({
    path: Type.String(),
    summary: Type.String(),
    importantSnippets: Type.Optional(Type.String()),
  }))),
  constraints: Type.Optional(Type.Array(Type.String())),
  questionsToCouncil: Type.Optional(Type.Array(Type.String())),
});