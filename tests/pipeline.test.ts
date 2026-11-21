import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runPipeline } from '../src/pipeline.js';
import type { DownstreamCallResult, PipelineStep } from '../src/types.js';

describe('Multi-step Pipeline Runner & Prototype-Pollution Guard', () => {
  it('substitutes ${steps.<idx>.text}, ${steps.<idx>.json.<path>}, array indices, and step ids while preserving JSON types', async () => {
    const capturedCalls: Array<{ toolId: string; args: Record<string, unknown> }> = [];

    const mockInvoker = async (
      toolId: string,
      args: Record<string, unknown>
    ): Promise<DownstreamCallResult> => {
      capturedCalls.push({ toolId, args });

      if (toolId === 'orders.get') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                orderId: 'ORD-777',
                customer: { id: 'CUST-99' },
                items: [{ sku: 'SKU-ALPHA', qty: 4 }],
              }),
            },
          ],
        };
      }

      if (toolId === 'crm.profile') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                region: 'EU-WEST',
                discountPct: 20,
                verified: true,
              }),
            },
          ],
        };
      }

      if (toolId === 'billing.render_memo') {
        return {
          content: [{ type: 'text', text: 'MEMO-APPROVED' }],
        };
      }

      if (toolId === 'billing.finalize') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: true,
                receivedDiscountType: typeof args['discountPct'],
                receivedVerifiedType: typeof args['verified'],
                summary: args['summaryLine'],
                memo: args['memo'],
              }),
            },
          ],
        };
      }

      throw new Error(`Unexpected tool ${toolId}`);
    };

    const steps: PipelineStep[] = [
      {
        id: 'orderStep',
        toolId: 'orders.get',
        arguments: { orderId: 'ORD-777' },
      },
      {
        id: 'crmStep',
        toolId: 'crm.profile',
        arguments: { customerId: '${steps.0.json.customer.id}' },
      },
      {
        toolId: 'billing.render_memo',
        arguments: { rawOrderId: '${steps.orderStep.json.orderId}' },
      },
      {
        toolId: 'billing.finalize',
        arguments: {
          discountPct: '${steps.1.json.discountPct}',
          verified: '${steps.crmStep.json.verified}',
          memo: '${steps.2.text}',
          summaryLine:
            'Order ${steps.0.json.orderId} SKU=${steps.0.json.items.0.sku} Region=${steps.1.json.region}',
        },
      },
    ];

    const result = await runPipeline(steps, mockInvoker);
    assert.equal(result.stepsExecuted, 4);
    assert.equal(capturedCalls[1]!.args['customerId'], 'CUST-99');
    assert.equal(capturedCalls[3]!.args['discountPct'], 20);
    assert.equal(capturedCalls[3]!.args['verified'], true);
    assert.equal(capturedCalls[3]!.args['memo'], 'MEMO-APPROVED');
    assert.equal(
      capturedCalls[3]!.args['summaryLine'],
      'Order ORD-777 SKU=SKU-ALPHA Region=EU-WEST'
    );
    assert.deepEqual(result.finalOutput.json, {
      ok: true,
      receivedDiscountType: 'number',
      receivedVerifiedType: 'boolean',
      summary: 'Order ORD-777 SKU=SKU-ALPHA Region=EU-WEST',
      memo: 'MEMO-APPROVED',
    });
  });

  it('strictly blocks __proto__, constructor, prototype, and inherited properties', async () => {
    const dummyInvoker = async (): Promise<DownstreamCallResult> => ({
      content: [{ type: 'text', text: JSON.stringify({ safe: 'ok' }) }],
    });

    const forbiddenExpressions = [
      '${steps.0.json.__proto__.polluted}',
      '${steps.0.json.constructor.name}',
      '${steps.0.json.prototype}',
      '${steps.__proto__.text}',
      '${steps.0.json.toString}',
    ];

    for (const expr of forbiddenExpressions) {
      await assert.rejects(
        () =>
          runPipeline(
            [
              { toolId: 'srv.first', arguments: {} },
              { toolId: 'srv.second', arguments: { leak: expr } },
            ],
            dummyInvoker
          ),
        /(prototype pollution guard|Own property)/i,
        `Expected rejection for expression: ${expr}`
      );
    }

    // Also reject forbidden step id
    await assert.rejects(
      () =>
        runPipeline([{ id: '__proto__', toolId: 'srv.first', arguments: {} }], dummyInvoker),
      /prototype pollution guard/i
    );
  });

  it('enforces 1..10 step bounds, rejects forward references, and halts on downstream isError', async () => {
    const dummyInvoker = async (toolId: string): Promise<DownstreamCallResult> => {
      if (toolId === 'srv.fail') {
        return { isError: true, content: [{ type: 'text', text: 'Database offline' }] };
      }
      return { content: [{ type: 'text', text: 'ok' }] };
    };

    await assert.rejects(() => runPipeline([], dummyInvoker), /between 1 and 10 steps/i);

    const elevenSteps: PipelineStep[] = Array.from({ length: 11 }, (_, i) => ({
      toolId: `srv.t${i}`,
    }));
    await assert.rejects(() => runPipeline(elevenSteps, dummyInvoker), /between 1 and 10 steps/i);

    await assert.rejects(
      () =>
        runPipeline(
          [
            { toolId: 'srv.ok', arguments: { bad: '${steps.0.text}' } },
          ],
          dummyInvoker
        ),
      /cannot reference future or current step/i
    );

    let afterFailCalled = false;
    await assert.rejects(
      () =>
        runPipeline(
          [{ toolId: 'srv.fail' }, { toolId: 'srv.after' }],
          async (toolId) => {
            if (toolId === 'srv.after') {
              afterFailCalled = true;
            }
            return dummyInvoker(toolId);
          }
        ),
      /Pipeline failed at step 0/i
    );
    assert.equal(afterFailCalled, false);
  });
});
