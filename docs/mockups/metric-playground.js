/* Design prototype only. Uses the shipped scalar interpreter in a disposable
 * worker, with a small aggregate scaffold. No production APIs or stored data. */
(() => {
  const $ = id => document.getElementById(id);
  const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const names = { platform:'Platform', worker:'Worker', overall:'Overall', day:'Day (UTC)' };
  const examples = {
    ratio: 'SUM([useful_ms]) /\nNULLIF(SUM([total_ms]), 0)',
    pass: 'SUM(IF([overall] = "PASS", 1, 0)) / COUNT()',
    regex: 'SUM(IF(REGEX_TEST([job_name], "^build-", "i"), 1, 0))',
    count: 'COUNT()',
    error: 'SUM([useful_ms]) / SUM([total_ms])',
    invalid: 'SUM([useful_ms]) / [total_ms]'
  };
  examples.trend=examples.ratio; examples.pie=examples.count;
  const initial = [
    { id:'share', name:'Useful-time share', source:examples.ratio, scope:'allMatching', groupBy:['platform'], sortKey:'value', dir:'desc', nulls:'last', groupLimit:20, display:'table', format:'percent', decimals:1, mode:'formula' },
    { id:'runs', name:'Run count', source:'COUNT()', scope:'allMatching', groupBy:[], sortKey:'value', dir:'desc', nulls:'last', groupLimit:20, display:'table', format:'number', decimals:0, mode:'basic' }
  ];
  initial.forEach(d=>Object.assign(d,{valueLabel:'',xLabel:'',yLabel:'',cardWidthRem:20,cardHeightRem:12,minWidthRem:14,minHeightRem:10,pivotSwap:false,rowDir:'asc',columnDir:'asc'}));
  const remPx=()=>parseFloat(getComputedStyle(document.documentElement).fontSize)||16;
  const clone = v => JSON.parse(JSON.stringify(v));
  let persist=()=>false;
  let saved = clone(initial), drafts = clone(initial), active = 'share', inspection = 0;
  let dashboardMode=false, previewWidth=320, previewHeight=200, canvasWidth=1000, resizing=false, draggedId=null, previewForId=null;
  let workbench=null, expressionTarget='formula', outputAxis='value';
  const expressionInput=()=>$(expressionTarget);
  const dashboardJobs=new Map();
  let worker = null, timer = null, watchdog = null, generation = 0, previousFocus = null;
  const valid = new Map(initial.map(d => [d.id, true]));
  const cache = new Map();
  const current = () => drafts.find(d => d.id === active);
  const isDistribution=d=>['box','histogram'].includes(d.display);
  const signature = d => JSON.stringify([isDistribution(d)?d.rowSource:d.source, d.display==='scatter'?d.sourceY:null, d.scope, d.groupBy, isDistribution(d)?[d.display,d.boxWhiskers||'minmax',d.display==='histogram'?d.histogramBins??10:null]:null]);
  const dirty = () => JSON.stringify(saved) !== JSON.stringify(drafts);
  function format(value, d=current()) {
    return window.metricOutput.format(value,window.metricOutput.spec(d,d.display==='scatter'?'x':'value'));
  }
  function outputProblem(d) {
    const axes=d.display==='scatter'?['x','y']:['value'];
    return axes.map(axis=>window.metricOutput.validate(window.metricOutput.spec(d,axis))).find(Boolean)||'';
  }
  function refreshOutputControls() {
    const d=current();if(!d)return;
    if(d.display!=='scatter')outputAxis='value';else if(outputAxis==='value')outputAxis='x';
    const s=window.metricOutput.spec(d,outputAxis),temporal=window.metricOutput.isTemporal(s.format);
    $('format').value=s.format;$('x-format').value=d.xFormat||'number';$('y-format').value=d.yFormat||'number';
    $('format-target-control').hidden=d.display!=='scatter';$('format-target').value=outputAxis;
    $('temporal-format-controls').hidden=!temporal;$('output-example').hidden=!temporal;$('output-format-help').hidden=!temporal;
    $('decimals').disabled=temporal;
    $('legend-control').hidden=!['pie','donut','scatter','histogram'].includes(d.display);$('legend-position').value=d.legendPosition||'right';
    $('distribution-controls').hidden=!isDistribution(d);$('box-controls').hidden=d.display!=='box';$('histogram-controls').hidden=d.display!=='histogram';
    $('box-whiskers').value=d.boxWhiskers||'minmax';$('box-mean').checked=d.boxMean!==false;$('histogram-bins').value=d.histogramBins??10;
    $('distribution-help').textContent=d.display==='box'?'Each box summarizes row values: Q1, median, Q3 and whiskers. The circle marks the mean; outliers are separate.':'Bin boundaries use every scoped numeric value, before group limits. All groups share the same edges; bar height is a row count.';
    $('list-controls').hidden=d.display!=='list';$('list-bars').checked=d.listBars!==false;$('list-colors').checked=d.listColors!==false;$('list-values').checked=d.listValues!==false;
    if(temporal){
      $('output-unit').innerHTML=window.metricOutput.units(s.format).map(o=>`<option value="${o.value}">${escape(o.label)}</option>`).join('');
      $('output-style').innerHTML=window.metricOutput.styles(s.format).map(o=>`<option value="${o.value}">${escape(o.label)}</option>`).join('');
      $('output-unit').value=s.sourceUnit||(s.format==='duration'?'milliseconds':'iso');$('output-style').value=s.style||'human';
      $('output-pattern-control').hidden=s.style!=='custom';$('output-pattern').value=s.pattern??window.metricOutput.defaultPattern(s.format);
      $('output-zone-control').hidden=s.format==='duration'||['secondsOfDay','millisecondsOfDay'].includes(s.sourceUnit);$('output-timezone').value=s.timeZone||'UTC';
      $('output-format-help').textContent=s.format==='duration'?'Elapsed amount; no calendar or timezone conversion. Custom: {d}, {h}, {hh}, {m}, {mm}, {s}, {ss}, {ms}.': 'Custom: YYYY MM DD MMM MMMM ddd HH hh mm ss SSS A Z. Put literal words in [brackets]. Date-only and clock-only strings keep their calendar fields.';
      const entry=cache.get(d.id),result=entry?.signature===signature(d)?entry.result:null,bucket=result?.buckets?.find(b=>(outputAxis==='y'?b.y:b.value)!==null),raw=bucket?(outputAxis==='y'?bucket.y:bucket.value):s.format==='duration'?84000:s.format==='time'?'14:30:00':'2026-10-08T14:30:00Z';
      const rendered=window.metricOutput.result(raw,s);
      $('output-example').innerHTML=`<span>${bucket?'Result':'Example'}: ${escape(String(raw))} · ${escape($('output-unit').selectedOptions[0]?.textContent||'')}</span><strong>${escape(rendered.text)}</strong>${rendered.error?`<span>${escape(rendered.error)}</span>`:''}`;
    }
    $('output-format-error').textContent=outputProblem(d);
  }
  function setOutput(patch) {
    const outputFormats={...current().outputFormats,[outputAxis]:{...current().outputFormats?.[outputAxis],...patch}};
    update({outputFormats},false);refreshOutputControls();
  }
  function setOutputKind(kind,axis=outputAxis) {
    outputAxis=axis;
    const outputFormats={...current().outputFormats,[axis]:{sourceUnit:kind==='duration'?'milliseconds':'iso',style:'human',timeZone:'UTC'}};
    update({[axis==='value'?'format':axis+'Format']:kind,outputFormats},false);refreshOutputControls();
  }
  function cancelWorker() {
    clearTimeout(timer); clearTimeout(watchdog);
    if (worker) worker.terminate(); worker = null;
    generation++;
  }
  function renderLibrary() {
    $('draft-count').textContent = `· ${drafts.length}`;
    $('library-items').innerHTML = drafts.map(d => `<div class="library-row" aria-current="${d.id === active}" data-order-id="${escape(d.id)}"><button class="metric-handle" draggable="true" data-drag-id="${escape(d.id)}" aria-label="Reorder ${escape(d.name)}" title="Drag to move; use Alt + arrow keys">⠿</button><button class="library-item" data-id="${escape(d.id)}" aria-current="${d.id === active}"><strong>${escape(d.name || 'Untitled metric')}${JSON.stringify(saved.find(s => s.id === d.id)) !== JSON.stringify(d) ? ' ·' : ''}</strong><span>${d.groupBy.map(g => names[g]).join(' × ') || 'One value'} · ${d.scope === 'allMatching' ? 'All matching' : 'Shown rows'}</span></button><button class="menu-trigger" data-menu-id="${escape(d.id)}" aria-label="Actions for ${escape(d.name)}" aria-haspopup="menu">⋯</button></div>`).join('');
    if(dashboardMode) renderDashboard();
    $('edit-metric').disabled=!current();
    $('remove').disabled = !current(); $('duplicate').disabled = !current() || drafts.length >= 20; $('add-metric').disabled = drafts.length >= 20;
    const index = drafts.findIndex(d => d.id === active);
    $('move-up').disabled = index <= 0; $('move-down').disabled = index < 0 || index === drafts.length - 1;
    $('draft-status').textContent = dirty() ? 'Unsaved changes · Apply to update the table.' : 'Changes stay in this draft until applied.';
    $('apply').disabled = drafts.some(d => !valid.get(d.id) || !d.name.trim() || outputProblem(d) || window.metricCharts.reason(d,cache.get(d.id)?.signature === signature(d) ? cache.get(d.id).result.buckets || [] : []));
  }
  function loadDefinition() {
    const d = current();
    $('workspace').querySelector('.definition').hidden = !d;
    $('workspace').querySelector('.preview').hidden = !d;
    renderLibrary();
    if (!d) return;
    $('name').value = d.name; $('formula').value = isDistribution(d)?d.rowSource||'[total_ms]':d.source;
    $('formula-y').value=d.sourceY||''; $('scatter-expressions').hidden=d.display!=='scatter';
    $('expression-label').textContent=isDistribution(d)?'Values to summarize':d.display==='scatter'?'X expression':'Expression';
    $('basic-mode').hidden=$('formula-mode').hidden=isDistribution(d);
    $('x-format').value=d.xFormat||'number';$('y-format').value=d.yFormat||'number';
    if(d.display!=='scatter')expressionTarget='formula';
    $('scope-all').setAttribute('aria-pressed', String(d.scope === 'allMatching'));
    $('scope-shown').setAttribute('aria-pressed', String(d.scope === 'shownRows'));
    $('scope-help').textContent = d.scope === 'allMatching' ? 'Uses every match; ignores the table’s limit and offset.' : 'Uses the 100 logical rows on page 1, including offscreen rows.';
    renderGroups();
    for(const [id,key] of Object.entries({'value-label':'valueLabel','x-label':'xLabel','y-label':'yLabel','card-width':'cardWidthRem','card-height':'cardHeightRem','min-width':'minWidthRem','min-height':'minHeightRem'})) $(id).value=d[key];
    if(previewForId!==d.id){previewForId=d.id;previewWidth=Math.max(d.cardWidthRem,d.minWidthRem)*remPx();previewHeight=Math.max(d.cardHeightRem,d.minHeightRem)*remPx();} sizePreview();
    const options = [{ value:'value', name:isDistribution(d)?'Median':d.display==='scatter'?'X value':'Metric value' }, ...(d.display==='scatter'?[{value:'y',name:'Y value'}]:[]),...(isDistribution(d)?[{value:'samples',name:'Numeric samples'}]:[]), ...d.groupBy.map((g,i) => ({ value:`group${i}`, name:names[g] })), { value:'count', name:'Rows in group' }];
    if (!options.some(o => o.value === d.sortKey)) d.sortKey = 'value';
    $('sort-key').innerHTML = options.map(o => `<option value="${o.value}">${o.name}</option>`).join('');
    $('sort-key').value = d.sortKey; $('sort-dir').value = d.dir;
    $('nulls').value = d.nulls; $('group-limit').value = d.groupLimit;
    $('sort-controls').hidden = !d.groupBy.length;
    $('display').value = d.display; $('display').disabled = false;
    $('group-limit').disabled = d.display === 'line';
    $('sort-key').disabled = $('sort-dir').disabled = $('nulls').disabled = d.display === 'line';
    $('sort-controls').querySelector('.field-label').textContent = d.display === 'line' ? 'Line axis order' : 'Sort group results';
    $('sort-controls').querySelector('.help').textContent = d.display === 'line' ? 'Complete key order. Nulls and errors break the line; ranking is retained for other displays.' : d.groupBy.length===2 ? 'Ranking selects the first buckets. Pivot row / column keys have their own ordering.' : 'Aggregate → sort → show first groups. Errors last; ties follow keys.';
    if(d.display === 'line') { $('sort-key').value='group0';$('sort-dir').value='asc'; }
    $('display-help').textContent = isDistribution(d)?'Use a numeric row expression, such as [total_ms] or [useful_ms] / NULLIF([total_ms], 0). Do not wrap it in SUM or AVG.':d.display === 'line' ? 'Time axis stays chronological; complete series is shown.' : ['pie','donut'].includes(d.display) ? 'Additive quantities only. Excluded groups become Other.' : d.display==='scatter'?'Two numeric measures per group. Missing/error pairs are omitted and disclosed.' : 'One group key for charts; time keys for lines; additive counts/sums for pie.';
    [...$('display').options].forEach(option => {
      option.disabled = option.value === 'line' ? d.groupBy.length !== 1 || d.groupBy[0] !== 'day' : ['pie','donut'].includes(option.value) ? d.groupBy.length !== 1 || !window.metricCharts.additive(d.source) : option.value==='scatter' ? !d.groupBy.length : option.value.startsWith('bar-') ? d.groupBy.length !== 1 : option.value==='histogram'?d.groupBy.length>1:!d.groupBy.length&&!['table','box','histogram'].includes(option.value);
    });
    $('decimals').value=d.decimals;refreshOutputControls();
    const basic = isDistribution(d)?null:d.source.match(/^(COUNT|SUM|AVG|MIN|MAX)\((?:\[([^\]]+)\])?\)$/i);
    $('basic-mode').disabled = !basic;
    $('basic-mode').title = basic ? '' : 'This formula cannot be represented in Basic.';
    $('formula-mode').setAttribute('aria-pressed', String((d.mode === 'formula'||isDistribution(d))));
    $('basic-mode').setAttribute('aria-pressed', String((d.mode === 'basic'&&!isDistribution(d))));
    $('basic-controls').hidden = d.mode !== 'basic'||isDistribution(d); $('formula-controls').hidden = (d.mode === 'basic'&&!isDistribution(d));
    if (basic) { $('basic-op').value = basic[1].toUpperCase(); $('basic-field').value = basic[2] || ''; }
    $('function-concept').querySelector('[value="aggregate"]').disabled=isDistribution(d);if(isDistribution(d)&&$('function-concept').value==='aggregate')$('function-concept').value='row';$('function-search').dispatchEvent(new Event('input'));
    refreshSummaries();requestPreview();
  }
  function update(patch, recompute = true) {
    Object.assign(current(), patch);
    $('preview-card-title').textContent=current().name; inspection = 0;
    refreshSummaries();renderLibrary();
    if (recompute) requestPreview(); else renderPreview();
  }
  function requestPreview() {
    cancelWorker();
    const d = current(); if (!d) return;
    const hit = cache.get(d.id);
    if (hit && hit.signature === signature(d)) { valid.set(d.id, !hit.result.error); renderLibrary(); renderPreview(); return; }
    valid.set(d.id, false); renderLibrary();
    $('validation').textContent = 'Checking expression…'; $('validation').className = 'validation';
    $('result').innerHTML = '<div class="scalar muted small">Calculating preview…</div>';
    $('inspect').hidden = true; $('preview-foot').textContent = '';
    $('preview-scope').textContent = d.scope === 'allMatching' ? 'All 12,840 matching rows' : '100 shown rows · page 1';
    const run = generation, id = d.id, sig = signature(d), request = clone(d);
    timer = setTimeout(() => {
      worker = new Worker('metric-playground.worker.js');
      const finish = result => {
        if (run !== generation || id !== active) return;
        clearTimeout(watchdog); worker?.terminate(); worker = null;
        cache.set(id, { signature:sig, result }); valid.set(id, !result.error);
        renderLibrary(); renderPreview();
      };
      worker.onmessage = e => finish(e.data);
      worker.onerror = e => finish({ error:`Preview failed: ${e.message}` });
      watchdog = setTimeout(() => finish({ error:'Preview exceeded its 3-second budget. Simplify the formula and try again.' }), 3000);
      worker.postMessage(request);
    }, 180);
  }
  function compare(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    const aa = Array.from(String(a)), bb = Array.from(String(b));
    for (let i=0; i<Math.min(aa.length,bb.length); i++) if (aa[i] !== bb[i]) return aa[i].codePointAt(0) - bb[i].codePointAt(0);
    return aa.length - bb.length;
  }
  function ordered(result, d) {
    const key = b => d.sortKey==='samples'?b.distribution?.n??b.distribution?.summary?.n:d.sortKey === 'value' ? b.value : d.sortKey === 'y' ? b.y : d.sortKey === 'count' ? b.count : b.keys[Number(d.sortKey.slice(5))];
    return [...result.buckets].sort((a,b) => {
      const aError=!!(a.error || (d.display==='scatter' && a.yError)),bError=!!(b.error || (d.display==='scatter' && b.yError));
      if (aError !== bError) return aError ? 1 : -1;
      const av=key(a), bv=key(b);
      if ((av == null) !== (bv == null)) return (av == null ? 1 : -1) * (d.nulls === 'first' ? -1 : 1);
      const primary = av == null || bv == null ? 0 : compare(av,bv) * (d.dir === 'asc' ? 1 : -1);
      if (primary) return primary;
      for (let i=0; i<a.keys.length; i++) { const c=compare(a.keys[i],b.keys[i]); if(c) return c; }
      return 0;
    });
  }
  function renderPreview() {
    const d = current(), entry = cache.get(d?.id); if (!d || !entry || entry.signature !== signature(d)) return;
    const result = entry.result;
    $('preview-scope').textContent = `${d.scope === 'allMatching' ? 'All ' : ''}${(result.processedRows || (d.scope === 'allMatching' ? 12840 : 100)).toLocaleString()} ${d.scope === 'allMatching' ? 'matching' : 'shown'} rows${d.scope === 'shownRows' ? ' · page 1' : ''}`;
    $('preview-note').textContent = isDistribution(d)?'Summarize scoped row values, then rank groups. Distribution shape is retained.':d.source.includes('REGEX_') ? 'JavaScript regex · shown-row worker only; no full-dataset regex execution.' : 'Aggregate all input rows, then apply result ordering and display.';
    $('status').textContent = ''; $('inspect').hidden = !!result.error;
    if (result.error) {
      $('validation').textContent = result.error; $('validation').className = 'validation error';
      $('result').innerHTML = `<div class="error-box" role="alert"><strong>Cannot preview this formula</strong><p>${escape(result.error)}</p>${result.code === 'regex_scope' ? '<button data-use-shown>Use shown rows</button>' : '<span>Use row fields inside aggregates, such as SUM([total_ms]).</span>'}</div>`;
      $('preview-foot').textContent = 'Fix the expression to apply this draft.'; return;
    }
    $('validation').textContent = isDistribution(d)?'✓ Valid row expression · exact local distribution':'✓ Valid group expression · exact local preview'; $('validation').className = 'validation';
    const allBuckets = ordered(result, d), buckets = d.display === 'line' ? [...allBuckets].sort((a,b)=>new Date(a.keys[0])-new Date(b.keys[0])) : allBuckets.slice(0,d.groupBy.length ? d.groupLimit : 1);
    window.metricPrototypeLastResult = { spec:clone(d), ...result, ordered:allBuckets, visible:buckets };
    const value = b => b.error ? '<span style="color:var(--error)">Error</span>' : `<span title="Raw result: ${escape(String(b.value))}" class="${b.value === null ? 'null' : ''}">${escape(format(b.value))}</span>`;
    $('preview-card-title').textContent=d.name;
    if (!d.groupBy.length&&!isDistribution(d)) $('result').innerHTML = `<div class="result scalar"><div class="small muted">${escape(d.valueLabel || '')}</div><div class="value">${buckets[0] ? value(buckets[0]) : '—'}</div><div class="small muted">${result.processedRows.toLocaleString()} rows</div></div>`;
    else if (['bar-horizontal','bar-vertical','line','pie','donut','scatter','box','histogram'].includes(d.display)) {
      const chart=window.metricCharts.render({...d,renderWidth:previewWidth-22,renderHeight:previewHeight-48},buckets,allBuckets,format,escape);
      $('result').innerHTML=chart.html; $('status').textContent=chart.note;
      if(chart.reason) $('apply').disabled=true;
    } else if (d.display === 'list') {
      $('result').innerHTML = listMarkup(d,buckets,value);
    } else $('result').innerHTML = tableMarkup(d,buckets,allBuckets,value,true);
    $('preview-foot').textContent = `${buckets.length} of ${allBuckets.length} groups · ${d.display==='line'?'chronological key order':'raw values sorted before formatting'}`;
    const b = buckets[Math.min(inspection,buckets.length-1)];
    $('inspect').hidden = !b;
    if (b) {
      $('inspect-head').textContent = `Inspect ${b.keys.join(' / ') || 'all rows'}`;
      $('components').innerHTML = [...b.components,...(b.yComponents||[]).map(c=>({...c,expression:'Y: '+c.expression}))].map(c => `<div class="component-row"><span class="mono">${escape(c.expression)}</span><span>${escape(typeof c.value === 'number' ? c.value.toLocaleString('en-US', { maximumFractionDigits:3 }) : c.value ?? 'NULL')}</span></div>`).join('') + `<div class="component-row"><span>Rows in this group</span><span>${b.count.toLocaleString()}</span></div>`;
      $('explain').textContent = b.error ? b.error : b.distribution ? `${b.distribution.summary?.n??b.distribution.n??0} numeric samples · ${b.nullCount} NULL values excluded. ${b.distribution.kind==='box'?'Exact linearly interpolated quartiles; '+(b.distribution.summary?.outlierCount||0)+' outliers.':'Shared bin edges; final bin includes its upper bound.'}` : b.value === null ? 'NULL result. In this example NULLIF turns a zero denominator into NULL; NULL propagates through division.' : d.display==='scatter'?`X: ${b.error||(b.value??'NULL')} · Y: ${b.yError||(b.y??'NULL')}. Paired by the full typed group key.` : d.source.includes('/') ? 'Divide the reduced values once for this group. This is not an average of individual row ratios.' : 'The expression is evaluated independently over the rows in this group.';
    }
    refreshOutputControls();renderCards();
  }
  function tableMarkup(d,buckets,all,value,interactive=false) {
    if(d.groupBy.length===2) {
      const rowIndex=d.pivotSwap?1:0,colIndex=1-rowIndex;
      const unique=index=>[...new Map(buckets.map(b=>[JSON.stringify(b.keys[index]),b.keys[index]])).values()];
      const rows=unique(rowIndex).sort((a,b)=>compare(a,b)*(d.rowDir==='desc'?-1:1)),cols=unique(colIndex).sort((a,b)=>compare(a,b)*(d.columnDir==='desc'?-1:1));
      return `<div class="result"><table class="pivot"><thead><tr><th>${escape(names[d.groupBy[rowIndex]])} ↓ / ${escape(names[d.groupBy[colIndex]])} →</th>${cols.map(k=>`<th class="num">${escape(k??'NULL')}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr><th>${escape(r??'NULL')}</th>${cols.map(c=>{const index=buckets.findIndex(b=>b.keys[rowIndex]===r && b.keys[colIndex]===c);const b=buckets[index];const omitted=all.some(b=>b.keys[rowIndex]===r&&b.keys[colIndex]===c);return `<td class="num ${b?'':'absent'}" ${b&&interactive?`data-bucket="${index}" tabindex="0" role="button"`:''} title="${b?escape(d.valueLabel||'Value'):omitted?'Omitted by group limit':'No matching rows'}">${b?value(b):omitted?'…':'·'}</td>`;}).join('')}</tr>`).join('')}</tbody></table></div>`;
    }
    const heading=(key,label)=>interactive?`<button data-sort="${key}">${escape(label)}${d.sortKey===key?d.dir==='asc'?' ↑':' ↓':''}</button>`:escape(label);
    return `<div class="result"><table><thead><tr>${d.groupBy.map((g,i)=>`<th>${heading('group'+i,names[g])}</th>`).join('')}<th class="num">${heading('value',d.valueLabel||'Value')}</th><th class="num">${heading('count','Rows')}</th></tr></thead><tbody>${buckets.map((b,i)=>`<tr ${interactive?`data-bucket="${i}" tabindex="0"`:''}>${b.keys.map(k=>`<td>${escape(k??'NULL')}</td>`).join('')}<td class="num">${value(b)}</td><td class="num">${b.count.toLocaleString()}</td></tr>`).join('')}</tbody></table></div>`;
  }
  function renderGroups() {
    const d=current();
    $('groupings').innerHTML=Array.from({length:Math.max(2,d.groupBy.length)},(_,i)=>`<div class="group-row"><span class="muted small">${i+1}</span><select id="group${i+1}" data-group-index="${i}" aria-label="Grouping ${i+1}"><option value="">${i===0?'No grouping':'+ Add grouping'}</option>${Object.entries(names).map(([key,label])=>`<option value="${key}" ${d.groupBy[i]===key?'selected':''} ${d.groupBy.includes(key)&&d.groupBy[i]!==key?'disabled':''}>${label}</option>`).join('')}</select>${d.groupBy[i]?`<button data-group-remove="${i}" aria-label="Remove grouping ${i+1}">×</button>${i>0?`<button data-group-up="${i}" aria-label="Move grouping ${i+1} up">↑</button>`:''}`:''}</div>`).join('');
    $('add-group').disabled=d.groupBy.length===Object.keys(names).length;
    $('group-help').textContent=d.groupBy.length===2?'Table uses rows × columns. Missing combinations stay empty; no ratio totals are invented.':d.groupBy.length>=3?'All grouping keys appear as columns in a compact tuple table.':'Add as many distinct groupings as your schema supports.';
    $('pivot-controls').hidden=d.groupBy.length!==2; $('row-order').value=d.rowDir;$('column-order').value=d.columnDir;
  }
  function setGroups(list) {
    const d=current(),oldField=d.sortKey.startsWith('group')?d.groupBy[Number(d.sortKey.slice(5))]:null;
    const groupBy=[...new Set(list.filter(Boolean))];
    const index=oldField?groupBy.indexOf(oldField):-1;
    update({groupBy,...(oldField?{sortKey:index<0?'value':'group'+index}:{}),...(!groupBy.length&&!isDistribution(current())?{display:'table'}:{})});loadDefinition();
  }
  function listMarkup(d,buckets,value) {
    const bars=d.listBars!==false&&buckets.every(b=>b.value===null||(!b.error&&typeof b.value==='number'&&Number.isFinite(b.value)&&b.value>=0));
    const values=d.listValues!==false,colors=d.listColors!==false;
    const max=Math.max(...buckets.map(b=>typeof b.value==='number'?b.value:0),1e-9);
    return `<div class="result list">${buckets.map((b,i)=>{const label=b.keys.join(' / '),color=colors?window.metricColors.category(d.groupBy[0],b.keys[0]):window.metricColors.token('accent');const detail=`${label}: ${b.error||format(b.value,d)}`;return `<div class="list-row ${bars?'':'no-bars'} ${values?'':'no-values'}" data-bucket="${i}" data-tooltip="${escape(detail)}" tabindex="0" role="button" aria-label="Inspect ${escape(detail)}"><span>${colors?`<i class="category-dot" style="background:${escape(color)}"></i>`:''}${escape(label)}</span>${bars?`<div class="track"><div class="fill" style="width:${typeof b.value==='number'?b.value/max*100:0}%;background:${escape(color)}"></div></div>`:''}${values?`<span class="list-value">${value(b)}</span>`:''}</div>`;}).join('')}</div>`;
  }
  function cardContent(d,width,height) {
    const hit=cache.get(d.id),result=hit?.signature===signature(d)?hit.result:null;
    if(!result) return '<div class="scalar muted small">Calculating preview…</div>';
    if(result.error) return `<div class="error-box">${escape(result.error)}</div>`;
    const all=ordered(result,d),buckets=d.display==='line'?[...all].sort((a,b)=>new Date(a.keys[0])-new Date(b.keys[0])):all.slice(0,d.groupBy.length?d.groupLimit:1);
    const val=b=>escape(b.error?'Error':format(b.value,d));
    if(!d.groupBy.length&&!isDistribution(d)) return `<div class="scalar"><div class="value">${val(buckets[0]||{value:null})}</div><div class="small muted">${escape(d.valueLabel||'')}</div></div>`;
    if(['bar-horizontal','bar-vertical','line','pie','donut','scatter','box','histogram'].includes(d.display)) return window.metricCharts.render({...d,renderWidth:Math.max(158,width-22),renderHeight:Math.max(70,height-50)},buckets,all,v=>format(v,d),escape).html.split('<details')[0].replace(/ role="button"/g,'');
    if(d.display==='list') return listMarkup(d,buckets,val);
    return tableMarkup(d,buckets,all,val);
  }
  function layoutSize(d,available) {return {width:Math.max(d.minWidthRem*remPx(),Math.min(d.cardWidthRem*remPx(),available)),height:Math.max(d.minHeightRem,d.cardHeightRem)*remPx()};}
  function renderCards() {
    $('metric-count').textContent=`· ${saved.length}`;
    const available=Math.max(180,$('cards').clientWidth-32);
    $('cards').innerHTML=saved.length?saved.map(d=>{const {width,height}=layoutSize(d,available);return `<button class="metric-card" data-edit="${escape(d.id)}" style="flex-basis:max(${d.minWidthRem}rem,min(${d.cardWidthRem}rem,${available}px));min-width:${d.minWidthRem}rem;height:${Math.max(d.cardHeightRem,d.minHeightRem)}rem"><strong>${escape(d.name)}</strong><div class="card-body">${cardContent(d,width,height)}</div></button>`;}).join(''):'<button id="empty-create">+ Create metric</button>';
    requestAnimationFrame(()=>{$('cards').querySelectorAll('.metric-card').forEach(el=>{const d=saved.find(x=>x.id===el.dataset.edit);if(d)el.querySelector('.card-body').innerHTML=cardContent(d,el.clientWidth,el.clientHeight);});});
    if(dashboardMode) renderDashboard();
  }
  function renderDashboard() {
    loadLayoutControls();
    document.querySelectorAll('[data-canvas]').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.canvas)===canvasWidth)));
    $('dashboard-canvas').style.width=canvasWidth+'px';
    const available=canvasWidth-24;
    $('dashboard-cards').innerHTML=drafts.map(d=>{const {width,height}=layoutSize(d,available);return `<article class="dashboard-card" tabindex="0" aria-label="Select ${escape(d.name)}" data-card-select="${escape(d.id)}" data-order-id="${escape(d.id)}" aria-current="${d.id===active}" style="flex-basis:max(${d.minWidthRem}rem,min(${d.cardWidthRem}rem,${available}px));min-width:${d.minWidthRem}rem;height:${Math.max(d.cardHeightRem,d.minHeightRem)}rem;max-width:none"><div class="card-heading"><button class="metric-handle" draggable="true" data-drag-id="${escape(d.id)}" aria-label="Reorder ${escape(d.name)}" title="Drag; Alt + arrows moves">⠿</button><button class="card-title" data-card-edit="${escape(d.id)}">${escape(d.name)}</button><button class="menu-trigger" data-menu-id="${escape(d.id)}" aria-label="Actions for ${escape(d.name)}" aria-haspopup="menu">⋯</button></div><div class="card-body">${cardContent(d,width,height)}</div></article>`;}).join('');
    $('layout-note').textContent=drafts.some(d=>d.minWidthRem*remPx()>available)?'A card minimum exceeds this canvas. Scroll horizontally or reduce its minimum width; card content is not squeezed below the minimum.':'Cards wrap in saved order and share remaining row space. Tables scroll within cards; chart labels adapt to the available area.';
    for(const d of drafts) {
      if(cache.get(d.id)?.signature===signature(d)||dashboardJobs.has(d.id)||dashboardJobs.size>=2)continue;
      const sig=signature(d),job=new Worker('metric-playground.worker.js');dashboardJobs.set(d.id,job);
      const timeout=setTimeout(()=>finish({error:'Dashboard preview exceeded its 3-second budget.'}),3000);
      const finish=result=>{clearTimeout(timeout);job.terminate();dashboardJobs.delete(d.id);const live=drafts.find(x=>x.id===d.id);if(live&&signature(live)===sig){cache.set(d.id,{signature:sig,result});valid.set(d.id,!result.error);}renderCards();if(!$('backdrop').hidden&&dashboardMode)renderLibrary();};
      job.onmessage=e=>finish(e.data);job.onerror=e=>finish({error:e.message});job.postMessage(clone(d));
    }
    // Flex grow determines each chart's final width. Repaint SVG from that width.
    requestAnimationFrame(()=>{$('dashboard-cards').querySelectorAll('.dashboard-card').forEach(el=>{const d=drafts.find(x=>x.id===el.dataset.orderId);if(d){el.querySelector('.card-body').innerHTML=cardContent(d,el.clientWidth,el.clientHeight);}});});
  }
  function sizePreview() {
    resizing=true;
    $('preview-card').style.width=previewWidth+'px';$('preview-card').style.height=previewHeight+'px';
    $('preview-width').value=previewWidth;$('preview-height').value=previewHeight;
    requestAnimationFrame(()=>{resizing=false;});
  }
  function viewDashboard(on) {
    dashboardMode=on;$('workspace').dataset.view=on?'dashboard':'editor';$('dashboard').hidden=!on;
    $('workbench-view').value=on?'dashboard':'editor';
    if(on) renderDashboard();else {previewForId=null;loadDefinition();}workbench?.syncMode();
  }
  function reorder(id,target) {
    const from=drafts.findIndex(d=>d.id===id),to=drafts.findIndex(d=>d.id===target);if(from<0||to<0||from===to)return;
    const [d]=drafts.splice(from,1);drafts.splice(to,0,d);renderLibrary();
    $('layout-status').textContent=`Moved ${d.name} to position ${to+1} of ${drafts.length}.`;
  }
  function refreshSummaries() {
    const d=current();if(!d)return;
    $('scope-summary').textContent=d.scope==='allMatching'?'All matching rows':'Shown rows';
    $('group-summary').textContent=d.groupBy.length?d.groupBy.map(g=>names[g]).join(' × '):'One value';
    $('order-section').hidden=!d.groupBy.length;
    $('order-summary').textContent=d.display==='line'?'Chronological':`${d.sortKey==='value'?'Value':d.sortKey==='y'?'Y value':d.sortKey==='samples'?'Samples':d.sortKey==='count'?'Rows':names[d.groupBy[Number(d.sortKey.slice(5))]]} ${d.dir==='asc'?'↑':'↓'} · first ${d.groupLimit}`;
    const kinds={table:d.groupBy.length===2?'X/Y table':'Table',list:'List','bar-horizontal':'Horizontal bars','bar-vertical':'Vertical bars',line:'Line chart',pie:'Pie chart',donut:'Donut chart',scatter:'Scatterplot',box:'Box & whisker',histogram:'Histogram'};
    $('display-summary').textContent=`${d.groupBy.length||isDistribution(d)?kinds[d.display]:'Value'} · ${d.display==='scatter'?'X / Y':d.format}`;
    $('labels-summary').textContent=[d.valueLabel,d.xLabel,d.yLabel].some(Boolean)?'Custom':'Automatic';
    $('size-summary').textContent=`${d.cardWidthRem} × ${d.cardHeightRem} rem · min ${d.minWidthRem} × ${d.minHeightRem} rem`;
  }
  function installExpressionLibrary() {
    const tools=window.metricExpressionTools;
    const aggregates=[{name:'SUM',signature:'SUM(row expression)',description:'Total numeric values per group.'},{name:'COUNT',signature:'COUNT(expression?)',description:'Count rows, or non-null values per group.'},{name:'AVG',signature:'AVG(row expression)',description:'Average numeric values per group.'},{name:'MIN',signature:'MIN(row expression)',description:'Minimum value per group.'},{name:'MAX',signature:'MAX(row expression)',description:'Maximum value per group.'}];
    const allowed=new Set(['IF','NULLIF','COALESCE','IS_NULL','ABS','REGEX_TEST']);
    const functions=[...aggregates.map(f=>({...f,concept:'aggregate'})),...tools.functions.filter(f=>allowed.has(f.name)).map(f=>({...f,concept:'row'}))];
    let libraryTab='functions';
    const fieldDefs=[{name:'useful_ms',label:'Useful ms',type:'Number'},{name:'total_ms',label:'Total ms',type:'Number'},{name:'job_name',label:'Job name',type:'Text'},...Object.entries(names).map(([name,label])=>({name,label,type:name==='day'?'Date/time':'Text'}))];
    const render=()=>{
      const query=$('function-search').value.toLowerCase(),concept=$('function-concept').value;
      $('function-list').innerHTML=functions.filter(f=>(!isDistribution(current())||f.concept!=='aggregate')&&(concept==='all'||f.concept===concept)&&`${f.name} ${f.description}`.toLowerCase().includes(query)).map(f=>`<button data-function="${f.name}"><strong>${escape(f.name)}</strong><code>${escape(f.signature)}</code><small>${escape(f.description)}</small></button>`).join('')||'<p class="help">No matching functions.</p>';
      $('field-list').innerHTML=fieldDefs.filter(f=>`${f.name} ${f.label} ${f.type}`.toLowerCase().includes(query)).map(f=>`<button data-insert="[${f.name}]"><strong>${escape(f.label)}</strong><code>[${escape(f.name)}]</code><small>${escape(f.type)}</small></button>`).join('')||'<p class="help">No matching fields.</p>';
    };
    $('function-search').oninput=render;$('function-concept').onchange=render;
    $('reference-view').onchange=()=>{
      libraryTab=$('reference-view').value;const fields=libraryTab==='fields';
      $('field-list').hidden=!fields;$('function-list').hidden=fields;$('concept-control').hidden=fields;
      $('reference-search-label').textContent=fields?'Search fields':'Search functions';$('function-search').value='';render();
    };
    const insert=(text,wrap=false)=>{
      const input=expressionInput(),from=input.selectionStart,to=input.selectionEnd,selected=input.value.slice(from,to);
      input.setRangeText(wrap?`${text}(${selected})`:text,from,to,'end');
      if(wrap)input.setSelectionRange(from+text.length+1+selected.length,from+text.length+1+selected.length);
      current().mode='formula';$('formula-controls').hidden=false;$('basic-controls').hidden=true;
      $('formula-mode').setAttribute('aria-pressed','true');$('basic-mode').setAttribute('aria-pressed','false');
      input.dispatchEvent(new Event('input'));input.focus();
    };
    $('function-list').onmousedown=$('field-list').onmousedown=e=>e.preventDefault();
    $('function-list').onclick=e=>{const b=e.target.closest('[data-function]');if(b)insert(b.dataset.function,true);};
    $('field-list').onclick=e=>{const b=e.target.closest('[data-insert]');if(b)insert(b.dataset.insert);};
    $('function-search').onkeydown=e=>{if(e.isComposing)return;const root=$(libraryTab==='fields'?'field-list':'function-list'),buttons=[...root.querySelectorAll('button')];if(!buttons.length)return;if(e.key==='Enter'){e.preventDefault();buttons[0].click();}if(e.key==='ArrowDown'){e.preventDefault();buttons[0].focus();}};
    render();
  }
  function open(id = saved[0]?.id) {
    previousFocus = document.activeElement; drafts = clone(saved); active = id;
    $('app').inert = true; document.querySelector('.prototype').inert = true;
    $('backdrop').hidden = false; document.body.style.overflow = 'hidden';
    $('workspace').dataset.panel = 'definition';
    viewDashboard(false); $('modal').focus();
  }
  function close() {
    workbench?.cancel();cancelWorker(); for(const job of dashboardJobs.values())job.terminate();dashboardJobs.clear();$('metric-menu').hidden=true; $('backdrop').hidden = true; $('discard').hidden = true;
    $('app').inert = false; document.querySelector('.prototype').inert = false; document.body.style.overflow = '';
    previousFocus?.focus(); renderCards();
  }
  function attemptClose() { if (dirty()) { $('discard').hidden = false; $('keep-editing').focus(); } else close(); }
  $('open-modal').onclick = () => open();
  $('cards').onclick = e => { const button=e.target.closest('[data-edit]'); if(button) open(button.dataset.edit); if(e.target.id === 'empty-create') { open(); $('add-metric').click(); } };
  $('close-modal').onclick = $('cancel').onclick = attemptClose;
  $('keep-editing').onclick = () => { $('discard').hidden = true; $('cancel').focus(); };
  $('discard-changes').onclick = close;
  $('backdrop').onclick = e => { if(e.target === $('backdrop')) attemptClose(); };
  $('apply').onclick = () => { if(drafts.some(d => !valid.get(d.id) || !d.name.trim())) return; saved=clone(drafts); const persisted=persist();close(); $('toast').textContent=`Applied ${saved.length} metrics. The table query and page are unchanged.${persisted?' Saved for refresh.':' Browser storage is unavailable; refresh will restore the demo.'}`; };
  $('library-items').onclick = e => { const b=e.target.closest('[data-id]'); if(b) { active=b.dataset.id; inspection=0; loadDefinition(); } };
  $('name').oninput = e => update({ name:e.target.value },false);
  for(const id of ['formula','formula-y'])$(id).addEventListener('focus',()=>{expressionTarget=id;});
  $('formula-y').oninput=e=>update({sourceY:e.target.value});
  $('x-format').onchange=e=>setOutputKind(e.target.value,'x');$('y-format').onchange=e=>setOutputKind(e.target.value,'y');
  $('formula').oninput = e => { if(isDistribution(current())){update({rowSource:e.target.value,mode:'formula'});return;} current().mode='formula'; update({ source:e.target.value }); const simple=/^(COUNT|SUM|AVG|MIN|MAX)\((?:\[[^\]]+\])?\)$/i.test(e.target.value); $('basic-mode').disabled=!simple; };
  $('scope-all').onclick = () => { update({ scope:'allMatching' }); loadDefinition(); };
  $('scope-shown').onclick = () => { update({ scope:'shownRows' }); loadDefinition(); };
  $('groupings').onchange=e=>{if(e.target.matches('[data-group-index]')) {const list=[...current().groupBy];list[Number(e.target.dataset.groupIndex)]=e.target.value;setGroups(list);}};
  $('groupings').onclick=e=>{const remove=e.target.closest('[data-group-remove]'),up=e.target.closest('[data-group-up]');const list=[...current().groupBy];if(remove){list.splice(Number(remove.dataset.groupRemove),1);setGroups(list);}if(up){const i=Number(up.dataset.groupUp);[list[i],list[i-1]]=[list[i-1],list[i]];setGroups(list);}};
  $('add-group').onclick=()=>{const key=Object.keys(names).find(k=>!current().groupBy.includes(k));if(key)setGroups([...current().groupBy,key]);};
  $('swap-axes').onclick=()=>update({pivotSwap:!current().pivotSwap},false);$('row-order').onchange=e=>update({rowDir:e.target.value},false);$('column-order').onchange=e=>update({columnDir:e.target.value},false);
  $('sort-key').onchange = e => update({ sortKey:e.target.value },false);
  $('sort-dir').onchange = e => update({ dir:e.target.value },false);
  $('display').onchange = e => {
    const d=current(),before=d.display,display=e.target.value;
    const rowSource=d.rowSource||d.source.match(/^(?:SUM|AVG|MIN|MAX)\((.*)\)$/i)?.[1]||'[total_ms]';
    update({display,...(['box','histogram'].includes(display)?{rowSource,mode:'formula',format:['number','percent','duration'].includes(d.format)?d.format:'number'}:{}),...(display==='scatter'?{sourceY:d.sourceY||'COUNT()',xFormat:d.xFormat||d.format,yFormat:d.yFormat||'number',mode:'formula'}:{})},display==='scatter'||before==='scatter'||['box','histogram'].includes(display)||['box','histogram'].includes(before));loadDefinition();
  };
  $('box-whiskers').onchange=e=>update({boxWhiskers:e.target.value});
  $('box-mean').onchange=e=>update({boxMean:e.target.checked},false);
  $('histogram-bins').onchange=e=>{const n=Number(e.target.value);if(Number.isInteger(n)&&n>=2&&n<=30)update({histogramBins:n});else e.target.value=current().histogramBins??10;};
  $('legend-position').onchange=e=>update({legendPosition:e.target.value},false);
  for(const [id,key] of [['list-bars','listBars'],['list-colors','listColors'],['list-values','listValues']])$(id).onchange=e=>update({[key]:e.target.checked},false);
  $('format').onchange=e=>setOutputKind(e.target.value);
  $('format-target').onchange=e=>{outputAxis=e.target.value;refreshOutputControls();};
  $('output-unit').onchange=e=>setOutput({sourceUnit:e.target.value});
  $('output-style').onchange=e=>setOutput({style:e.target.value,pattern:current().outputFormats?.[outputAxis]?.pattern??window.metricOutput.defaultPattern($('format').value)});
  $('output-pattern').oninput=e=>setOutput({pattern:e.target.value});
  $('output-timezone').oninput=e=>setOutput({timeZone:e.target.value});
  $('decimals').onchange = e => update({ decimals:Number(e.target.value) },false);
  $('nulls').onchange = e => update({ nulls:e.target.value },false);
  $('group-limit').onchange = e => { const n=Number(e.target.value); if(Number.isInteger(n) && n>=1 && n<=1000) update({ groupLimit:n },false); else e.target.value=current().groupLimit; };
  $('basic-mode').onclick = () => { current().mode='basic'; loadDefinition(); };
  $('formula-mode').onclick = () => { current().mode='formula'; loadDefinition(); };
  function basicChange() { const op=$('basic-op').value, field=$('basic-field').value; update({ source:`${op}(${field ? `[${field}]` : ''})` }); }
  $('basic-op').onchange = $('basic-field').onchange = basicChange;
  $('add-metric').onclick = () => { if(drafts.length>=20) return; const d={...clone(initial[1]), id:crypto.randomUUID(), name:'New metric'}; drafts.push(d); valid.set(d.id,true); active=d.id; loadDefinition(); };
  $('duplicate').onclick = () => { if(drafts.length>=20) return; const d={...clone(current()), id:crypto.randomUUID(), name:`${current().name} copy`}; drafts.push(d); valid.set(d.id,valid.get(active)); active=d.id; loadDefinition(); };
  $('remove').onclick = () => { drafts=drafts.filter(d=>d.id!==active); active=drafts[0]?.id; loadDefinition(); };
  function move(delta) { const i=drafts.findIndex(d=>d.id===active); if(i+delta<0 || i+delta>=drafts.length) return; reorder(active,drafts[i+delta].id); }
  $('move-up').onclick=()=>move(-1); $('move-down').onclick=()=>move(1);
  $('result').onclick = e => {
    if(e.target.closest('[data-use-shown]')) { $('scope-shown').click(); return; }
    if(e.target.closest('[data-display-table]')) { update({display:'table'},false); loadDefinition(); return; }
    const header=e.target.closest('[data-sort]');
    if(header) { const key=header.dataset.sort; update({ sortKey:key, dir:current().sortKey===key && current().dir==='asc'?'desc':'asc' },false); $('sort-key').value=key; $('sort-dir').value=current().dir; return; }
    const bucket=e.target.closest('[data-bucket]'); if(bucket) { inspection=Number(bucket.dataset.bucket);$('inspect').open=true; renderPreview(); }
  };
  $('result').onkeydown = e => { if((e.key==='Enter'||e.key===' ') && e.target.matches('[data-bucket]')) { e.preventDefault(); e.target.click(); } };
  window.addEventListener('resize',()=>{renderCards();if(!$('backdrop').hidden)renderPreview();});
  $('scenario').onchange = e => { const key=e.target.value; if($('backdrop').hidden) open('share'); else { active='share'; } update({ source:examples[key], mode:'formula', scope:key==='regex'?'shownRows':'allMatching', groupBy:[key==='trend'?'day':'platform'], format:['regex','pie'].includes(key)?'number':'percent', display:key==='trend'?'line':key==='pie'?'pie':'table', name:key==='trend'?'Useful-time trend':key==='pie'?'Run distribution':'Useful-time share' }); loadDefinition(); };
  $('workbench-view').onchange=e=>viewDashboard(e.target.value==='dashboard');
  $('canvas-width').onchange=e=>{canvasWidth=Math.max(320,Math.min(1600,Number(e.target.value)||1000));e.target.value=canvasWidth;renderDashboard();};
  document.querySelectorAll('[data-canvas]').forEach(b=>b.onclick=()=>{canvasWidth=Number(b.dataset.canvas);$('canvas-width').value=canvasWidth;renderDashboard();});
  for(const [id,key] of Object.entries({'value-label':'valueLabel','x-label':'xLabel','y-label':'yLabel'})) $(id).oninput=e=>update({[key]:e.target.value},false);
  function changeSize(input,key) {
    const n=Number(input.value);
    if(!Number.isFinite(n)||n<Number(input.min)||n>Number(input.max)||!Number.isInteger(n)){input.value=current()[key];return;}
    if(n===current()[key])return;
    const patch={[key]:n};
    if(key==='minWidthRem'&&n>current().cardWidthRem)patch.cardWidthRem=n;
    if(key==='minHeightRem'&&n>current().cardHeightRem)patch.cardHeightRem=n;
    if(key==='cardWidthRem')patch.cardWidthRem=Math.max(n,current().minWidthRem);
    if(key==='cardHeightRem')patch.cardHeightRem=Math.max(n,current().minHeightRem);
    update(patch,false);
    for(const [id,field] of Object.entries({'card-width':'cardWidthRem','card-height':'cardHeightRem','min-width':'minWidthRem','min-height':'minHeightRem'}))$(id).value=current()[field];
    previewWidth=Math.max(current().cardWidthRem,current().minWidthRem)*remPx();previewHeight=Math.max(current().cardHeightRem,current().minHeightRem)*remPx();
    sizePreview();if(!dashboardMode)renderPreview();
  }
  function loadLayoutControls() {
    const select=$('layout-metric'),options=drafts.map(d=>`<option value="${escape(d.id)}">${escape(d.name)}</option>`).join('');
    if(select.innerHTML!==options)select.innerHTML=options;select.value=active||'';
    for(const [id,key] of Object.entries({'layout-width':'cardWidthRem','layout-height':'cardHeightRem','layout-min-width':'minWidthRem','layout-min-height':'minHeightRem'})){$(id).disabled=!current();$(id).value=current()?.[key]??'';}
    $('layout-name').disabled=!current();if($('layout-name').value!==(current()?.name||''))$('layout-name').value=current()?.name||'';
    $('layout-edit').disabled=!current();
  }
  $('layout-metric').onchange=e=>{active=e.target.value;renderLibrary();};
  $('layout-name').oninput=e=>update({name:e.target.value},false);
  $('edit-metric').onclick=$('layout-edit').onclick=()=>{viewDashboard(false);$('name').focus();};
  for(const [id,key] of Object.entries({'card-width':'cardWidthRem','card-height':'cardHeightRem','min-width':'minWidthRem','min-height':'minHeightRem','layout-width':'cardWidthRem','layout-height':'cardHeightRem','layout-min-width':'minWidthRem','layout-min-height':'minHeightRem'}))$(id).onchange=e=>changeSize(e.target,key);
  for(const [id,key] of [['preview-width','width'],['preview-height','height']]) $(id).onchange=e=>{const n=Math.max(Number(e.target.min),Math.min(Number(e.target.max),Number(e.target.value)||200));if(key==='width')previewWidth=n;else previewHeight=n;sizePreview();renderPreview();};
  $('reset-preview').onclick=()=>{previewWidth=Math.max(current().cardWidthRem,current().minWidthRem)*remPx();previewHeight=Math.max(current().cardHeightRem,current().minHeightRem)*remPx();sizePreview();renderPreview();};
  new ResizeObserver(entries=>{if(resizing||$('backdrop').hidden||dashboardMode||!$('preview-card').getClientRects().length)return;const el=entries[0].target;const w=Math.round(el.offsetWidth),h=Math.round(el.offsetHeight);if(w===previewWidth&&h===previewHeight)return;previewWidth=w;previewHeight=h;$('preview-width').value=w;$('preview-height').value=h;renderPreview();}).observe($('preview-card'));
  document.addEventListener('click',e=>{const menu=e.target.closest('[data-menu-id]');if(menu){const rect=menu.getBoundingClientRect();active=menu.dataset.menuId;if(!dashboardMode)loadDefinition();else renderLibrary();$('metric-menu').hidden=false;$('metric-menu').style.left=Math.min(rect.left,innerWidth-165)+'px';$('metric-menu').style.top=Math.min(rect.bottom,innerHeight-215)+'px';$('edit-metric').focus();return;}
    if(e.target.closest('#metric-menu')){$('metric-menu').hidden=true;if(e.target.id!=='edit-metric')[...document.querySelectorAll(`[data-menu-id="${active}"]`)].find(el=>el.getClientRects().length)?.focus();}else $('metric-menu').hidden=true;
    const card=e.target.closest('[data-card-select]');
    if(card && (!e.target.closest('button,a,input,select,textarea,summary') || e.target.closest('[data-card-edit]'))){active=card.dataset.cardSelect;renderLibrary();}

  });
  // One delegated tooltip works across live preview and freshly rendered dashboard cards.
  const tooltip=document.createElement('div');tooltip.id='metric-tooltip';tooltip.role='tooltip';tooltip.hidden=true;document.body.append(tooltip);
  let tooltipMark=null;
  function hideTooltip(){tooltip.hidden=true;tooltipMark?.removeAttribute('aria-describedby');tooltipMark=null;}
  function placeTooltip(x,y){const box=tooltip.getBoundingClientRect();tooltip.style.left=Math.max(8,Math.min(x+12,innerWidth-box.width-8))+'px';tooltip.style.top=Math.max(8,Math.min(y+12,innerHeight-box.height-8))+'px';}
  function showTooltip(target,x,y){const mark=target.closest('[data-bucket],[data-tooltip]');if(!mark)return hideTooltip();const label=mark.dataset.tooltip||mark.querySelector('title')?.textContent;if(!label)return hideTooltip();if(tooltipMark!==mark)hideTooltip();tooltipMark=mark;mark.setAttribute('aria-describedby','metric-tooltip');tooltip.textContent=label;tooltip.hidden=false;placeTooltip(x,y);}
  document.addEventListener('pointerover',e=>showTooltip(e.target,e.clientX,e.clientY));
  document.addEventListener('pointermove',e=>{if(tooltipMark){if(!tooltipMark.isConnected)hideTooltip();else placeTooltip(e.clientX,e.clientY);}});
  document.addEventListener('pointerout',e=>{if(tooltipMark&&!tooltipMark.contains(e.relatedTarget))hideTooltip();});
  document.addEventListener('focusin',e=>{const rect=e.target.getBoundingClientRect();showTooltip(e.target,rect.left+rect.width/2,rect.bottom);});
  document.addEventListener('focusout',hideTooltip);document.addEventListener('scroll',hideTooltip,true);
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!tooltip.hidden){e.preventDefault();hideTooltip();}});
  document.addEventListener('dragstart',e=>{const handle=e.target.closest('[data-drag-id]');if(!handle)return;draggedId=handle.dataset.dragId;e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',draggedId);});
  document.addEventListener('dragover',e=>{const target=e.target.closest('[data-order-id]');if(target&&draggedId){e.preventDefault();e.dataTransfer.dropEffect='move';document.querySelectorAll('.drop-target').forEach(el=>el.classList.remove('drop-target'));target.classList.add('drop-target');}});
  document.addEventListener('drop',e=>{const target=e.target.closest('[data-order-id]');if(target&&draggedId){e.preventDefault();reorder(draggedId,target.dataset.orderId);}draggedId=null;});
  document.addEventListener('dragend',()=>{draggedId=null;document.querySelectorAll('.drop-target').forEach(el=>el.classList.remove('drop-target'));});
  // Pointer fallback for touch, using the same stable-id reorder operation.
  let touchDrag=null;
  document.addEventListener('pointerdown',e=>{const handle=e.target.closest('[data-drag-id]');if(handle&&e.pointerType!=='mouse'){touchDrag=handle.dataset.dragId;handle.setPointerCapture(e.pointerId);e.preventDefault();}});
  document.addEventListener('pointermove',e=>{if(!touchDrag)return;const target=document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-order-id]');document.querySelectorAll('.drop-target').forEach(el=>el.classList.remove('drop-target'));target?.classList.add('drop-target');});
  document.addEventListener('pointerup',e=>{if(!touchDrag)return;const target=document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-order-id]');if(target)reorder(touchDrag,target.dataset.orderId);touchDrag=null;document.querySelectorAll('.drop-target').forEach(el=>el.classList.remove('drop-target'));});
  document.addEventListener('pointercancel',()=>{touchDrag=null;document.querySelectorAll('.drop-target').forEach(el=>el.classList.remove('drop-target'));});
  document.addEventListener('keydown',e=>{if(e.target.matches('[data-card-select]')&&['Enter',' '].includes(e.key)){e.preventDefault();active=e.target.dataset.cardSelect;renderLibrary();document.querySelector(`[data-card-select="${active}"]`)?.focus();}
    const handle=e.target.closest('[data-drag-id]');if(handle&&e.altKey&&['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();const id=handle.dataset.dragId,index=drafts.findIndex(d=>d.id===id),next=index+(['ArrowUp','ArrowLeft'].includes(e.key)?-1:1);if(drafts[next])reorder(id,drafts[next].id);document.querySelector(`[data-drag-id="${id}"]`)?.focus();}
    if(!$('metric-menu').hidden){const buttons=[...$('metric-menu').querySelectorAll('button:not(:disabled)')];if(e.key==='Tab'){e.preventDefault();buttons[(buttons.indexOf(document.activeElement)+(e.shiftKey?buttons.length-1:1))%buttons.length]?.focus();e.stopImmediatePropagation();}if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();buttons[(buttons.indexOf(document.activeElement)+(e.key==='ArrowDown'?1:buttons.length-1))%buttons.length]?.focus();}if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();$('metric-menu').hidden=true;[...document.querySelectorAll(`[data-menu-id="${active}"]`)].find(el=>el.getClientRects().length)?.focus();}}
  });
  installExpressionLibrary();
  document.addEventListener('keydown',e => {
    if($('backdrop').hidden || e.defaultPrevented) return;
    if(e.key==='Escape') { e.preventDefault(); if(!$('discard').hidden) $('keep-editing').click(); else attemptClose(); }
    if((e.metaKey||e.ctrlKey)&&e.key==='Enter') { e.preventDefault(); requestPreview(); }
    if(e.key==='Tab') {
      const root=$('discard').hidden?$('modal'):$('discard');
      const targets=[...root.querySelectorAll('button:not(:disabled),input,select,textarea,[tabindex="0"]')].filter(el=>el.getClientRects().length);
      const first=targets[0],last=targets.at(-1);
      if(e.shiftKey && (document.activeElement===first || document.activeElement===$('modal'))) { e.preventDefault(); last?.focus(); }
      if(!e.shiftKey && (document.activeElement===last || document.activeElement===$('modal'))) { e.preventDefault(); first?.focus(); }
    }
  });
  window.addEventListener('metric-theme-change',()=>{renderCards();if(!dashboardMode)renderPreview();});
  workbench=window.metricWorkbench.create({onResize:()=>{if(dashboardMode)renderDashboard();else renderPreview();}});
  {
    const demo=(base,patch)=>({...clone(initial[base]),...patch});
    saved=[
      demo(1,{name:'Matching runs',cardWidthRem:14,minWidthRem:12,cardHeightRem:10,valueLabel:'Runs in scope'}),
      demo(0,{id:'pass',name:'Pass rate',source:examples.pass,groupBy:[],cardWidthRem:14,minWidthRem:12,cardHeightRem:10,valueLabel:'Successful runs'}),
      demo(0,{name:'Build efficiency',display:'bar-horizontal',valueLabel:'Useful share',xLabel:'Useful time / total time',cardWidthRem:24,minWidthRem:18}),
      demo(1,{id:'volume',name:'Run volume',groupBy:['platform'],display:'bar-vertical',cardWidthRem:21,minWidthRem:16,xLabel:'Platform'}),
      demo(0,{id:'trend',name:'Efficiency over time',groupBy:['day'],display:'line',xLabel:'Day (UTC)',yLabel:'Useful share',cardWidthRem:28,minWidthRem:19,cardHeightRem:14}),
      demo(1,{id:'distribution',name:'Runs by platform',groupBy:['platform'],display:'pie',cardWidthRem:21,minWidthRem:16,cardHeightRem:14}),
      demo(1,{id:'outcomes',name:'Pass / fail share',groupBy:['overall'],display:'donut',cardWidthRem:20,minWidthRem:16}),
      demo(0,{id:'scatter',name:'Duration vs efficiency',source:'AVG([total_ms])',sourceY:examples.ratio,groupBy:['platform','worker'],display:'scatter',format:'number',xFormat:'number',yFormat:'percent',decimals:1,sortKey:'group0',dir:'asc',groupLimit:100,cardWidthRem:28,minWidthRem:20,cardHeightRem:16,xLabel:'Average duration (ms)',yLabel:'Useful share'}),
      demo(1,{id:'worker-list',name:'Worker leaderboard',groupBy:['worker'],display:'list',valueLabel:'Runs',cardWidthRem:17,minWidthRem:14}),
      demo(1,{id:'pivot',name:'Platform × worker',groupBy:['platform','worker'],groupLimit:100,cardWidthRem:28,minWidthRem:19,cardHeightRem:15,valueLabel:'Runs'}),
      demo(0,{id:'lost',name:'Unproductive time',source:'(SUM([useful_ms]) - SUM([total_ms])) / 1000',display:'bar-horizontal',format:'number',xLabel:'Useful − total (seconds)',cardWidthRem:25,minWidthRem:18}),
      demo(1,{id:'tuples',name:'Platform / worker / outcome',groupBy:['platform','worker','overall'],groupLimit:100,cardWidthRem:31,minWidthRem:20,cardHeightRem:15,valueLabel:'Runs'}),
      demo(1,{id:'build-page',name:'Build jobs on this page',source:examples.regex,scope:'shownRows',groupBy:['platform'],display:'bar-vertical',cardWidthRem:19,minWidthRem:15,xLabel:'Platform'}),
      demo(1,{id:'elapsed',name:'Elapsed example',source:'COUNT() * 0 + 84000',mode:'formula',format:'duration',outputFormats:{value:{sourceUnit:'seconds',style:'human'}},cardWidthRem:18,cardHeightRem:10,valueLabel:'Duration from seconds'}),
      demo(1,{id:'first-date',name:'First run date',source:'MIN([day])',mode:'formula',format:'date',outputFormats:{value:{sourceUnit:'iso',style:'human',timeZone:'UTC'}},cardWidthRem:22,cardHeightRem:10}),
      demo(1,{id:'start-time',name:'Start time example',source:'COUNT() * 0 + 52200',mode:'formula',format:'time',outputFormats:{value:{sourceUnit:'secondsOfDay',style:'human'}},cardWidthRem:18,cardHeightRem:10}),
      demo(1,{id:'duration-box',name:'Run duration spread',display:'box',rowSource:'[total_ms]',groupBy:['platform'],mode:'formula',format:'duration',outputFormats:{value:{sourceUnit:'milliseconds',style:'human'}},boxWhiskers:'minmax',sortKey:'group0',dir:'asc',cardWidthRem:30,minWidthRem:22,cardHeightRem:16,xLabel:'Run duration'}),
      demo(1,{id:'duration-histogram',name:'Run duration histogram',display:'histogram',rowSource:'[total_ms]',groupBy:['overall'],mode:'formula',format:'duration',outputFormats:{value:{sourceUnit:'milliseconds',style:'human'}},histogramBins:10,legendPosition:'bottom',cardWidthRem:30,minWidthRem:22,cardHeightRem:16,xLabel:'Run duration',yLabel:'Runs'})
    ];
    const storageKey='qt-metric-playground-v6';
    try {const cached=JSON.parse(localStorage.getItem(storageKey));if(cached?.version===6 && Array.isArray(cached.metrics) && cached.metrics.length<=20 && cached.metrics.every(d=>typeof d.id==='string'&&typeof d.name==='string'&&typeof d.source==='string'&&Array.isArray(d.groupBy)&&d.groupBy.every(g=>Object.hasOwn(names,g))&&['cardWidthRem','cardHeightRem','minWidthRem','minHeightRem'].every(k=>Number.isFinite(d[k])&&d[k]>=1&&d[k]<=75)))saved=cached.metrics;}catch{}
    persist=()=>{try{localStorage.setItem(storageKey,JSON.stringify({version:6,metrics:saved}));return true;}catch{return false;}};
    saved.forEach(d=>{
      for(const k of ['cardWidthRem','cardHeightRem','minWidthRem','minHeightRem'])d[k]=Math.ceil(d[k]);
      d.cardWidthRem=Math.max(d.cardWidthRem,d.minWidthRem);d.cardHeightRem=Math.max(d.cardHeightRem,d.minHeightRem);
    });
    drafts=clone(saved);drafts.forEach(d=>valid.set(d.id,true));active=saved.find(d=>d.id==='share')?.id||saved[0]?.id;canvasWidth=1120;$('canvas-width').value=1120;
    const entryView=new URLSearchParams(location.search).get('view');
    renderCards();renderDashboard();
    if(entryView!=='overview'){open(active);viewDashboard(entryView!=='editor');}
  }
})();
