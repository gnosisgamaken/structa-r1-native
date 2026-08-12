import assert from 'node:assert/strict';
import fs from 'node:fs';

const indexSource = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const cascadeSource = fs.readFileSync(new URL('../structa-cascade.js', import.meta.url), 'utf8');
const cameraSource = fs.readFileSync(new URL('../js/camera-capture.js', import.meta.url), 'utf8');
const r1Source = fs.readFileSync(new URL('../js/r1-llm.js', import.meta.url), 'utf8');
const visionSource = fs.readFileSync(new URL('../js/vision-protocol.js', import.meta.url), 'utf8');

let assertionCount = 0;

function check(condition, message) {
  assertionCount += 1;
  assert.ok(condition, message);
}

function has(source, pattern, message) {
  check(pattern.test(source), message);
}

function lacks(source, pattern, message) {
  check(!pattern.test(source), message);
}

// The r1 creation surface is a fixed instrument, not a responsive web page.
has(indexSource, /<meta\s+name=["']viewport["']\s+content=["'][^"']*width=240,\s*height=282[^"']*["']\s*\/?>/i,
  'viewport must declare the r1 240x282 surface');
has(indexSource, /<svg\s+id=["']scene["'][^>]*\bviewBox=["']0 0 240 282["']/i,
  'scene SVG must use a 240x282 viewBox');
has(indexSource, /#app\s*\{[\s\S]*?\bwidth:\s*min\(240px,\s*100vw\)\s*;/i,
  'app width must be capped at 240px');
has(indexSource, /#app\s*\{[\s\S]*?\bheight:\s*min\(282px,\s*100vh\)\s*;/i,
  'app height must be capped at 282px');
has(cascadeSource, /\{\s*x:\s*0,\s*y:\s*0,\s*width:\s*240,\s*height:\s*282,/,
  'cascade must paint full 240x282 surfaces');
lacks(cascadeSource, /\b(?:292|288)\b/,
  'legacy 292/288 geometry must not return');
lacks(cascadeSource, /font-weight\s*:\s*(?:["']\s*)?600\b/i,
  'cascade must not synthesize a 600 font weight');

// SHOW is a live reference-capture surface.
has(cascadeSource, /id:\s*["']show["'][\s\S]{0,220}?role:\s*["']capture reference["']/,
  'SHOW card must advertise reference capture');
lacks(cascadeSource, /show is off|show is coming later|coming later/i,
  'SHOW must not expose disabled or placeholder copy');
has(cascadeSource, /function\s+openCameraFromShow\s*\(/,
  'SHOW must provide a camera entry point');
has(cascadeSource, /function\s+primeCameraFromHardware\s*\(/,
  'SHOW must expose hardware-to-touch arming');
has(cascadeSource, /if\s*\(source\s*!==\s*["']touch["']\)\s*return\s+primeCameraFromHardware\(source\)/,
  'hardware camera requests must stop at touch arming');
has(cascadeSource, /StructaCamera\?\.openFromGesture\?\.\(options\.facingMode\s*\|\|\s*["']environment["']\)/,
  'the trusted touch path must invoke the native camera surface');
has(cascadeSource, /case\s+STATES\.SHOW_BROWSE:[\s\S]{0,180}?openCameraFromShow\(["']side["']\)/,
  'SHOW Side must route through camera touch arming');
has(cascadeSource, /["']data-hit-target["']:\s*["']camera-open["'][\s\S]{0,1500}?openCameraFromShow\(["']touch["']\)/,
  'SHOW must expose direct trusted-touch camera actions');
has(cascadeSource, /width:\s*46,\s*height:\s*MIN_DIRECT_TOUCH[\s\S]{0,220}?["']data-hit-target["']:\s*["']camera-open["']/,
  'the compact SHOW lens action must meet the 44px touch minimum');
has(cascadeSource, /data-hit-key["']:\s*["']show-empty["']/,
  'empty SHOW must expose a direct full-panel camera action');
lacks(cascadeSource, /SHOW_PRIMED|show_primed|camera-activation|touch required by r1/,
  'the removed camera activation interstitial must have no stale cascade path');
has(cascadeSource, /function\s+consumeArmedCameraTouch\s*\([\s\S]{0,700}?openCameraFromShow\(["']touch["']\)/,
  'an armed SHOW must consume the next trusted touch without an interstitial');
has(cascadeSource, /stateExitHandlers\[STATES\.SHOW_BROWSE\][\s\S]{0,500}?cameraRequestPending[\s\S]{0,300}?StructaCamera\?\.close/,
  'leaving SHOW must cancel a pending camera acquisition');
lacks(cascadeSource, /__structaCameraGuard|cameraHistoryGuard|history\.pushState|addEventListener\(["']popstate["']/,
  'camera navigation must not mutate WebView history or claim system Back');
has(indexSource, /#camera-cancel\s*\{[\s\S]{0,320}?min-height:\s*44px/,
  'the live camera must expose a 44px-high visible cancel control');
has(indexSource, /<button\s+id=["']camera-cancel["'][^>]*>cancel<\/button>/,
  'the live camera cancel control must be a real labeled button');
has(cameraSource, /cancelButton\?\.addEventListener\(["']pointerup["'][\s\S]{0,280}?stopPropagation\(\)[\s\S]{0,100}?close\(\)/,
  'the live camera cancel must stop the capture tap and close the lens');
has(cascadeSource, /case\s+STATES\.SHOW_BROWSE:[\s\S]{0,420}?getCaptureList\(\)[\s\S]{0,420}?showCaptureIndex/,
  'SHOW wheel path must browse stored references');

// KNOW is the project map, not the legacy insight feed.
has(cascadeSource, /id:\s*["']know["'][\s\S]{0,220}?role:\s*["']project map["']/,
  'KNOW card must advertise the project map');
has(cascadeSource, /function\s+getProjectMapView\s*\(/,
  'cascade must expose a project-map selector adapter');
has(cascadeSource, /engine\?\.getMapView/,
  'project map must prefer StructaProjectEngine.getMapView');
has(cascadeSource, /function\s+drawInsightSurface\s*\([\s\S]*?const\s+branches\s*=\s*map\.branches\s*\|\|\s*\[\]/,
  'KNOW renderer must consume map branches');
has(cascadeSource, /branches\.length\s*\+\s*["'] branches["']/,
  'KNOW must expose its compressed branch count');

// NOW chooses one intervention and approves decisions by stable identity.
has(cascadeSource, /function\s+getNowV3View\s*\(/,
  'cascade must expose the V3 NOW selector adapter');
has(cascadeSource, /engine\?\.getNowView/,
  'NOW must prefer StructaProjectEngine.getNowView');
has(cascadeSource, /intervention\.type\s*!==\s*["']decision["']/,
  'decision approval must be gated by the current intervention type');
has(cascadeSource, /approveDecision\(intervention\.id,\s*selectedOptionIndex,\s*selectedOption\)/,
  'NOW approval must use the intervention stable ID');
has(cascadeSource, /stateData\.nowInterventionId\s*!==\s*intervention\.id/,
  'NOW option selection must remain stable while the intervention is unchanged');

// Every direct choice remains finger-sized on the physical 240x282 display.
has(cascadeSource, /const\s+MIN_DIRECT_TOUCH\s*=\s*44\s*;/,
  'direct-touch doctrine must declare a 44px minimum');
const decisionFrameSource = cascadeSource.match(/function\s+decisionOptionFrame\s*\([\s\S]*?\n\s*function\s+drawNowPanel\s*\(/)?.[0] || '';
check((decisionFrameSource.match(/height:\s*MIN_DIRECT_TOUCH/g) || []).length === 3,
  'all 2/3/4-option decision frames must use the 44px minimum');
has(cascadeSource, /height:\s*frame\.height[\s\S]{0,220}?["']data-hit-target["']:\s*["']now-option["']/,
  'NOW decision options must expose inspectable direct-touch geometry');
has(cascadeSource, /height:\s*MIN_DIRECT_TOUCH[\s\S]{0,260}?["']data-hit-target["']:\s*["']uncertainty-action["']/,
  'uncertainty actions must expose inspectable direct-touch geometry');
has(cascadeSource, /height:\s*MIN_DIRECT_TOUCH[\s\S]{0,260}?["']data-hit-target["']:\s*["']tell-row["']/,
  'TELL note rows must expose inspectable direct-touch geometry');

// Visual uncertainty is batched, explicit, and human-reviewed.
has(cascadeSource, /const\s+actions\s*=\s*\[["']confirm["'],\s*["']correct["'],\s*["']dismiss["']\]/,
  'uncertainty review must offer confirm/correct/dismiss');
has(cascadeSource, /if\s*\(action\s*===\s*["']correct["']\)\s*return\s+beginUncertaintyCorrection\(item\)/,
  'correct must route into focused correction capture');
has(cascadeSource, /reviewUncertainty\?\.\(item\.id,\s*action,\s*["']["']\)/,
  'confirm/dismiss must apply through the project engine');
has(cascadeSource, /reviewUncertainty\?\.\(id,\s*["']correct["'],\s*correction\)/,
  'correction text must be supplied to the project engine');
has(cascadeSource, /if\s*\(!id\s*\|\|\s*!correction\)\s*return\s+false/,
  'empty correction text must never resolve uncertainty');

// Production remains calm; diagnostic affordances are opt-in only.
has(cascadeSource, /const\s+debugMode\s*=\s*new URLSearchParams\([\s\S]{0,100}?get\(["']debug["']\)\s*===\s*["']1["']/,
  'debug mode must be opt-in');
has(cascadeSource, /logDrawer\.style\.display\s*=\s*debugMode\s*\?\s*["']["']\s*:\s*["']none["']/,
  'log drawer must be hidden immediately in production');
has(cascadeSource, /logDrawer\.style\.display\s*=\s*debugMode\s*&&\s*!isContentSurface\s*\?\s*["']["']\s*:\s*["']none["']/,
  'render loop must keep production logs hidden');
has(cascadeSource, /function\s+allowMenuFlush\s*\(\)\s*\{\s*return\s+!!debugMode\s*&&\s*!!native\?\.flushMemory\s*;/,
  'flush control must require explicit debug mode');

// Script order protects the silent visual relay contract.
const visionIndex = indexSource.indexOf('js/vision-protocol.js');
const cameraIndex = indexSource.indexOf('js/camera-capture.js');
const llmIndex = indexSource.indexOf('js/r1-llm.js');
check(visionIndex >= 0, 'vision protocol must be loaded');
check(cameraIndex >= 0, 'camera capture must be loaded');
check(llmIndex >= 0, 'r1-llm must be loaded');
check(visionIndex < cameraIndex, 'vision protocol must load before camera capture');
check(visionIndex < llmIndex, 'vision protocol must load before r1-llm');

// App identity must be local and offline-safe.
const iconTags = Array.from(indexSource.matchAll(/<link\b[^>]*\brel=["'][^"']*icon[^"']*["'][^>]*>/gi), match => match[0]);
check(iconTags.length > 0, 'index must declare a favicon or touch icon');
const iconHrefs = iconTags.map(tag => tag.match(/\bhref=["']([^"']+)["']/i)?.[1] || '');
check(iconHrefs.every(href => href && !/^(?:https?:)?\/\//i.test(href)),
  'all favicon and touch-icon assets must be local');

// The retired journal/listenback experiment must never return to production.
lacks(cascadeSource, /com\.r1\.pixelart|magic-journal-fetch/i,
  'cascade must not retain the legacy image journal probe');
lacks(cascadeSource, /wantsJournalEntry\s*:\s*true|wantsR1Response\s*:\s*true/i,
  'cascade must not request journal writes or Rabbit speech');
lacks(r1Source, /sendR1CoverSpeech|followupFetch|listenback/i,
  'r1 bridge must not contain legacy cover or listenback recovery');
check((r1Source.match(/wantsR1Response\s*:\s*true/g) || []).length === 1,
  'r1 bridge may speak only through the single milestone allowlist path');
has(visionSource, /useLLM:\s*true,[\s\S]{0,120}?wantsR1Response:\s*false,[\s\S]{0,120}?wantsJournalEntry:\s*false/,
  'vision payload must remain silent and journal-free');

console.log(`v3 product static smoke · ${assertionCount} assertions passed`);
