import { z } from 'zod';
import { estimateTokensFromChars } from './config.js';
import { MAX_PIPELINE_STEPS } from './pipeline.js';

export interface MetaToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: boolean;
  };
}

export const META_TOOLS: readonly MetaToolDefinition[] = [
  {
    name: 'search_tools',
    description:
      'Search healthy downstream tools by keyword using BM25 ranking over tool identifiers (server.toolName), parameter names, and concise one-line summaries without loading full JSON schemas.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          maxLength: 500,
          description:
            'Keywords to match against tool names, parameter names, and summaries. Pass an asterisk or empty string to list available tools alphabetically.',
        },
        server: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
          description: 'Optional downstream server name to filter results to a single server.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          default: 10,
          description: 'Maximum number of ranked tool summaries to return (1 to 50, default 10).',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'describe_tool',
    description:
      'Fetch the full JSON inputSchema and complete description for a single healthy downstream tool identified by server.toolName prior to invocation.',
    inputSchema: {
      type: 'object',
      properties: {
        toolId: {
          type: 'string',
          minLength: 3,
          maxLength: 256,
          description:
            'Fully qualified downstream tool identifier in server.toolName format returned by search_tools.',
        },
      },
      required: ['toolId'],
      additionalProperties: false,
    },
  },
  {
    name: 'invoke_tool',
    description:
      'Execute a single healthy downstream tool by server.toolName with validated JSON arguments and return its result within the configured timeout.',
    inputSchema: {
      type: 'object',
      properties: {
        toolId: {
          type: 'string',
          minLength: 3,
          maxLength: 256,
          description: 'Fully qualified downstream tool identifier in server.toolName format.',
        },
        arguments: {
          type: 'object',
          additionalProperties: true,
          description:
            'Optional JSON object of arguments matching the inputSchema returned by describe_tool.',
        },
      },
      required: ['toolId'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_pipeline',
    description:
      'Execute 1 to 10 sequential downstream tool calls outside conversation context. String values inside step arguments may reference prior step outputs via ${steps.0.text} or ${steps.0.json.field.path} or by step id, returning step byte counts and final output.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_PIPELINE_STEPS,
          description: 'Ordered list of 1 to 10 sequential tool execution steps.',
          items: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                minLength: 1,
                maxLength: 64,
                description:
                  'Optional unique step alias usable in later placeholders such as ${steps.fetchUser.json.id}.',
              },
              toolId: {
                type: 'string',
                minLength: 3,
                maxLength: 256,
                description: 'Fully qualified downstream tool identifier in server.toolName format.',
              },
              arguments: {
                type: 'object',
                additionalProperties: true,
                description:
                  'JSON arguments object for the target tool, supporting ${steps.0.text} and ${steps.0.json.path} expressions.',
              },
            },
            required: ['toolId'],
            additionalProperties: false,
          },
        },
      },
      required: ['steps'],
      additionalProperties: false,
    },
  },
];

export const SearchToolsArgsSchema = z
  .object({
    query: z.string(),
    server: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();

export const DescribeToolArgsSchema = z
  .object({
    toolId: z.string().min(1),
  })
  .strict();

export const InvokeToolArgsSchema = z
  .object({
    toolId: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const RunPipelineArgsSchema = z
  .object({
    steps: z
      .array(
        z
          .object({
            id: z.string().min(1).optional(),
            toolId: z.string().min(1),
            arguments: z.record(z.string(), z.unknown()).optional(),
          })
          .strict()
      )
      .min(1)
      .max(MAX_PIPELINE_STEPS),
  })
  .strict();

export function measureMetaToolsFootprint(): {
  count: number;
  bytes: number;
  chars: number;
  tokens: number;
} {
  const serialized = JSON.stringify(META_TOOLS);
  const chars = serialized.length;
  const bytes = Buffer.byteLength(serialized, 'utf8');
  return {
    count: META_TOOLS.length,
    bytes,
    chars,
    tokens: estimateTokensFromChars(chars),
  };
}
