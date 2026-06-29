import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context.ts";

// A single selectable approach presented to the user.
export interface UserChoiceOption {
  label: string;
  description?: string;
}

// A decision the model surfaces to the user via the `ask_user` tool.
export interface UserQuestion {
  question: string;
  options: UserChoiceOption[];
  multiSelect: boolean;
}

// The user's answer: chosen option index(es), free-form custom text, or a dismissal.
export type UserAnswer =
  | { kind: "selected"; indices: number[] }
  | { kind: "custom"; text: string }
  | { kind: "dismissed" };

// Bridge supplied by the interactive session: surface a question to the TUI and
// resolve with the user's choice. Absent in non-interactive contexts (sub-agents,
// remote-driven turns, headless runs), where the tool reports it couldn't ask.
export type UserAsker = (q: UserQuestion) => Promise<UserAnswer>;

// The `ask_user` tool: when the right implementation direction is genuinely
// ambiguous, the model puts a small menu of approaches to the user and blocks until
// they pick one (or write their own answer). No filesystem mutation, so it isn't
// gated — but it does pause the turn on the human, exactly like the approval prompt.
export function askUserTool(ctx: ToolContext) {
  return tool({
    description:
      "Ask the user to choose between competing implementation directions when the right " +
      "approach is genuinely ambiguous and the choice materially changes the work (architecture, " +
      "a library, a data model, the scope of a change). Present 2–4 concrete options, " +
      "most-recommended first, each with its trade-offs; the user picks one (or writes their own " +
      "answer). Prefer this over silently guessing on a consequential fork. Do NOT use it for " +
      "trivial choices you can reasonably make yourself, or to request permission for an action — " +
      "the approval gate handles permissions.",
    inputSchema: z.object({
      question: z.string().describe("The decision to put to the user, phrased as a question."),
      options: z
        .array(
          z.object({
            label: z
              .string()
              .describe("Short name for this approach, e.g. 'Server-side rendering'."),
            description: z
              .string()
              .optional()
              .describe("One or two sentences on what it entails and its trade-offs."),
          }),
        )
        .min(2)
        .max(4)
        .describe("The competing approaches, most-recommended first."),
      multiSelect: z
        .boolean()
        .optional()
        .describe("Allow the user to choose more than one option (default false)."),
    }),
    execute: async ({ question, options, multiSelect }) => {
      if (!ctx.askUser) {
        return (
          "Cannot ask the user interactively in this context. Pick the best option using your " +
          "own judgment, then state which you chose and why before proceeding."
        );
      }
      const answer = await ctx.askUser({ question, options, multiSelect: multiSelect ?? false });
      if (answer.kind === "custom") {
        return `The user answered: ${answer.text}`;
      }
      if (answer.kind === "dismissed") {
        return (
          "The user dismissed the question without choosing. Either restate the choice briefly in " +
          "plain prose, or proceed with the best option and say which you picked."
        );
      }
      const chosen = answer.indices.map((i) => options[i]).filter(Boolean);
      if (chosen.length === 0) {
        return "The user made no selection. Proceed with the best option and state which you chose.";
      }
      const rendered = chosen
        .map((o) => (o.description ? `"${o.label}" (${o.description})` : `"${o.label}"`))
        .join(", ");
      return `The user chose: ${rendered}. Proceed with this direction.`;
    },
  });
}
