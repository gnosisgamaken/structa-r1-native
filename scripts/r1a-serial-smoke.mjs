#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const TOOL_NAME = 'structa-r1a-provider-schema-smoke';
const DISCLAIMER = 'This probe validates an OpenAI-compatible provider path and STRUCTA-shaped JSON responses. The optional image lane is experimental. It does not validate STRUCTA creation integration, Rabbit hardware controls, camera handoff, Rabbit Hole behavior, or on-device rendering.';
export const DEFAULT_R1A_BASE_URL = 'https://creations.boondit.site/api/r1a/v1';
const DEFAULT_GAP_MS = 15_000;
const TIMEOUT_MS = 90_000;
const MAX_IMAGE_BYTES = 1 * 1024 * 1024;

function isoNow() {
  return new Date().toISOString();
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function safeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseInteger(value, flag) {
  if (!/^\d+$/.test(value || '')) {
    throw safeError('invalid_argument', `${flag} requires a whole number.`);
  }
  return Number(value);
}

export function parseArgs(argv) {
  const options = {
    dryRun: false,
    gapMs: DEFAULT_GAP_MS,
    imagePath: '',
    outPath: '',
    allowCustomEndpoint: false,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--gap-ms') {
      options.gapMs = parseInteger(argv[++index], '--gap-ms');
    } else if (arg === '--image') {
      options.imagePath = argv[++index] || '';
      if (!options.imagePath) throw safeError('invalid_argument', '--image requires a local file path.');
    } else if (arg === '--out') {
      options.outPath = argv[++index] || '';
      if (!options.outPath) throw safeError('invalid_argument', '--out requires a JSON file path.');
    } else if (arg === '--allow-custom-endpoint') {
      options.allowCustomEndpoint = true;
    } else {
      throw safeError('invalid_argument', `Unknown argument: ${arg}`);
    }
  }

  if (options.gapMs < DEFAULT_GAP_MS) {
    throw safeError('unsafe_gap', `--gap-ms cannot be lower than ${DEFAULT_GAP_MS}.`);
  }

  return options;
}

function caseEnvelope(runId, name) {
  return {
    name,
    caseId: `${name}_${runId}_${crypto.randomUUID()}`,
    requestId: makeId('request')
  };
}

function strictJsonInstruction({ name, caseId, requestId, schema }) {
  return [
    'Return one JSON object only. Do not use Markdown or explanatory text.',
    `CASE: ${name}`,
    `CASE_ID: ${caseId}`,
    `REQUEST_ID: ${requestId}`,
    'Copy CASE, CASE_ID, and REQUEST_ID into the response exactly.',
    `Required response shape: ${JSON.stringify(schema)}`
  ].join('\n');
}

export function buildCaseDefinitions(runId, { includeImage = false } = {}) {
  const map = caseEnvelope(runId, 'project_map');
  const decision = caseEnvelope(runId, 'decision_gate');
  const research = caseEnvelope(runId, 'research_branch');

  const cases = [
    {
      ...map,
      kind: 'text',
      prompt: `${strictJsonInstruction({
        ...map,
        schema: {
          case: map.name,
          case_id: map.caseId,
          request_id: map.requestId,
          project_title: 'string',
          outcome: 'string',
          branches: [{ id: 'string', title: 'string', status: 'open' }]
        }
      })}\n\nProject premise: Create a welcoming one-day neighborhood makers' open studio. Produce a concise initial project map with at least four distinct branches.`
    },
    {
      ...decision,
      kind: 'text',
      prompt: `${strictJsonInstruction({
        ...decision,
        schema: {
          case: decision.name,
          case_id: decision.caseId,
          request_id: decision.requestId,
          decision: {
            question: 'string',
            options: [{ id: 'string', label: 'string', tradeoff: 'string' }],
            human_approval_required: true
          }
        }
      })}\n\nProject context: The open studio can prioritize either broad footfall or deeper small-group participation, but not both in V1. Frame one decision with two or three mutually exclusive options. Do not choose for the user.`
    },
    {
      ...research,
      kind: 'text',
      prompt: `${strictJsonInstruction({
        ...research,
        schema: {
          case: research.name,
          case_id: research.caseId,
          request_id: research.requestId,
          branch_operation: 'open',
          branch_title: 'string',
          research_questions: ['string'],
          close_when: 'string'
        }
      })}\n\nProject context: The team does not yet know which neighborhood audiences would attend. Open one bounded research branch. Include at least two research questions and a concrete rule for closing the branch.`
    }
  ];

  if (includeImage) {
    const image = caseEnvelope(runId, 'image_observation');
    cases.push({
      ...image,
      kind: 'image',
      prompt: `${strictJsonInstruction({
        ...image,
        schema: {
          case: image.name,
          case_id: image.caseId,
          request_id: image.requestId,
          observations: ['string'],
          uncertainties: ['string'],
          project_implications: ['string']
        }
      })}\n\nInspect the supplied project reference. Separate visible observations from uncertainty. Do not identify people, infer sensitive traits, or invent unreadable text. Return at least one project implication.`
    });
  }

  return cases;
}

function imageMimeType(imagePath) {
  const extension = path.extname(imagePath).toLowerCase();
  const types = {
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.png': 'image/png'
  };
  const mimeType = types[extension];
  if (!mimeType) {
    throw safeError('unsupported_image', 'The experimental image probe accepts JPEG or PNG only.');
  }
  return mimeType;
}

async function loadImageDataUrl(imagePath) {
  let stat;
  try {
    stat = await fs.stat(imagePath);
  } catch {
    throw safeError('image_unreadable', 'The supplied image could not be read.');
  }
  if (!stat.isFile()) throw safeError('image_unreadable', 'The supplied image path is not a file.');
  if (stat.size > MAX_IMAGE_BYTES) {
    throw safeError('image_too_large', `The supplied image exceeds ${MAX_IMAGE_BYTES} bytes.`);
  }
  const mimeType = imageMimeType(imagePath);
  const bytes = await fs.readFile(imagePath);
  return `data:${mimeType};base64,${bytes.toString('base64')}`;
}

function normalizeProviderUrls(baseUrl, allowCustomEndpoint = false) {
  let parsed;
  try {
    parsed = new URL(baseUrl || DEFAULT_R1A_BASE_URL);
  } catch {
    throw safeError('invalid_configuration', 'R1A_BASE_URL must be an absolute HTTPS URL.');
  }
  if (parsed.protocol !== 'https:') {
    throw safeError('insecure_endpoint', 'R1A_BASE_URL must use HTTPS.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw safeError('invalid_configuration', 'R1A_BASE_URL must not contain credentials, a query, or a fragment.');
  }

  const trimmedPath = parsed.pathname.replace(/\/+$/, '');
  const completionSuffix = '/chat/completions';
  const basePath = trimmedPath.endsWith(completionSuffix)
    ? trimmedPath.slice(0, -completionSuffix.length)
    : trimmedPath;
  const official = new URL(DEFAULT_R1A_BASE_URL);
  const isOfficial = parsed.origin === official.origin && basePath === official.pathname;
  if (!isOfficial && !allowCustomEndpoint) {
    throw safeError(
      'custom_endpoint_not_allowed',
      'Custom providers require the explicit --allow-custom-endpoint flag.'
    );
  }

  const normalizedBase = `${parsed.origin}${basePath}`;
  return {
    completions: `${normalizedBase}${completionSuffix}`,
    models: `${normalizedBase}/models`,
    custom: !isOfficial
  };
}

function buildMessages(testCase, imageDataUrl) {
  if (testCase.kind !== 'image') {
    return [{ role: 'user', content: testCase.prompt }];
  }
  return [{
    role: 'user',
    content: [
      { type: 'text', text: testCase.prompt },
      { type: 'image_url', image_url: { url: imageDataUrl, detail: 'low' } }
    ]
  }];
}

function assistantContent(providerBody) {
  const content = providerBody?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(part => part && (part.type === 'text' || typeof part.text === 'string'))
      .map(part => part.text || '')
      .join('');
  }
  return '';
}

export function parseAssistantJson(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, value: null, error: 'empty_assistant_response' };
  }
  const trimmed = raw.trim();
  const candidates = [trimmed];
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) candidates.push(fenced[1].trim());
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(trimmed.slice(firstBrace, lastBrace + 1));

  for (const candidate of [...new Set(candidates)]) {
    try {
      return { ok: true, value: JSON.parse(candidate), error: null };
    } catch {
      // Try the next bounded representation without exposing parser internals.
    }
  }
  return { ok: false, value: null, error: 'invalid_json' };
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateMap(value, errors) {
  if (!isNonEmptyString(value.project_title)) errors.push('project_title must be a non-empty string');
  if (!isNonEmptyString(value.outcome)) errors.push('outcome must be a non-empty string');
  if (!Array.isArray(value.branches) || value.branches.length < 4) {
    errors.push('branches must contain at least four items');
  } else if (!value.branches.every(branch => isNonEmptyString(branch?.id) && isNonEmptyString(branch?.title) && branch?.status === 'open')) {
    errors.push('each branch must contain id, title, and status=open');
  }
}

function validateDecision(value, errors) {
  const decision = value.decision;
  if (!decision || typeof decision !== 'object') {
    errors.push('decision must be an object');
    return;
  }
  if (!isNonEmptyString(decision.question)) errors.push('decision.question must be a non-empty string');
  if (!Array.isArray(decision.options) || decision.options.length < 2 || decision.options.length > 3) {
    errors.push('decision.options must contain two or three items');
  } else if (!decision.options.every(option => isNonEmptyString(option?.id) && isNonEmptyString(option?.label) && isNonEmptyString(option?.tradeoff))) {
    errors.push('each decision option must contain id, label, and tradeoff');
  }
  if (decision.human_approval_required !== true) errors.push('decision.human_approval_required must be true');
}

function validateResearch(value, errors) {
  if (value.branch_operation !== 'open') errors.push('branch_operation must equal open');
  if (!isNonEmptyString(value.branch_title)) errors.push('branch_title must be a non-empty string');
  if (!Array.isArray(value.research_questions) || value.research_questions.length < 2 || !value.research_questions.every(isNonEmptyString)) {
    errors.push('research_questions must contain at least two non-empty strings');
  }
  if (!isNonEmptyString(value.close_when)) errors.push('close_when must be a non-empty string');
}

function validateImage(value, errors) {
  if (!Array.isArray(value.observations) || value.observations.length < 1 || !value.observations.every(isNonEmptyString)) {
    errors.push('observations must contain at least one non-empty string');
  }
  if (!Array.isArray(value.uncertainties) || !value.uncertainties.every(isNonEmptyString)) {
    errors.push('uncertainties must be an array of non-empty strings');
  }
  if (!Array.isArray(value.project_implications) || value.project_implications.length < 1 || !value.project_implications.every(isNonEmptyString)) {
    errors.push('project_implications must contain at least one non-empty string');
  }
}

export function validateParsedCase(testCase, parsed) {
  const errors = [];
  let correlationError = false;
  if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return { ok: false, correlation_error: false, errors: [parsed.error || 'response must be a JSON object'] };
  }

  const value = parsed.value;
  if (value.case !== testCase.name) {
    errors.push('case does not match the dispatched case');
    correlationError = true;
  }
  if (value.case_id !== testCase.caseId) {
    errors.push('case_id does not match the dispatched case');
    correlationError = true;
  }
  if (value.request_id !== testCase.requestId) {
    errors.push('request_id does not match the dispatched request');
    correlationError = true;
  }

  if (testCase.name === 'project_map') validateMap(value, errors);
  if (testCase.name === 'decision_gate') validateDecision(value, errors);
  if (testCase.name === 'research_branch') validateResearch(value, errors);
  if (testCase.name === 'image_observation') validateImage(value, errors);

  return { ok: errors.length === 0, correlation_error: correlationError, errors };
}

function providerErrorText(bodyText) {
  try {
    const body = JSON.parse(bodyText);
    const message = body?.error?.message ?? body?.message ?? '';
    return typeof message === 'string' ? message.slice(0, 1_000) : '';
  } catch {
    return '';
  }
}

function classifyProviderStop(status, providerText) {
  if (status === 401 || status === 403) return 'authentication_error';
  if (/\b(?:unauthorized|forbidden|authentication failed|invalid api key)\b/i.test(providerText)) return 'authentication_error';
  if (status === 429) return 'rate_limit_error';
  if (/\b(?:rate limit|too many requests|throttl)/i.test(providerText)) return 'rate_limit_error';
  if (/\b(?:request[_ -]?id mismatch|correlation error|correlation mismatch)/i.test(providerText)) return 'correlation_error';
  if ([409, 410, 419, 440].includes(status)) return 'session_error';
  if (/\b(?:session|credential|token)\b.{0,30}\b(?:expired|invalid|ended|revoked)\b/i.test(providerText)) return 'session_error';
  return status >= 400 ? 'provider_http_error' : '';
}

function classifyAssistantStop(raw) {
  if (/\b(?:unauthorized|forbidden|authentication failed|invalid api key)\b/i.test(raw)) return 'authentication_error';
  if (/\b(?:session|credential|token)\b.{0,30}\b(?:expired|invalid|ended|revoked)\b/i.test(raw)) return 'session_error';
  if (/\b(?:rate limit|too many requests|throttl)/i.test(raw)) return 'rate_limit_error';
  if (/\b(?:request[_ -]?id mismatch|correlation error|correlation mismatch)/i.test(raw)) return 'correlation_error';
  return '';
}

async function resolveProviderModel({ modelsEndpoint, apiKey, model, fetchImpl }) {
  const explicit = typeof model === 'string' ? model.trim() : '';
  if (explicit) return { id: explicit, source: 'explicit' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response;
  let bodyText = '';
  try {
    response = await fetchImpl(modelsEndpoint, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      signal: controller.signal
    });
    bodyText = await response.text();
  } catch (error) {
    const timedOut = controller.signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError';
    throw safeError(
      timedOut ? 'model_discovery_timeout' : 'model_discovery_failed',
      timedOut ? 'Model discovery timed out.' : 'Model discovery did not complete.'
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const stop = classifyProviderStop(response.status, providerErrorText(bodyText));
    throw safeError(stop || 'model_discovery_failed', 'The provider model list request failed.');
  }

  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw safeError('invalid_model_list', 'The provider returned an invalid model list.');
  }
  const ids = [...new Set(
    (Array.isArray(body?.data) ? body.data : [])
      .map(item => (typeof item?.id === 'string' ? item.id.trim() : ''))
      .filter(Boolean)
  )];
  if (ids.length === 1) return { id: ids[0], source: 'discovered' };
  if (ids.length > 1) {
    throw safeError('model_required', 'R1A_MODEL is required because the provider advertises multiple models.');
  }
  throw safeError('model_required', 'R1A_MODEL is required because the provider did not advertise one usable model.');
}

async function dispatchCase({ endpoint, apiKey, model, testCase, imageDataUrl, fetchImpl }) {
  const startedAt = isoNow();
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response;
  let bodyText = '';

  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Request-ID': testCase.requestId
      },
      body: JSON.stringify({
        model,
        messages: buildMessages(testCase, imageDataUrl),
        temperature: 0,
        max_tokens: 700,
        stream: false
      }),
      signal: controller.signal
    });
    bodyText = await response.text();
  } catch (error) {
    const timedOut = controller.signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError';
    return {
      case_id: testCase.caseId,
      request_id: testCase.requestId,
      case: testCase.name,
      kind: testCase.kind,
      timestamp: startedAt,
      latency_ms: Math.round(performance.now() - started),
      http_status: null,
      raw_assistant_response: null,
      json_parse: { ok: false, error: timedOut ? 'request_timeout' : 'request_not_completed' },
      validation: { ok: false, correlation_error: false, errors: [timedOut ? 'request timed out' : 'request did not complete'] },
      stop_reason: timedOut ? 'timeout_error' : 'network_error'
    };
  } finally {
    clearTimeout(timer);
  }

  const providerText = providerErrorText(bodyText);
  const providerStop = classifyProviderStop(response.status, providerText);
  if (!response.ok) {
    return {
      case_id: testCase.caseId,
      request_id: testCase.requestId,
      case: testCase.name,
      kind: testCase.kind,
      timestamp: startedAt,
      latency_ms: Math.round(performance.now() - started),
      http_status: response.status,
      raw_assistant_response: null,
      json_parse: { ok: false, error: 'provider_http_error' },
      validation: { ok: false, correlation_error: providerStop === 'correlation_error', errors: ['provider request failed'] },
      stop_reason: providerStop || 'provider_http_error'
    };
  }

  let providerBody;
  try {
    providerBody = JSON.parse(bodyText);
  } catch {
    providerBody = null;
  }
  const raw = assistantContent(providerBody);
  const parsed = parseAssistantJson(raw);
  const validation = validateParsedCase(testCase, parsed);
  const assistantStop = classifyAssistantStop(raw);
  const stopReason = validation.correlation_error ? 'correlation_error' : assistantStop;

  return {
    case_id: testCase.caseId,
    request_id: testCase.requestId,
    case: testCase.name,
    kind: testCase.kind,
    timestamp: startedAt,
    latency_ms: Math.round(performance.now() - started),
    http_status: response.status,
    raw_assistant_response: raw,
    json_parse: { ok: parsed.ok, error: parsed.error },
    validation,
    stop_reason: stopReason || null
  };
}

export async function executeSmoke({
  baseUrl = DEFAULT_R1A_BASE_URL,
  apiKey,
  model,
  gapMs = DEFAULT_GAP_MS,
  imagePath = '',
  allowCustomEndpoint = false,
  dryRun = false,
  fetchImpl = globalThis.fetch,
  sleepImpl = delay
}) {
  const runId = makeId('run');
  const startedAt = isoNow();
  const cases = buildCaseDefinitions(runId, { includeImage: Boolean(imagePath) });
  const providerUrls = normalizeProviderUrls(baseUrl, allowCustomEndpoint);
  const explicitModel = typeof model === 'string' ? model.trim() : '';
  const report = {
    tool: TOOL_NAME,
    disclaimer: DISCLAIMER,
    mode: dryRun ? 'dry-run' : 'live',
    run_id: runId,
    started_at: startedAt,
    finished_at: null,
    configuration: {
      model: explicitModel || null,
      model_source: explicitModel ? 'explicit' : null,
      timeout_ms: TIMEOUT_MS,
      gap_ms: gapMs,
      serial: true,
      retries: 0,
      case_count: cases.length,
      image_supplied: Boolean(imagePath),
      image_experimental: Boolean(imagePath),
      custom_endpoint: providerUrls.custom
    },
    stopped_early: false,
    stop_reason: null,
    cases: []
  };

  if (dryRun) {
    report.cases = cases.map(testCase => ({
      case_id: testCase.caseId,
      request_id: testCase.requestId,
      case: testCase.name,
      kind: testCase.kind,
      status: 'not_sent'
    }));
    report.finished_at = isoNow();
    return report;
  }

  if (!apiKey) {
    throw safeError('missing_configuration', 'R1A_API_KEY is required for a live run.');
  }
  if (typeof fetchImpl !== 'function') throw safeError('missing_fetch', 'This probe requires Node.js fetch support.');

  const resolvedModel = await resolveProviderModel({
    modelsEndpoint: providerUrls.models,
    apiKey,
    model: explicitModel,
    fetchImpl
  });
  report.configuration.model = resolvedModel.id;
  report.configuration.model_source = resolvedModel.source;
  const imageDataUrl = imagePath ? await loadImageDataUrl(imagePath) : '';

  for (let index = 0; index < cases.length; index += 1) {
    if (index > 0) await sleepImpl(gapMs);
    const result = await dispatchCase({
      endpoint: providerUrls.completions,
      apiKey,
      model: resolvedModel.id,
      testCase: cases[index],
      imageDataUrl,
      fetchImpl
    });
    report.cases.push(result);
    if (result.stop_reason) {
      report.stopped_early = index < cases.length - 1;
      report.stop_reason = result.stop_reason;
      break;
    }
  }

  report.finished_at = isoNow();
  return report;
}

function helpText() {
  return [
    'STRUCTA R1 Anywhere serial smoke probe',
    '',
    'Usage:',
    '  npm run --silent smoke:r1a -- --dry-run',
    '  npm run --silent smoke:r1a',
    '  npm run --silent smoke:r1a -- --image ./reference.png --gap-ms 20000 --out ./r1a-report.json',
    '',
    'Options:',
    '  --dry-run       Print a sanitized case plan without credentials or network access.',
    '  --image PATH     Add one experimental image_url case after text (JPEG/PNG, max 1 MiB).',
    '  --gap-ms N       Gap after each completed request; minimum and default are 15000 ms.',
    '  --out PATH       Write the final JSON report to this explicit path instead of stdout.',
    '  --allow-custom-endpoint',
    '                   Permit an explicit non-Boondit HTTPS provider URL.',
    '  --help           Show this help.',
    '',
    DISCLAIMER
  ].join('\n');
}

async function writeReport(report, outPath) {
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (outPath) {
    await fs.writeFile(outPath, json, { encoding: 'utf8', flag: 'w' });
  } else {
    process.stdout.write(json);
  }
}

async function main() {
  let options = { outPath: '' };
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${helpText()}\n`);
      return;
    }
    const report = await executeSmoke({
      baseUrl: process.env.R1A_BASE_URL || DEFAULT_R1A_BASE_URL,
      apiKey: process.env.R1A_API_KEY || '',
      model: process.env.R1A_MODEL || '',
      gapMs: options.gapMs,
      imagePath: options.imagePath,
      allowCustomEndpoint: options.allowCustomEndpoint,
      dryRun: options.dryRun
    });
    await writeReport(report, options.outPath);
    const failed = report.stop_reason || report.cases.some(testCase => testCase.validation && !testCase.validation.ok);
    if (failed) process.exitCode = 1;
  } catch (error) {
    const report = {
      tool: TOOL_NAME,
      disclaimer: DISCLAIMER,
      mode: 'configuration-error',
      timestamp: isoNow(),
      error: {
        code: error?.code || 'probe_error',
        message: error?.code ? error.message : 'The probe could not complete.'
      }
    };
    try {
      await writeReport(report, options.outPath);
    } catch {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }
    process.exitCode = 2;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
