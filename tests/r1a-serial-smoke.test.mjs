import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_R1A_BASE_URL,
  executeSmoke,
  parseArgs,
  parseAssistantJson,
  validateParsedCase
} from '../scripts/r1a-serial-smoke.mjs';

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    }
  };
}

function extractDispatch(message) {
  const text = typeof message.content === 'string' ? message.content : message.content[0].text;
  return {
    name: text.match(/^CASE: (.+)$/m)?.[1],
    caseId: text.match(/^CASE_ID: (.+)$/m)?.[1],
    requestId: text.match(/^REQUEST_ID: (.+)$/m)?.[1]
  };
}

function validPayload(dispatch) {
  const common = {
    case: dispatch.name,
    case_id: dispatch.caseId,
    request_id: dispatch.requestId
  };
  if (dispatch.name === 'project_map') {
    return {
      ...common,
      project_title: 'Open Studio',
      outcome: 'A tested public format',
      branches: ['audience', 'format', 'space', 'operations'].map(id => ({ id, title: id, status: 'open' }))
    };
  }
  if (dispatch.name === 'decision_gate') {
    return {
      ...common,
      decision: {
        question: 'Which participation model?',
        options: [
          { id: 'reach', label: 'Broad reach', tradeoff: 'Less depth' },
          { id: 'depth', label: 'Small groups', tradeoff: 'Less reach' }
        ],
        human_approval_required: true
      }
    };
  }
  return {
    ...common,
    branch_operation: 'open',
    branch_title: 'Audience evidence',
    research_questions: ['Who is nearby?', 'What would make them attend?'],
    close_when: 'Three audience interviews converge.'
  };
}

test('argument parser enforces the fifteen-second pacing floor', () => {
  assert.equal(parseArgs([]).gapMs, 15_000);
  assert.throws(() => parseArgs(['--gap-ms', '14999']), /cannot be lower/);
  assert.equal(parseArgs(['--gap-ms', '20000']).gapMs, 20_000);
  assert.equal(parseArgs(['--allow-custom-endpoint']).allowCustomEndpoint, true);
});

test('JSON parser tolerates a fenced object while correlation remains exact', () => {
  const testCase = { name: 'research_branch', caseId: 'case-1', requestId: 'request-1' };
  const parsed = parseAssistantJson(`\`\`\`json\n${JSON.stringify({
    case: 'research_branch',
    case_id: 'case-1',
    request_id: 'request-1',
    branch_operation: 'open',
    branch_title: 'Audience',
    research_questions: ['Who?', 'Why?'],
    close_when: 'Evidence converges.'
  })}\n\`\`\``);
  assert.equal(parsed.ok, true);
  assert.equal(validateParsedCase(testCase, parsed).ok, true);
});

test('live execution is serial, applies the completion gap, and leaks no credentials', async () => {
  let active = 0;
  let maxActive = 0;
  const sleeps = [];
  const fetchImpl = async (_url, init) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    const body = JSON.parse(init.body);
    const dispatch = extractDispatch(body.messages[0]);
    await Promise.resolve();
    active -= 1;
    return response(200, { choices: [{ message: { content: JSON.stringify(validPayload(dispatch)) } }] });
  };

  const report = await executeSmoke({
    baseUrl: 'https://provider.invalid/v1',
    apiKey: 'not-a-real-secret',
    model: 'mock-model',
    allowCustomEndpoint: true,
    fetchImpl,
    sleepImpl: async ms => sleeps.push(ms)
  });

  assert.equal(report.cases.length, 3);
  assert.equal(report.cases.every(item => item.validation.ok), true);
  assert.equal(maxActive, 1);
  assert.deepEqual(sleeps, [15_000, 15_000]);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('not-a-real-secret'), false);
  assert.equal(serialized.includes('provider.invalid'), false);
});

test('authentication failures stop the run without retries', async () => {
  let requests = 0;
  const report = await executeSmoke({
    baseUrl: 'https://provider.invalid/v1',
    apiKey: 'not-a-real-secret',
    model: 'mock-model',
    allowCustomEndpoint: true,
    fetchImpl: async () => {
      requests += 1;
      return response(401, { error: { message: 'Unauthorized' } });
    },
    sleepImpl: async () => {}
  });

  assert.equal(requests, 1);
  assert.equal(report.cases.length, 1);
  assert.equal(report.stopped_early, true);
  assert.equal(report.stop_reason, 'authentication_error');
});

test('a mismatched request id is a correlation fault and stops the run', async () => {
  let requests = 0;
  const report = await executeSmoke({
    baseUrl: 'https://provider.invalid/v1',
    apiKey: 'not-a-real-secret',
    model: 'mock-model',
    allowCustomEndpoint: true,
    fetchImpl: async (_url, init) => {
      requests += 1;
      const body = JSON.parse(init.body);
      const dispatch = extractDispatch(body.messages[0]);
      const payload = validPayload(dispatch);
      payload.request_id = 'wrong-request';
      return response(200, { choices: [{ message: { content: JSON.stringify(payload) } }] });
    },
    sleepImpl: async () => {}
  });

  assert.equal(requests, 1);
  assert.equal(report.stop_reason, 'correlation_error');
  assert.equal(report.cases[0].validation.correlation_error, true);
});

test('live endpoint policy defaults to Boondit HTTPS and requires an explicit custom-provider opt-in', async () => {
  let requests = 0;
  const neverFetch = async () => {
    requests += 1;
    throw new Error('fetch should not run');
  };

  await assert.rejects(
    executeSmoke({
      baseUrl: 'http://creations.boondit.site/api/r1a/v1',
      apiKey: 'not-a-real-secret',
      model: 'r1-llm',
      fetchImpl: neverFetch
    }),
    error => error?.code === 'insecure_endpoint'
  );
  await assert.rejects(
    executeSmoke({
      baseUrl: 'https://provider.invalid/v1',
      apiKey: 'not-a-real-secret',
      model: 'mock-model',
      fetchImpl: neverFetch
    }),
    error => error?.code === 'custom_endpoint_not_allowed'
  );
  assert.equal(requests, 0);
});

test('an omitted model is discovered from the pinned authenticated models route', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, authorization: init.headers.Authorization });
    if (init.method === 'GET') {
      return response(200, { object: 'list', data: [{ id: 'r1-llm' }] });
    }
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'r1-llm');
    const dispatch = extractDispatch(body.messages[0]);
    return response(200, { choices: [{ message: { content: JSON.stringify(validPayload(dispatch)) } }] });
  };

  const report = await executeSmoke({
    apiKey: 'not-a-real-secret',
    fetchImpl,
    sleepImpl: async () => {}
  });

  assert.equal(calls[0].url, `${DEFAULT_R1A_BASE_URL}/models`);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].authorization, 'Bearer not-a-real-secret');
  assert.equal(calls[1].url, `${DEFAULT_R1A_BASE_URL}/chat/completions`);
  assert.equal(report.configuration.model, 'r1-llm');
  assert.equal(report.configuration.model_source, 'discovered');
  assert.equal(report.configuration.custom_endpoint, false);
  assert.equal(report.cases.every(item => item.validation.ok), true);
});

test('model discovery refuses to guess when a provider advertises multiple models', async () => {
  let requests = 0;
  await assert.rejects(
    executeSmoke({
      apiKey: 'not-a-real-secret',
      fetchImpl: async () => {
        requests += 1;
        return response(200, { data: [{ id: 'r1-a' }, { id: 'r1-b' }] });
      },
      sleepImpl: async () => {}
    }),
    error => error?.code === 'model_required'
  );
  assert.equal(requests, 1);
});

test('experimental image input is limited to JPEG/PNG at one MiB', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'structa-r1a-test-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const webp = path.join(directory, 'reference.webp');
  const oversizedPng = path.join(directory, 'reference.png');
  await writeFile(webp, Buffer.from([0]));
  await writeFile(oversizedPng, Buffer.alloc((1024 * 1024) + 1));

  const common = {
    apiKey: 'not-a-real-secret',
    model: 'r1-llm',
    fetchImpl: async () => {
      throw new Error('fetch should not run');
    }
  };
  await assert.rejects(
    executeSmoke({ ...common, imagePath: webp }),
    error => error?.code === 'unsupported_image'
  );
  await assert.rejects(
    executeSmoke({ ...common, imagePath: oversizedPng }),
    error => error?.code === 'image_too_large'
  );
});
