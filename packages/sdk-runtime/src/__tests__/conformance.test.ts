import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  ConversationClaims,
  matchManifest,
  parseRuntimeJobs,
  parseRuntimeManifest,
} from '..';
import type { RuntimeUpdate } from '..';

interface RoutingFixture {
  name: string;
  update: RuntimeUpdate;
  matched: boolean;
  flowId?: string;
}

interface ConformanceFixture {
  manifest: unknown;
  routingCases: RoutingFixture[];
  jobsResponse: unknown;
}

function loadFixture(): ConformanceFixture {
  const path = resolve(__dirname, '../../../sdk-conformance/fixtures/protocol-v2.json');
  return JSON.parse(readFileSync(path, 'utf8')) as ConformanceFixture;
}

describe('protocol-v2 cross-language conformance fixture', () => {
  it.each(loadFixture().routingCases)('$name', ({ update, matched, flowId }) => {
    const fixture = loadFixture();
    const manifest = parseRuntimeManifest(fixture.manifest);

    const result = matchManifest(manifest, new ConversationClaims(), update);

    expect(result.matched).toBe(matched);
    expect(result.rule?.flowId).toBe(flowId);
  });

  it('parses the same canonical jobs exposed to every language adapter', () => {
    const jobs = parseRuntimeJobs(loadFixture().jobsResponse);

    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      id: 'job-send-1',
      leaseToken: 'lease-send-1',
      kind: 'transport_call',
      operation: 'sendMessage',
      method: 'sendMessage',
      conversationKey: '100',
    });
    expect(jobs[1]).toMatchObject({
      id: 'job-forbidden-1',
      operation: 'setWebhook',
    });
  });
});
