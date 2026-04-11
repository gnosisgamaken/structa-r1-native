(() => {
  const contracts = window.StructaContracts;

  function result(ok, value, errors = []) {
    return { ok, value, errors };
  }

  function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  function validateEnvelope(raw = {}) {
    const payload = contracts.createEnvelope(raw);
    const errors = [];

    if (!isNonEmptyString(payload.project_code)) errors.push('project_code is required');
    if (!isNonEmptyString(payload.entry_id)) errors.push('entry_id is required');
    if (!contracts.allowedVerbs.includes(payload.verb)) errors.push(`verb must be one of: ${contracts.allowedVerbs.join(', ')}`);
    if (!contracts.allowedTargets.includes(payload.target)) errors.push(`target must be one of: ${contracts.allowedTargets.join(', ')}`);
    if (!isNonEmptyString(payload.approval_mode)) errors.push('approval_mode is required');

    return errors.length ? result(false, payload, errors) : result(true, payload, []);
  }

  function validateCaptureBundle(raw = {}) {
    const payload = contracts.createCaptureBundle(raw);
    const errors = [];

    if (!isNonEmptyString(payload.project_code)) errors.push('project_code is required');
    if (!isNonEmptyString(payload.entry_id)) errors.push('entry_id is required');
    if (!isNonEmptyString(payload.input_type)) errors.push('input_type is required');
    if (!payload.image_asset) errors.push('image_asset is required');

    return errors.length ? result(false, payload, errors) : result(true, payload, []);
  }

  function validateJournalEntry(raw = {}) {
    const payload = contracts.createJournalEntry(raw);
    const errors = [];

    if (!isNonEmptyString(payload.project_code)) errors.push('project_code is required');
    if (!isNonEmptyString(payload.entry_id)) errors.push('entry_id is required');
    if (!isNonEmptyString(payload.title)) errors.push('title is required');
    if (!isNonEmptyString(payload.body)) errors.push('body is required');

    return errors.length ? result(false, payload, errors) : result(true, payload, []);
  }

  function validateAsset(raw = {}) {
    const payload = {
      project_code: raw.project_code || contracts.baseProjectCode,
      entry_id: raw.entry_id || contracts.makeEntryId('asset'),
      kind: raw.kind || 'asset',
      name: raw.name || '',
      mime_type: raw.mime_type || 'application/octet-stream',
      data: raw.data || null,
      meta: raw.meta || {}
    };
    const errors = [];

    if (!isNonEmptyString(payload.project_code)) errors.push('project_code is required');
    if (!isNonEmptyString(payload.entry_id)) errors.push('entry_id is required');
    if (!isNonEmptyString(payload.name)) errors.push('name is required');
    if (!payload.data) errors.push('data is required');

    return errors.length ? result(false, payload, errors) : result(true, payload, []);
  }

  function validationMessage(label, errors) {
    return `${label} rejected: ${errors.join('; ')}`;
  }

  window.StructaValidation = Object.freeze({
    validateEnvelope,
    validateCaptureBundle,
    validateJournalEntry,
    validateAsset,
    validationMessage,
    isNonEmptyString
  });
})();
