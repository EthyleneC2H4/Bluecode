/**
 * Minimal tool definition helper matching opencode's tool() signature.
 * This avoids depending on @opencode-ai/plugin at runtime.
 * Types are aligned with @opencode-ai/plugin@1.18.21 tool.d.ts
 */
import { z } from "zod";

export type ToolContext = {
  sessionID: string;
  messageID: string;
  agent: string;
  directory: string;
  worktree: string;
  abort: AbortSignal;
  metadata(input: { title?: string; metadata?: Record<string, unknown> }): void;
  ask(input: { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }): Promise<void>;
};

export type ToolResult = string | {
  title?: string;
  output: string;
  metadata?: Record<string, unknown>;
  attachments?: Array<{ type: "file"; mime: string; url: string; filename?: string }>;
};

/**
 * Create a tool definition with zod schema validation.
 * Matches the opencode plugin tool() helper signature exactly.
 * The returned object has the same structure as opencode's tool() return type.
 */
export function tool<Args extends z.ZodRawShape>(
  definition: {
    description: string;
    args: Args;
    execute: (args: z.infer<z.ZodObject<Args>>, context: ToolContext) => Promise<ToolResult>;
  },
): {
  description: string;
  args: Args;
  /** Input-typed: callers pass PRE-parse args (defaults not yet applied). */
  execute: (args: z.input<z.ZodObject<Args>>, context: ToolContext) => Promise<ToolResult>;
} {
  const schema = z.object(definition.args);
  return {
    description: definition.description,
    args: definition.args,
    execute: async (rawArgs: unknown, context: ToolContext) => {
      const parsed = schema.parse(rawArgs);
      return definition.execute(parsed, context);
    },
  };
}