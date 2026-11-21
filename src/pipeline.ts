import type {
  DownstreamCallResult,
  PipelineExecutionResult,
  PipelineStep,
  PipelineStepSummary,
} from './types.js';

export const MAX_PIPELINE_STEPS = 10;

const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

interface StoredStepOutput {
  index: number;
  id: string;
  text: string;
  parsedJson?: unknown;
  jsonParsed: boolean;
}

export type ToolInvoker = (
  toolId: string,
  args: Record<string, unknown>
) => Promise<DownstreamCallResult>;

export function extractTextFromCallResult(result: DownstreamCallResult): string {
  const parts: string[] = [];
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (item && typeof item === 'object' && typeof item.text === 'string') {
        parts.push(item.text);
      }
    }
  }
  if (parts.length > 0) {
    return parts.join('\n');
  }
  if (result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent);
  }
  return '';
}

function assertSafeKey(segment: string, context: string): void {
  if (FORBIDDEN_PATH_SEGMENTS.has(segment)) {
    throw new Error(
      `Blocked forbidden property segment "${segment}" in ${context} (prototype pollution guard).`
    );
  }
}

function getParsedStepJson(stepOut: StoredStepOutput, refExpr: string): unknown {
  if (stepOut.jsonParsed) {
    return stepOut.parsedJson;
  }
  try {
    stepOut.parsedJson = JSON.parse(stepOut.text);
    stepOut.jsonParsed = true;
    return stepOut.parsedJson;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to parse JSON output of step "${stepOut.id}" (index ${stepOut.index}) referenced by "\${${refExpr}}": ${msg}`
    );
  }
}

function resolveDotPathSafe(root: unknown, dotPath: string, refExpr: string): unknown {
  if (dotPath.length === 0) {
    return root;
  }
  const segments = dotPath.split('.');
  let current: unknown = root;

  for (const segment of segments) {
    if (segment.length === 0) {
      throw new Error(`Invalid empty path segment in template reference "\${${refExpr}}".`);
    }
    assertSafeKey(segment, `template reference "\${${refExpr}}"`);

    if (current === null || current === undefined || typeof current !== 'object') {
      throw new Error(
        `Cannot read property "${segment}" on non-object value in template reference "\${${refExpr}}".`
      );
    }

    if (Array.isArray(current)) {
      const idx = Number(segment);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) {
        throw new Error(
          `Array index "${segment}" out of bounds (length ${current.length}) in template reference "\${${refExpr}}".`
        );
      }
      current = current[idx];
      continue;
    }

    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      throw new Error(
        `Own property "${segment}" does not exist on JSON output in template reference "\${${refExpr}}".`
      );
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

function evaluateStepExpression(
  expr: string,
  byIndex: Map<number, StoredStepOutput>,
  byId: Map<string, StoredStepOutput>,
  currentStepIndex: number
): unknown {
  if (!expr.startsWith('steps.')) {
    throw new Error(
      `Unsupported pipeline placeholder "\${${expr}}" at step ${currentStepIndex}. Expected \${steps.<idx>.text} or \${steps.<idx>.json.<dot.path>}.`
    );
  }

  const rest = expr.slice('steps.'.length);
  const firstDot = rest.indexOf('.');
  if (firstDot === -1) {
    throw new Error(
      `Invalid pipeline placeholder "\${${expr}}" at step ${currentStepIndex}. Missing ".text" or ".json" accessor.`
    );
  }

  const stepRef = rest.slice(0, firstDot);
  assertSafeKey(stepRef, `step reference "\${${expr}}"`);

  let targetStep: StoredStepOutput | undefined;
  if (/^\d+$/.test(stepRef)) {
    const refIndex = Number(stepRef);
    if (refIndex >= currentStepIndex) {
      throw new Error(
        `Step ${currentStepIndex} cannot reference future or current step index ${refIndex} in "\${${expr}}".`
      );
    }
    targetStep = byIndex.get(refIndex);
  } else {
    targetStep = byId.get(stepRef);
  }

  if (!targetStep) {
    throw new Error(
      `Unknown previous step "${stepRef}" referenced in "\${${expr}}" at step ${currentStepIndex}.`
    );
  }

  const accessorPart = rest.slice(firstDot + 1);
  if (accessorPart === 'text') {
    return targetStep.text;
  }

  if (accessorPart === 'json') {
    return getParsedStepJson(targetStep, expr);
  }

  if (accessorPart.startsWith('json.')) {
    const dotPath = accessorPart.slice('json.'.length);
    const jsonRoot = getParsedStepJson(targetStep, expr);
    return resolveDotPathSafe(jsonRoot, dotPath, expr);
  }

  throw new Error(
    `Unsupported step output accessor "${accessorPart}" in "\${${expr}}". Use ".text" or ".json.<dot.path>".`
  );
}

function substituteStringValue(
  raw: string,
  byIndex: Map<number, StoredStepOutput>,
  byId: Map<string, StoredStepOutput>,
  currentStepIndex: number
): unknown {
  const firstOpen = raw.indexOf('${');
  if (firstOpen === -1) {
    return raw;
  }

  // Exact single placeholder: preserve resolved JSON primitive/array/object types
  if (firstOpen === 0 && raw.endsWith('}')) {
    const firstClose = raw.indexOf('}', 2);
    if (firstClose === raw.length - 1) {
      const innerExpr = raw.slice(2, -1).trim();
      return evaluateStepExpression(innerExpr, byIndex, byId, currentStepIndex);
    }
  }

  // Multi-part string interpolation using linear index scanning
  let result = '';
  let cursor = 0;
  while (cursor < raw.length) {
    const openPos = raw.indexOf('${', cursor);
    if (openPos === -1) {
      result += raw.slice(cursor);
      break;
    }
    result += raw.slice(cursor, openPos);
    const closePos = raw.indexOf('}', openPos + 2);
    if (closePos === -1) {
      throw new Error(
        `Unclosed template placeholder starting at index ${openPos} in step ${currentStepIndex}: "${raw}"`
      );
    }
    const innerExpr = raw.slice(openPos + 2, closePos).trim();
    const evaluated = evaluateStepExpression(innerExpr, byIndex, byId, currentStepIndex);
    if (typeof evaluated === 'string') {
      result += evaluated;
    } else if (evaluated === undefined) {
      result += '';
    } else {
      result += JSON.stringify(evaluated);
    }
    cursor = closePos + 1;
  }

  return result;
}

function substituteValueDeep(
  value: unknown,
  byIndex: Map<number, StoredStepOutput>,
  byId: Map<string, StoredStepOutput>,
  currentStepIndex: number,
  depth: number
): unknown {
  if (depth > 20) {
    throw new Error(`Pipeline argument nesting depth exceeded maximum limit at step ${currentStepIndex}.`);
  }

  if (typeof value === 'string') {
    return substituteStringValue(value, byIndex, byId, currentStepIndex);
  }

  if (Array.isArray(value)) {
    return value.map((item) =>
      substituteValueDeep(item, byIndex, byId, currentStepIndex, depth + 1)
    );
  }

  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      assertSafeKey(k, `step ${currentStepIndex} arguments object key`);
      out[k] = substituteValueDeep(v, byIndex, byId, currentStepIndex, depth + 1);
    }
    return out;
  }

  return value;
}

export async function runPipeline(
  steps: readonly PipelineStep[],
  invoke: ToolInvoker
): Promise<PipelineExecutionResult> {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > MAX_PIPELINE_STEPS) {
    throw new Error(
      `Pipeline requires between 1 and ${MAX_PIPELINE_STEPS} steps (received ${Array.isArray(steps) ? steps.length : 0}).`
    );
  }

  const byIndex = new Map<number, StoredStepOutput>();
  const byId = new Map<string, StoredStepOutput>();
  const summaries: PipelineStepSummary[] = [];

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    if (!step || typeof step.toolId !== 'string' || step.toolId.trim().length === 0) {
      throw new Error(`Pipeline step ${i} is missing a valid non-empty toolId.`);
    }

    const stepId = step.id?.trim() ? step.id.trim() : `step_${i}`;
    assertSafeKey(stepId, `step ${i} id`);
    if (byId.has(stepId)) {
      throw new Error(`Duplicate pipeline step id "${stepId}" at index ${i}.`);
    }

    const rawArgs = step.arguments ?? {};
    if (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs)) {
      throw new Error(`Pipeline step ${i} arguments must be a JSON object.`);
    }

    const resolvedArgs = substituteValueDeep(
      rawArgs,
      byIndex,
      byId,
      i,
      0
    ) as Record<string, unknown>;

    const callResult = await invoke(step.toolId.trim(), resolvedArgs);
    const text = extractTextFromCallResult(callResult);

    if (callResult.isError) {
      throw new Error(
        `Pipeline failed at step ${i} (${step.toolId}): ${text || 'Downstream tool returned an error.'}`
      );
    }

    const stored: StoredStepOutput = {
      index: i,
      id: stepId,
      text,
      jsonParsed: false,
    };
    byIndex.set(i, stored);
    byId.set(stepId, stored);

    summaries.push({
      index: i,
      id: stepId,
      toolId: step.toolId.trim(),
      status: 'ok',
      outputBytes: Buffer.byteLength(text, 'utf8'),
    });
  }

  const finalStored = byIndex.get(steps.length - 1)!;
  let finalJson: unknown = undefined;
  const trimmedFinal = finalStored.text.trim();
  if (
    (trimmedFinal.startsWith('{') && trimmedFinal.endsWith('}')) ||
    (trimmedFinal.startsWith('[') && trimmedFinal.endsWith(']'))
  ) {
    try {
      finalJson = JSON.parse(trimmedFinal);
    } catch {
      finalJson = undefined;
    }
  }

  return {
    stepsExecuted: summaries.length,
    steps: summaries,
    finalOutput: finalJson !== undefined
      ? { text: finalStored.text, json: finalJson }
      : { text: finalStored.text },
  };
}
