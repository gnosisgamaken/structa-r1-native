(() => {
  const native = window.StructaNative;
  const contracts = window.StructaContracts;
  const validation = window.StructaValidation;

  function createCaptureBundle(raw = {}) {
    const asset = raw.image_asset || raw.asset || null;
    return contracts.createCaptureBundle({
      project_code: raw.project_code || contracts.baseProjectCode,
      entry_id: raw.entry_id || contracts.makeEntryId('capture'),
      source_type: raw.source_type || 'camera',
      input_type: raw.input_type || 'image',
      captured_at: raw.captured_at || new Date().toISOString(),
      image_asset: asset,
      prompt_text: raw.prompt_text || 'camera capture',
      ai_response: raw.ai_response || '',
      summary: raw.summary || '',
      approval_state: raw.approval_state || 'draft',
      tags: Array.isArray(raw.tags) ? raw.tags : [],
      links: Array.isArray(raw.links) ? raw.links : [],
      meta: raw.meta || {}
    });
  }

  function saveCaptureBundle(raw = {}) {
    const bundle = createCaptureBundle(raw);
    const verdict = validation.validateCaptureBundle(bundle);
    if (!verdict.ok) {
      return { ok: false, payload: verdict.value, errors: verdict.errors };
    }
    native?.storeCaptureBundle?.(verdict.value);
    return { ok: true, payload: verdict.value };
  }

  window.StructaCaptureBundles = Object.freeze({
    createCaptureBundle,
    saveCaptureBundle
  });
})();
