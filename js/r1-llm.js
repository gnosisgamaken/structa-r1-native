/**
 * r1-llm.js — Structa LLM client for Rabbit R1 endpoint.
 *
 * Sends user input (voice transcripts, image context) to the R1 LLM
 * and stores structured responses in project memory.
 *
 * Design:
 * - Natural prompts, not forced card format (the model doesn't follow rigid templates)
 * - Post-process responses into structured project context
 * - Validator catches tool/web drift and strips it
 * - System prompt is short and direct — no over-engineering
 */
(() => {
  const native = window.StructaNative;

  const API_BASE = 'https://r1a.boondit.site/quick-fox-53';
  const API_AUTH = 'Bearer 575932';
  const MODEL = 'r1-command';
  const MAX_TOKENS = 150;
  const TEMPERATURE = 0.5;

  let conversationHistory = [];
  const MAX_HISTORY = 12; // Keep last 6 exchanges

  const SYSTEM_PROMPT = [
    'You are Structa, a project cognition assistant for creative professionals.',
    'You help users manage projects through short, structured responses.',
    '',
    'Rules:',
    '- Be concise. 2-4 sentences max.',
    '- Focus on the user\'s project. Don\'t ask about GitHub repos or web sources.',
    '- When given a voice transcript, extract the intent and propose one concrete next step.',
    '- When given an image, describe what you see and how it connects to the project.',
    '- Never say "I can\'t access" anything. Work with what the user provides.',
    '- No markdown headers or long lists. Just direct advice.',
  ].join('\n');

  // === Anti-drift: strip tool/web mentions from responses ===
  const DRIFT_PATTERNS = [
    /github\.com|repository|repo name/gi,
    /can't access.*web|unable to.*web|can't browse/gi,
    /dlam|rabbit\.tech/gi,
    /web search|search for|look up online/gi,
    /I can't help without/gi,
  ];

  function sanitizeResponse(text) {
    if (!text) return '';
    let clean = text.trim();

    // Remove sentences that contain drift patterns
    const sentences = clean.split(/(?<=[.!?])\s+/);
    const filtered = sentences.filter(sentence => {
      return !DRIFT_PATTERNS.some(pattern => pattern.test(sentence));
    });

    clean = filtered.join(' ').trim();

    // If response was mostly drift, return empty
    if (clean.length < 10) return '';

    return clean;
  }

  function extractStructuredFields(text) {
    // Try to extract structured fields from the response
    const result = {
      raw: text,
      insight: '',
      next_action: '',
      confidence: 'med',
    };

    // Look for action suggestions
    const actionMatch = text.match(/(?:next step|suggest|recommend|you should|start by|begin with|try)[:\s]*(.{10,100})/i);
    if (actionMatch) result.next_action = actionMatch[1].trim();

    // Look for confidence signals
    if (/definitely|clearly|obvious|certain/i.test(text)) result.confidence = 'high';
    if (/maybe|perhaps|might|unclear|unsure/i.test(text)) result.confidence = 'low';

    result.insight = text;

    return result;
  }

  // === Core API call ===
  async function sendToLLM(userMessage, options = {}) {
    const {
      systemPrompt = SYSTEM_PROMPT,
      temperature = TEMPERATURE,
      maxTokens = MAX_TOKENS,
      addToHistory = true,
    } = options;

    const messages = [{ role: 'system', content: systemPrompt }];

    // Add conversation history
    messages.push(...conversationHistory);

    // Add current user message
    messages.push({ role: 'user', content: userMessage });

    try {
      const response = await fetch(`${API_BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': API_AUTH,
        },
        body: JSON.stringify({
          model: MODEL,
          messages,
          temperature,
          max_tokens: maxTokens,
          stop: ['\n\n'],
        }),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => 'unknown error');
        return { ok: false, error: `HTTP ${response.status}: ${errText}` };
      }

      const data = await response.json();
      const rawContent = data.choices?.[0]?.message?.content || '';

      // Sanitize
      const clean = sanitizeResponse(rawContent);
      if (!clean) {
        return { ok: false, error: 'response contained only drift', raw: rawContent };
      }

      // Add to history
      if (addToHistory) {
        conversationHistory.push({ role: 'user', content: userMessage });
        conversationHistory.push({ role: 'assistant', content: clean });
        // Trim history
        while (conversationHistory.length > MAX_HISTORY) {
          conversationHistory.shift();
        }
      }

      const structured = extractStructuredFields(clean);

      return {
        ok: true,
        raw: rawContent,
        clean,
        structured,
        usage: data.usage,
      };
    } catch (err) {
      return { ok: false, error: err.message || 'fetch failed' };
    }
  }

  // === Specialized entry points ===

  // Voice transcript → LLM
  async function processVoice(transcript) {
    const project = native?.getProjectMemory?.() || {};
    const context = [
      `Project: ${project.name || 'untitled'}`,
      project.backlog?.length ? `Open tasks: ${project.backlog[0]?.title || 'none'}` : '',
      project.decisions?.length ? `Last decision: ${project.decisions[0]?.title || 'none'}` : '',
      '',
      `User voice note: "${transcript}"`,
      '',
      'Extract the intent. Propose one concrete next action. Be specific to this project.',
    ].filter(Boolean).join('\n');

    return sendToLLM(context, { maxTokens: 120 });
  }

  // Image description → LLM
  async function processImage(imageDescription, captureMeta) {
    const project = native?.getProjectMemory?.() || {};
    const context = [
      `Project: ${project.name || 'untitled'}`,
      `Camera: ${captureMeta?.facingMode || 'environment'}`,
      '',
      `User captured an image. Description: "${imageDescription || 'no description yet'}"`,
      '',
      'What does this image tell us about the project? Identify 1-2 key elements.',
    ].join('\n');

    return sendToLLM(context, { maxTokens: 120 });
  }

  // General query
  async function query(question) {
    const project = native?.getProjectMemory?.() || {};
    const context = [
      `Project: ${project.name || 'untitled'}`,
      project.backlog?.length ? `Open: ${project.backlog.slice(0, 3).map(b => b.title).join(', ')}` : '',
      '',
      question,
    ].filter(Boolean).join('\n');

    return sendToLLM(context);
  }

  // Store LLM response as project insight
  function storeAsInsight(result, sourceType = 'llm') {
    if (!result?.ok || !result.clean) return null;

    return native?.touchProjectMemory?.(project => {
      project.insights = Array.isArray(project.insights) ? project.insights : [];
      project.insights.unshift({
        title: `${sourceType} insight`,
        body: result.clean,
        next: result.structured?.next_action || '',
        confidence: result.structured?.confidence || 'med',
        created_at: new Date().toISOString(),
      });
      project.insights = project.insights.slice(0, 16);
    });
  }

  // Clear conversation history
  function resetHistory() {
    conversationHistory = [];
  }

  window.StructaLLM = Object.freeze({
    sendToLLM,
    processVoice,
    processImage,
    query,
    storeAsInsight,
    resetHistory,
    get historyLength() { return conversationHistory.length; }
  });
})();
