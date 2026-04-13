
(() => {
  var n = window.StructaNative;
  var B = 'https://r1a.boondit.site/quick-fox-53';
  var A = 'Bearer ' + String(575932);
  var M = 'r1-command';
  var T = 150;
  var tmp = 0.5;
  var hist = [];
  var HMAX = 12;
  var SYS = 'You are Structa, project cognition assistant. Be concise 2-4 sentences. Focus on project, no GitHub/web questions. Extract intent from voice, propose one next action. Never say cannot access. No headers.';

  var DRIFT = [/github|repository/gi,/can.t access.*web/gi,/dlam|rabbit.tech/gi,/web search|look up online/gi,/I can.t help/gi];

  function clean(t){if(!t)return'';var s=t.trim().split(/(?<=[.!?])\s+/);s=s.filter(function(x){return!DRIFT.some(function(d){return d.test(x)})});return s.join(' ').trim()||'';}

  function fields(t){var r={raw:t,insight:t,next:'',conf:'med'};var m=t.match(/(?:next step|suggest|recommend|you should|start by|try)[:\s]*(.{10,100})/i);if(m)r.next=m[1].trim();if(/definitely|clearly/i.test(t))r.conf='high';if(/maybe|perhaps|might/i.test(t))r.conf='low';return r;}

  var lastCallTime = 0;
  var MIN_GAP_MS = 8000; // 8s between calls — respect device connection

  async function ask(msg,opts){
    // Rate limit: don't flood the R1 device connection
    var now = Date.now();
    var elapsed = now - lastCallTime;
    if (elapsed < MIN_GAP_MS) {
      await new Promise(function(r) { setTimeout(r, MIN_GAP_MS - elapsed); });
    }
    lastCallTime = Date.now();

    opts=opts||{};var ms=[{role:'system',content:opts.sys||SYS}];
    for(var i=0;i<hist.length;i++)ms.push(hist[i]);
    ms.push({role:'user',content:msg});
    try{
      var r=await fetch(B+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':A},body:JSON.stringify({model:M,messages:ms,temperature:opts.tmp!=null?opts.tmp:tmp,max_tokens:opts.tok||T,stop:['\n\n']})});
      if(!r.ok)return{ok:false,err:'HTTP '+r.status};
      var d=await r.json();var raw=(d.choices&&d.choices[0]&&d.choices[0].message)?d.choices[0].message.content:'';var c=clean(raw);if(!c)return{ok:false,err:'drift',raw:raw};
      if(opts.hist!==false){hist.push({role:'user',content:msg});hist.push({role:'assistant',content:c});while(hist.length>HMAX)hist.shift();}
      return{ok:true,raw:raw,clean:c,fields:fields(c),usage:d.usage};
    }catch(e){var errMsg = e.message || 'fail';
      if(n && n.appendLogEntry) n.appendLogEntry({kind:'llm',message:'llm err: '+errMsg.slice(0,60)});
      return{ok:false,err:errMsg};}
  }

  async function voice(t){var p=n&&n.getProjectMemory?n.getProjectMemory():{};var s=['Project: '+(p.name||'untitled')];if(p.backlog&&p.backlog.length)s.push('Tasks: '+p.backlog[0].title);if(p.decisions&&p.decisions.length)s.push('Decision: '+p.decisions[0].title);s.push('','Voice: "'+t+'"','','One next action.');return ask(s.filter(Boolean).join('\n'),{tok:120});}

  async function img(d,m){var p=n&&n.getProjectMemory?n.getProjectMemory():{};return ask('Project: '+(p.name||'untitled')+'\nCamera: '+(m&&m.facingMode||'environment')+'\n\nImage: "'+(d||'no desc')+'"\n\n1-2 key elements from this image.',{tok:120});}

  async function q(question){var p=n&&n.getProjectMemory?n.getProjectMemory():{};var s=['Project: '+(p.name||'untitled')];if(p.backlog&&p.backlog.length)s.push('Open: '+p.backlog.slice(0,3).map(function(b){return b.title}).join(', '));s.push('',question);return ask(s.filter(Boolean).join('\n'));}

  function save(r,src){if(!r||!r.ok||!r.clean)return null;if(!n||!n.touchProjectMemory)return null;return n.touchProjectMemory(function(p){p.insights=Array.isArray(p.insights)?p.insights:[];p.insights.unshift({title:(src||'llm')+' insight',body:r.clean,next:r.fields?r.fields.next:'',confidence:r.fields?r.fields.conf:'med',created_at:new Date().toISOString()});p.insights=p.insights.slice(0,16);});}

  function reset(){hist=[];}

  window.StructaLLM=Object.freeze({sendToLLM:ask,processVoice:voice,processImage:img,query:q,storeAsInsight:save,resetHistory:reset,get historyLength(){return hist.length;}});
})();
