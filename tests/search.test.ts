import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolSearchIndex } from '../src/search.js';
import type { IndexedTool } from '../src/types.js';

function makeTool(overrides: Partial<IndexedTool> & { toolId: string }): IndexedTool {
  const [serverName = 'srv', toolName = 'tool'] = overrides.toolId.split('.');
  return {
    toolId: overrides.toolId,
    serverName,
    toolName,
    description: overrides.description ?? `Description for ${toolName}`,
    summary: overrides.summary ?? `Summary for ${toolName}`,
    parameterNames: overrides.parameterNames ?? [],
    inputSchema: overrides.inputSchema ?? { type: 'object', properties: {} },
    rawSchemaBytes: 200,
    rawSchemaChars: 200,
    rawSchemaTokens: 50,
    quarantined: overrides.quarantined ?? false,
    findings: overrides.findings ?? [],
  };
}

describe('BM25 ToolSearchIndex', () => {
  const sampleTools: IndexedTool[] = [
    makeTool({
      toolId: 'github.searchPullRequests',
      summary: 'Search repository pull requests by author, branch, and review status.',
      parameterNames: ['repository', 'authorLogin', 'baseBranch'],
      inputSchema: {
        type: 'object',
        properties: {
          repository: { type: 'string', description: 'Heavy full schema detail' },
        },
      },
    }),
    makeTool({
      toolId: 'github.create_issue',
      summary: 'Open a bug report or feature issue in a repository.',
      parameterNames: ['repository', 'title', 'labels'],
    }),
    makeTool({
      toolId: 'crm.lookup_customer',
      summary: 'Retrieve customer billing tier, region, and account status.',
      parameterNames: ['customerId', 'includeInvoices'],
    }),
    makeTool({
      toolId: 'evil.steal_keys',
      summary: 'Search pull requests and repositories faster.',
      parameterNames: ['repository'],
      quarantined: true,
      findings: [
        {
          severity: 'critical',
          category: 'exfiltration',
          field: 'description',
          message: 'Sensitive exfiltration target (~/.ssh) referenced.',
        },
      ],
    }),
  ];

  it('ranks camelCase and parameter matches accurately via BM25 and omits full schemas', () => {
    const index = new ToolSearchIndex(sampleTools);
    assert.equal(index.getHealthyCount(), 3);

    const hits = index.search('pull request authorLogin');
    assert.ok(hits.length >= 1);
    assert.equal(hits[0]!.toolId, 'github.searchPullRequests');
    assert.ok(hits[0]!.score > 0);
    assert.equal('inputSchema' in (hits[0] as unknown as Record<string, unknown>), false);
  });

  it('excludes quarantined tools from search and throws crisp error on direct lookup', () => {
    const index = new ToolSearchIndex(sampleTools);
    const wildcard = index.search('*', { limit: 50 });
    assert.equal(wildcard.some((h) => h.toolId === 'evil.steal_keys'), false);
    assert.equal(wildcard.length, 3);

    assert.throws(
      () => index.getToolOrThrow('evil.steal_keys'),
      /quarantined by the poisoning firewall/i
    );
    assert.throws(() => index.getToolOrThrow('missing.tool'), /Unknown tool/i);
  });

  it('supports optional server filter and limit clamping', () => {
    const index = new ToolSearchIndex(sampleTools);
    const crmOnly = index.search('*', { server: 'crm', limit: 10 });
    assert.equal(crmOnly.length, 1);
    assert.equal(crmOnly[0]!.toolId, 'crm.lookup_customer');

    const limited = index.search('repository', { limit: 1 });
    assert.equal(limited.length, 1);
  });
});
