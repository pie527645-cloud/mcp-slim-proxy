import type {
  FindingSeverity,
  IndexedTool,
  PoisoningFinding,
  RawDownstreamTool,
} from './types.js';

interface StringFieldEntry {
  field: string;
  value: string;
}

interface PhraseRule {
  needle: string;
  severity: FindingSeverity;
  wordBoundary?: boolean;
  label: string;
}

const INSTRUCTION_OVERRIDE_RULES: readonly PhraseRule[] = [
  { needle: 'ignore previous', severity: 'critical', label: 'ignore previous' },
  { needle: 'ignore all previous', severity: 'critical', label: 'ignore all previous' },
  { needle: 'ignore prior instructions', severity: 'critical', label: 'ignore prior instructions' },
  { needle: 'system prompt', severity: 'high', label: 'system prompt' },
  { needle: 'disregard', severity: 'high', wordBoundary: true, label: 'disregard' },
  { needle: '<important>', severity: 'critical', label: 'tag IMPORTANT' },
  { needle: '</important>', severity: 'critical', label: 'closing tag IMPORTANT' },
  { needle: '<instructions>', severity: 'critical', label: 'tag instructions' },
  { needle: '</instructions>', severity: 'critical', label: 'closing tag instructions' },
  { needle: '<system>', severity: 'critical', label: 'tag system' },
  { needle: 'do not tell the user', severity: 'critical', label: 'stealth directive' },
  { needle: 'hide this from the user', severity: 'critical', label: 'stealth directive' },
];

const EXFIL_SUBSTRING_RULES: readonly PhraseRule[] = [
  { needle: '~/.ssh', severity: 'critical', label: '~/.ssh' },
  { needle: '~/.aws', severity: 'critical', label: '~/.aws' },
  { needle: '/etc/passwd', severity: 'critical', label: '/etc/passwd' },
  { needle: '/etc/shadow', severity: 'critical', label: '/etc/shadow' },
  { needle: 'id_rsa', severity: 'critical', label: 'id_rsa' },
  { needle: 'id_ed25519', severity: 'critical', label: 'id_ed25519' },
];

const SHADOWING_DIRECTIVES: readonly string[] = [
  'instead of using',
  'instead of calling',
  'before using',
  'before calling',
  'after calling',
  'whenever calling',
  'override tool',
  'replace tool',
  'shadow tool',
  'always call this tool before',
  'always invoke this tool before',
];

function isAsciiWordChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}

function findPhraseLinear(lowerText: string, needle: string, wordBoundary: boolean): boolean {
  let pos = lowerText.indexOf(needle);
  while (pos !== -1) {
    if (!wordBoundary) {
      return true;
    }
    const beforeOk = pos === 0 || !isAsciiWordChar(lowerText.charCodeAt(pos - 1));
    const endPos = pos + needle.length;
    const afterOk = endPos >= lowerText.length || !isAsciiWordChar(lowerText.charCodeAt(endPos));
    if (beforeOk && afterOk) {
      return true;
    }
    pos = lowerText.indexOf(needle, pos + 1);
  }
  return false;
}

function containsDotEnvTargetLinear(lowerText: string): boolean {
  const needle = '.env';
  let pos = lowerText.indexOf(needle);
  while (pos !== -1) {
    const prevChar = pos === 0 ? ' ' : lowerText.charAt(pos - 1);
    const beforeOk =
      pos === 0 ||
      prevChar === ' ' ||
      prevChar === '\t' ||
      prevChar === '\n' ||
      prevChar === '\r' ||
      prevChar === '/' ||
      prevChar === '\\' ||
      prevChar === '"' ||
      prevChar === "'" ||
      prevChar === '`' ||
      prevChar === '(' ||
      prevChar === '[';

    const afterIndex = pos + needle.length;
    const nextChar = afterIndex >= lowerText.length ? ' ' : lowerText.charAt(afterIndex);
    const afterOk =
      afterIndex >= lowerText.length ||
      nextChar === ' ' ||
      nextChar === '\t' ||
      nextChar === '\n' ||
      nextChar === '\r' ||
      nextChar === '.' ||
      nextChar === '"' ||
      nextChar === "'" ||
      nextChar === '`' ||
      nextChar === ')' ||
      nextChar === ']' ||
      nextChar === ',' ||
      nextChar === ';' ||
      nextChar === ':';

    if (beforeOk && afterOk) {
      return true;
    }
    pos = lowerText.indexOf(needle, pos + 1);
  }
  return false;
}

function scanHiddenUnicodeLinear(field: string, text: string, findings: PoisoningFinding[]): void {
  for (let i = 0; i < text.length; ) {
    const code = text.codePointAt(i);
    if (code === undefined) {
      break;
    }
    const step = code > 0xffff ? 2 : 1;

    const isZeroWidthRange = code >= 0x200b && code <= 0x200f;
    const isBidiOverrideRange = code >= 0x202a && code <= 0x202e;
    const isInvisibleOperatorOrIsolate = code >= 0x2060 && code <= 0x206f;
    const isBomZeroWidthNoBreak = code === 0xfeff;
    const isUnicodeTagSmuggling = code >= 0xe0000 && code <= 0xe007f;

    if (
      isZeroWidthRange ||
      isBidiOverrideRange ||
      isInvisibleOperatorOrIsolate ||
      isUnicodeTagSmuggling
    ) {
      const hex = code.toString(16).toUpperCase().padStart(4, '0');
      findings.push({
        severity: 'critical',
        category: 'unicode',
        field,
        message: `Hidden zero-width, BiDi, or tag control character U+${hex} detected.`,
      });
      return;
    }

    if (isBomZeroWidthNoBreak) {
      findings.push({
        severity: 'high',
        category: 'unicode',
        field,
        message: 'Hidden byte-order mark / zero-width no-break space U+FEFF detected.',
      });
      return;
    }

    i += step;
  }
}

function scanHtmlCommentsLinear(field: string, text: string, findings: PoisoningFinding[]): void {
  const openIdx = text.indexOf('<!--');
  if (openIdx === -1) {
    return;
  }
  const closeIdx = text.indexOf('-->', openIdx + 4);
  if (closeIdx !== -1) {
    findings.push({
      severity: 'high',
      category: 'html_comment',
      field,
      message: 'Embedded HTML comment block detected in tool metadata.',
    });
  } else {
    findings.push({
      severity: 'high',
      category: 'html_comment',
      field,
      message: 'Unclosed HTML comment opener detected in tool metadata.',
    });
  }
}

function scanStringField(entry: StringFieldEntry, findings: PoisoningFinding[]): void {
  const { field, value } = entry;
  if (value.length === 0) {
    return;
  }

  scanHiddenUnicodeLinear(field, value, findings);
  scanHtmlCommentsLinear(field, value, findings);

  const lower = value.toLowerCase();

  for (const rule of INSTRUCTION_OVERRIDE_RULES) {
    if (findPhraseLinear(lower, rule.needle, rule.wordBoundary === true)) {
      findings.push({
        severity: rule.severity,
        category: 'instruction_override',
        field,
        message: `Instruction override phrase (${rule.label}) detected.`,
      });
    }
  }

  for (const rule of EXFIL_SUBSTRING_RULES) {
    if (lower.indexOf(rule.needle) !== -1) {
      findings.push({
        severity: rule.severity,
        category: 'exfiltration',
        field,
        message: `Sensitive exfiltration target (${rule.label}) referenced.`,
      });
    }
  }

  if (containsDotEnvTargetLinear(lower)) {
    findings.push({
      severity: 'critical',
      category: 'exfiltration',
      field,
      message: 'Sensitive exfiltration target (.env) referenced.',
    });
  }

  for (const directive of SHADOWING_DIRECTIVES) {
    if (lower.indexOf(directive) !== -1) {
      findings.push({
        severity: 'high',
        category: 'cross_tool_shadowing',
        field,
        message: `Coercive cross-tool shadowing directive (${directive}) detected.`,
      });
      break;
    }
  }
}

export const MAX_SCHEMA_DEPTH = 16;
export const MAX_SCHEMA_NODES = 1000;

interface SchemaScanBudget {
  count: number;
  depthExceeded: boolean;
  nodesExceeded: boolean;
  exceededAtField?: string;
}

function collectSchemaStrings(
  node: unknown,
  pathPrefix: string,
  out: StringFieldEntry[],
  budget: SchemaScanBudget,
  depth: number
): void {
  if (budget.depthExceeded || budget.nodesExceeded) {
    return;
  }
  if (depth > MAX_SCHEMA_DEPTH) {
    budget.depthExceeded = true;
    budget.exceededAtField ??= pathPrefix;
    return;
  }
  budget.count += 1;
  if (budget.count > MAX_SCHEMA_NODES) {
    budget.nodesExceeded = true;
    budget.exceededAtField ??= pathPrefix;
    return;
  }
  if (node === null || node === undefined) {
    return;
  }

  if (typeof node === 'string') {
    out.push({ field: pathPrefix, value: node });
    return;
  }

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      collectSchemaStrings(node[i], `${pathPrefix}[${i}]`, out, budget, depth + 1);
      if (budget.depthExceeded || budget.nodesExceeded) {
        return;
      }
    }
    return;
  }

  if (typeof node === 'object') {
    for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
      budget.count += 1;
      if (budget.count > MAX_SCHEMA_NODES) {
        budget.nodesExceeded = true;
        budget.exceededAtField ??= `${pathPrefix}.${key}`;
        return;
      }
      out.push({ field: `${pathPrefix}.${key}[key]`, value: key });
      collectSchemaStrings(val, `${pathPrefix}.${key}`, out, budget, depth + 1);
      if (budget.depthExceeded || budget.nodesExceeded) {
        return;
      }
    }
  }
}

export function scanToolForPoisoning(tool: RawDownstreamTool): PoisoningFinding[] {
  const entries: StringFieldEntry[] = [{ field: 'name', value: tool.name }];
  if (typeof tool.description === 'string') {
    entries.push({ field: 'description', value: tool.description });
  }

  const findings: PoisoningFinding[] = [];

  if (tool.inputSchema !== undefined) {
    const schemaBudget: SchemaScanBudget = {
      count: 0,
      depthExceeded: false,
      nodesExceeded: false,
    };
    collectSchemaStrings(tool.inputSchema, 'inputSchema', entries, schemaBudget, 0);
    if (schemaBudget.depthExceeded) {
      findings.push({
        severity: 'high',
        category: 'schema_complexity',
        field: schemaBudget.exceededAtField ?? 'inputSchema',
        message: `MCP107: Tool schema nesting depth exceeded safety limit (max depth ${MAX_SCHEMA_DEPTH}); quarantined fail-closed.`,
      });
    }
    if (schemaBudget.nodesExceeded) {
      findings.push({
        severity: 'high',
        category: 'schema_complexity',
        field: schemaBudget.exceededAtField ?? 'inputSchema',
        message: `MCP107: Tool schema node count exceeded safety budget (max ${MAX_SCHEMA_NODES} nodes); quarantined fail-closed.`,
      });
    }
  }

  if (tool.annotations !== undefined) {
    const annotationsBudget: SchemaScanBudget = {
      count: 0,
      depthExceeded: false,
      nodesExceeded: false,
    };
    collectSchemaStrings(tool.annotations, 'annotations', entries, annotationsBudget, 0);
    if (annotationsBudget.depthExceeded) {
      findings.push({
        severity: 'high',
        category: 'schema_complexity',
        field: annotationsBudget.exceededAtField ?? 'annotations',
        message: `MCP107: Tool annotations nesting depth exceeded safety limit (max depth ${MAX_SCHEMA_DEPTH}); quarantined fail-closed.`,
      });
    }
    if (annotationsBudget.nodesExceeded) {
      findings.push({
        severity: 'high',
        category: 'schema_complexity',
        field: annotationsBudget.exceededAtField ?? 'annotations',
        message: `MCP107: Tool annotations node count exceeded safety budget (max ${MAX_SCHEMA_NODES} nodes); quarantined fail-closed.`,
      });
    }
  }

  for (const entry of entries) {
    scanStringField(entry, findings);
  }
  return findings;
}

export function shouldQuarantine(findings: readonly PoisoningFinding[]): boolean {
  return findings.some((f) => f.severity === 'high' || f.severity === 'critical');
}

const CROSS_TOOL_COERCIVE_VERBS: readonly string[] = [
  'instead of',
  'before',
  'after',
  'whenever',
  'do not use',
  "don't use",
  'never use',
  'replace',
  'override',
  'intercept',
  'redirect',
];

export function detectCrossToolShadowing(
  tools: IndexedTool[],
  quarantineEnabled: boolean
): void {
  if (tools.length < 2) {
    return;
  }

  const distinctToolNames = new Map<string, Set<string>>();
  for (const t of tools) {
    const lowerName = t.toolName.toLowerCase();
    if (lowerName.length < 4) {
      continue;
    }
    let servers = distinctToolNames.get(lowerName);
    if (!servers) {
      servers = new Set<string>();
      distinctToolNames.set(lowerName, servers);
    }
    servers.add(t.serverName);
  }

  for (const candidate of tools) {
    const lowerDesc = candidate.description.toLowerCase();
    if (lowerDesc.length === 0) {
      continue;
    }

    const hasCoerciveVerb = CROSS_TOOL_COERCIVE_VERBS.some((v) => lowerDesc.indexOf(v) !== -1);
    if (!hasCoerciveVerb) {
      continue;
    }

    for (const [targetToolName, targetServers] of distinctToolNames.entries()) {
      const referencesOtherTool =
        targetToolName !== candidate.toolName.toLowerCase() ||
        targetServers.size > 1;
      if (!referencesOtherTool) {
        continue;
      }

      if (findPhraseLinear(lowerDesc, targetToolName, true)) {
        const alreadyRecorded = candidate.findings.some(
          (f) => f.category === 'cross_tool_shadowing' && f.field === 'description'
        );
        if (!alreadyRecorded) {
          candidate.findings.push({
            severity: 'high',
            category: 'cross_tool_shadowing',
            field: 'description',
            message: `Tool description references peer tool "${targetToolName}" alongside coercive behavioral directives.`,
          });
        }
        if (quarantineEnabled && shouldQuarantine(candidate.findings)) {
          candidate.quarantined = true;
        }
      }
    }
  }
}
