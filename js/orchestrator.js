(function() {
  'use strict';

  function postJSON(path, payload) {
    return fetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload || {})
    }).then(function(response) {
      return response.json().catch(function() {
        return { ok: false, error: 'invalid json response' };
      }).then(function(data) {
        if (!response.ok) {
          return Object.assign({ ok: false, status: response.status }, data || {});
        }
        return data;
      });
    }).catch(function(err) {
      return {
        ok: false,
        error: err && err.message ? err.message : 'request failed'
      };
    });
  }

  function normalizePolicy(policy) {
    return {
      priority: policy && policy.priority ? policy.priority : 'high',
      allowSearch: false,
      allowSpeech: false
    };
  }

  function run(endpoint, payload, executeLLM) {
    return postJSON(endpoint, payload).then(function(prepared) {
      if (!prepared || !prepared.ok) return prepared || { ok: false, error: 'prepare failed' };
      if (!prepared.llm || typeof executeLLM !== 'function') {
        return {
          ok: false,
          error: 'llm executor unavailable',
          ui: prepared.ui || {},
          meta: prepared.meta || {}
        };
      }
      return Promise.resolve(executeLLM(prepared)).then(function(rawResult) {
        if (!rawResult || !rawResult.ok) {
          return {
            ok: false,
            error: rawResult && rawResult.error ? rawResult.error : 'llm failed',
            ui: prepared.ui || {},
            meta: prepared.meta || {}
          };
        }
        return postJSON(endpoint, Object.assign({}, payload, {
          rawResponse: rawResult.clean || rawResult.text || '',
          llmMeta: {
            text: rawResult.text || '',
            clean: rawResult.clean || '',
            structured: rawResult.structured || null
          }
        }));
      });
    });
  }

  function interpretVoice(payload, executeLLM) {
    var envelope = Object.assign({}, payload || {});
    envelope.policy = normalizePolicy(envelope.policy);
    return run('/v1/voice/interpret', envelope, executeLLM);
  }

  function analyzeImage(payload, executeLLM) {
    var envelope = Object.assign({}, payload || {});
    envelope.policy = normalizePolicy(envelope.policy);
    return run('/v1/image/analyze', envelope, executeLLM);
  }

  function runChainStep(payload, executeLLM) {
    var envelope = Object.assign({}, payload || {});
    envelope.policy = normalizePolicy(envelope.policy || { priority: 'low' });
    return run('/v1/chain/step', envelope, executeLLM);
  }

  function synthesizeTriangle(payload, executeLLM) {
    var envelope = Object.assign({}, payload || {});
    envelope.policy = normalizePolicy(envelope.policy);
    return run('/v1/triangle/synthesize', envelope, executeLLM);
  }

  function titleProject(payload, executeLLM) {
    var envelope = Object.assign({}, payload || {});
    envelope.policy = normalizePolicy(envelope.policy);
    return run('/v1/project/title', envelope, executeLLM);
  }

  function refineThread(payload, executeLLM) {
    var envelope = Object.assign({}, payload || {});
    envelope.policy = normalizePolicy(envelope.policy || { priority: 'low' });
    return run('/v1/thread/refine', envelope, executeLLM);
  }

  function backfillClaims(payload, executeLLM) {
    var envelope = Object.assign({}, payload || {});
    envelope.policy = normalizePolicy(envelope.policy || { priority: 'low' });
    return run('/v1/claims/backfill', envelope, executeLLM);
  }

  window.StructaOrchestrator = Object.freeze({
    interpretVoice: interpretVoice,
    analyzeImage: analyzeImage,
    runChainStep: runChainStep,
    synthesizeTriangle: synthesizeTriangle,
    backfillClaims: backfillClaims,
    titleProject: titleProject,
    refineThread: refineThread
  });
})();
