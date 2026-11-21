import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const spawnedGrandchildren: ChildProcess[] = [];

function spawnDummyGrandchild(): ChildProcess {
  const gc = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000);'],
    {
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    }
  );
  spawnedGrandchildren.push(gc);
  return gc;
}

if (process.env['MOCK_PID_FILE']) {
  const startupGrandchild = spawnDummyGrandchild();
  fs.writeFileSync(
    process.env['MOCK_PID_FILE'],
    JSON.stringify({
      serverPid: process.pid,
      grandchildPid: startupGrandchild.pid,
    }),
    'utf8'
  );
}

const CLEAN_TOOLS = [
  {
    name: 'fetch_order',
    description:
      'Retrieve complete e-commerce order details by order identifier, including customer metadata, line items, currency, warehouse allocation, and fulfillment timestamps.',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: {
          type: 'string',
          description: 'Unique alphanumeric order identifier such as ORD-9001.',
        },
        includeLineItems: {
          type: 'boolean',
          default: true,
          description: 'Whether to include SKU line items and warehouse quantities.',
        },
        currencyOverride: {
          type: 'string',
          enum: ['USD', 'EUR', 'GBP', 'JPY', 'SGD'],
          description: 'Optional ISO-4217 display currency code.',
        },
      },
      required: ['orderId'],
      additionalProperties: false,
    },
  },
  {
    name: 'fetch_customer',
    description:
      'Look up customer account profile, loyalty tier, regional tax jurisdiction, and negotiated discount percentage by customer identifier.',
    inputSchema: {
      type: 'object',
      properties: {
        customerId: {
          type: 'string',
          description: 'Customer account identifier such as CUST-42.',
        },
        includeBillingHistory: {
          type: 'boolean',
          default: false,
          description: 'Include summary metrics for historical paid invoices.',
        },
      },
      required: ['customerId'],
      additionalProperties: false,
    },
  },
  {
    name: 'format_invoice',
    description:
      'Render a compact human-readable invoice summary combining order metadata, customer loyalty tier, region, and primary SKU.',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: { type: 'string', description: 'Order identifier.' },
        customerId: { type: 'string', description: 'Customer identifier.' },
        region: { type: 'string', description: 'Regional billing zone.' },
        discountPct: { type: 'number', description: 'Discount percentage from 0 to 100.' },
        firstSku: { type: 'string', description: 'Primary line item SKU.' },
        note: { type: 'string', description: 'Optional invoice memo string.' },
      },
      required: ['orderId', 'customerId', 'region', 'discountPct', 'firstSku'],
      additionalProperties: false,
    },
  },
  {
    name: 'searchPullRequests',
    description:
      'Query repository pull requests by state, author login, target base branch, review status, and label filters.',
    inputSchema: {
      type: 'object',
      properties: {
        repository: { type: 'string', description: 'Owner and repository name.' },
        state: { type: 'string', enum: ['open', 'closed', 'merged', 'all'], description: 'PR state filter.' },
        authorLogin: { type: 'string', description: 'Filter pull requests by author username.' },
        baseBranch: { type: 'string', description: 'Target branch name such as main.' },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of required label names.',
        },
        perPage: { type: 'integer', minimum: 1, maximum: 100, description: 'Page size.' },
      },
      required: ['repository'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_commits',
    description:
      'List repository git commits along a branch or revision range with author timestamps and diff statistics.',
    inputSchema: {
      type: 'object',
      properties: {
        repository: { type: 'string', description: 'Owner and repository slug.' },
        sha: { type: 'string', description: 'Branch name, tag, or commit SHA.' },
        sinceIso: { type: 'string', description: 'ISO-8601 start timestamp.' },
        untilIso: { type: 'string', description: 'ISO-8601 end timestamp.' },
        includeStats: { type: 'boolean', description: 'Include additions and deletions counts.' },
      },
      required: ['repository'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue_ticket',
    description:
      'Create a structured engineering issue ticket with title, markdown body, priority level, milestone, and assignees.',
    inputSchema: {
      type: 'object',
      properties: {
        projectKey: { type: 'string', description: 'Short uppercase project identifier.' },
        title: { type: 'string', description: 'Concise issue summary title.' },
        body: { type: 'string', description: 'Detailed problem reproduction steps.' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'], description: 'Issue priority.' },
        assignees: { type: 'array', items: { type: 'string' }, description: 'Assigned usernames.' },
      },
      required: ['projectKey', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'compute_quarterly_revenue',
    description:
      'Aggregate quarterly recurring revenue, churn rate, net retention, and cohort expansion across regional segments.',
    inputSchema: {
      type: 'object',
      properties: {
        fiscalYear: { type: 'integer', description: 'Four-digit fiscal year.' },
        fiscalQuarter: { type: 'integer', minimum: 1, maximum: 4, description: 'Quarter 1 through 4.' },
        segment: { type: 'string', enum: ['smb', 'midmarket', 'enterprise', 'all'], description: 'Customer segment.' },
        groupByRegion: { type: 'boolean', description: 'Break down metrics by geographic region.' },
      },
      required: ['fiscalYear', 'fiscalQuarter'],
      additionalProperties: false,
    },
  },
  {
    name: 'check_inventory_stock',
    description:
      'Check real-time warehouse stock levels, reserved units, and restock lead times for a list of product SKUs.',
    inputSchema: {
      type: 'object',
      properties: {
        skus: { type: 'array', items: { type: 'string' }, description: 'Product SKU codes to query.' },
        warehouseCode: { type: 'string', description: 'Optional regional warehouse identifier.' },
      },
      required: ['skus'],
      additionalProperties: false,
    },
  },
  {
    name: 'convert_timezone_schedule',
    description:
      'Convert meeting timestamps across IANA timezones and compute overlapping working hours for distributed teams.',
    inputSchema: {
      type: 'object',
      properties: {
        isoTimestamp: { type: 'string', description: 'Source ISO-8601 timestamp.' },
        sourceZone: { type: 'string', description: 'Source IANA timezone identifier.' },
        targetZones: { type: 'array', items: { type: 'string' }, description: 'Target IANA timezones.' },
      },
      required: ['isoTimestamp', 'targetZones'],
      additionalProperties: false,
    },
  },
  {
    name: 'validate_json_payload',
    description:
      'Validate an arbitrary JSON document against draft-07 schema constraints and report field-level validation issues.',
    inputSchema: {
      type: 'object',
      properties: {
        payload: { type: 'object', additionalProperties: true, description: 'Candidate JSON object.' },
        strictKeys: { type: 'boolean', description: 'Disallow undeclared properties.' },
      },
      required: ['payload'],
      additionalProperties: false,
    },
  },
  {
    name: 'failing_downstream_tool',
    description:
      'Diagnostic tool that deterministically returns an MCP tool execution error flag for error-handling verification.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Error message to echo back.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'slow_hang_with_grandchild',
    description:
      'Diagnostic timeout fixture that spawns an idle child process, records both PIDs to a file, and withholds its response.',
    inputSchema: {
      type: 'object',
      properties: {
        pidFile: { type: 'string', description: 'Filesystem path where server and grandchild PIDs are written.' },
      },
      required: ['pidFile'],
      additionalProperties: false,
    },
  },
];

function writeJsonRpc(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function handleRequest(msg: {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}): void {
  if (msg.id === undefined) {
    return;
  }

  if (msg.method === 'initialize') {
    writeJsonRpc({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-clean-server', version: '1.0.0' },
      },
    });
    return;
  }

  if (msg.method === 'tools/list') {
    writeJsonRpc({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: CLEAN_TOOLS,
      },
    });
    return;
  }

  if (msg.method === 'tools/call') {
    const toolName = String(msg.params?.['name'] ?? '');
    const args = (msg.params?.['arguments'] ?? {}) as Record<string, unknown>;

    if (toolName === 'fetch_order') {
      const orderId = String(args['orderId'] ?? 'ORD-0000');
      writeJsonRpc({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                orderId,
                customer: { id: 'CUST-42', tier: 'platinum' },
                items: [
                  { sku: 'SKU-LAPTOP-14', qty: 2 },
                  { sku: 'SKU-DOCK-USB4', qty: 1 },
                ],
              }),
            },
          ],
        },
      });
      return;
    }

    if (toolName === 'fetch_customer') {
      const customerId = String(args['customerId'] ?? 'CUST-UNKNOWN');
      writeJsonRpc({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                customerId,
                region: 'APAC',
                discountPct: 15,
              }),
            },
          ],
        },
      });
      return;
    }

    if (toolName === 'format_invoice') {
      const summary = [
        `Invoice for ${String(args['orderId'])}`,
        `Customer=${String(args['customerId'])}`,
        `Region=${String(args['region'])}`,
        `Discount=${String(args['discountPct'])}%`,
        `PrimarySKU=${String(args['firstSku'])}`,
        args['note'] ? `Note=${String(args['note'])}` : '',
      ]
        .filter(Boolean)
        .join(' | ');

      writeJsonRpc({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [{ type: 'text', text: summary }],
        },
      });
      return;
    }

    if (toolName === 'failing_downstream_tool') {
      writeJsonRpc({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          isError: true,
          content: [
            {
              type: 'text',
              text: String(args['reason'] ?? 'Simulated downstream failure'),
            },
          ],
        },
      });
      return;
    }

    if (toolName === 'slow_hang_with_grandchild') {
      const pidFile = String(args['pidFile'] ?? '');
      const gc = spawnDummyGrandchild();
      if (pidFile) {
        fs.writeFileSync(
          pidFile,
          JSON.stringify({
            serverPid: process.pid,
            grandchildPid: gc.pid,
          }),
          'utf8'
        );
      }
      // Intentionally do not respond so proxy timeout triggers process-tree reaping.
      return;
    }

    writeJsonRpc({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ echoedTool: toolName, echoedArgs: args }),
          },
        ],
      },
    });
    return;
  }

  writeJsonRpc({
    jsonrpc: '2.0',
    id: msg.id,
    error: { code: -32601, message: `Method not found: ${String(msg.method)}` },
  });
}

const decoder = new StringDecoder('utf8');
let buffer = '';
process.stdin.on('data', (chunk: Buffer) => {
  buffer += decoder.write(chunk);
  let idx = buffer.indexOf('\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx).replace(/\r$/, '').trim();
    buffer = buffer.slice(idx + 1);
    if (line.length > 0) {
      try {
        handleRequest(JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown> });
      } catch {
        // Ignore malformed test input.
      }
    }
    idx = buffer.indexOf('\n');
  }
});
