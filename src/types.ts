export interface DownstreamServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface SlimConfig {
  mcpServers: Record<string, DownstreamServerConfig>;
}

export interface RawDownstreamTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export type FindingSeverity = 'low' | 'medium' | 'high' | 'critical';

export type FindingCategory =
  | 'unicode'
  | 'html_comment'
  | 'instruction_override'
  | 'exfiltration'
  | 'cross_tool_shadowing'
  | 'schema_complexity';

export interface PoisoningFinding {
  severity: FindingSeverity;
  category: FindingCategory;
  field: string;
  message: string;
}

export interface IndexedTool {
  toolId: string;
  serverName: string;
  toolName: string;
  description: string;
  summary: string;
  parameterNames: string[];
  inputSchema: Record<string, unknown>;
  rawSchemaBytes: number;
  rawSchemaChars: number;
  rawSchemaTokens: number;
  quarantined: boolean;
  findings: PoisoningFinding[];
}

export interface ToolSearchHit {
  toolId: string;
  server: string;
  name: string;
  parameters: string[];
  summary: string;
  score: number;
}

export interface DownstreamCallContentItem {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface DownstreamCallResult {
  content: DownstreamCallContentItem[];
  isError?: boolean;
  structuredContent?: unknown;
}

export interface PipelineStep {
  id?: string;
  toolId: string;
  arguments?: Record<string, unknown>;
}

export interface PipelineStepSummary {
  index: number;
  id: string;
  toolId: string;
  status: 'ok';
  outputBytes: number;
}

export interface PipelineExecutionResult {
  stepsExecuted: number;
  steps: PipelineStepSummary[];
  finalOutput: {
    text: string;
    json?: unknown;
  };
}

export interface ServerSavingsSummary {
  server: string;
  totalTools: number;
  healthyTools: number;
  quarantinedTools: number;
  rawSchemaBytes: number;
  rawSchemaChars: number;
  rawSchemaTokens: number;
}

export interface QuarantinedToolSummary {
  toolId: string;
  findings: PoisoningFinding[];
}

export interface SavingsReport {
  quarantineEnabled: boolean;
  servers: ServerSavingsSummary[];
  totals: {
    downstreamServers: number;
    rawToolCount: number;
    healthyToolCount: number;
    quarantinedCount: number;
    detectedPoisonedCount: number;
    rawSchemaBytes: number;
    rawSchemaChars: number;
    rawSchemaTokens: number;
    proxiedMetaToolCount: number;
    proxiedSchemaBytes: number;
    proxiedSchemaChars: number;
    proxiedSchemaTokens: number;
    tokensSaved: number;
    percentSaved: number;
  };
  quarantinedTools: QuarantinedToolSummary[];
}
