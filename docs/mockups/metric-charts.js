/* Design-only SVG renderers. Same reduced buckets as the table; no fetches. */
(() => {
  const color=(field,value)=>window.metricColors.category(field,value);
  const token=name=>window.metricColors.token(name);
  const additive = source => /^(COUNT\((?:\[[^\]]+\])?\)|SUM\(\[[^\]]+\]\))$/i.test(source.trim());
  function reason(spec,buckets) {
    if(!['bar-horizontal','bar-vertical','line','pie','donut','scatter','box','histogram'].includes(spec.display)) return '';
    if(['date','time','datetime'].includes(spec.format)&&spec.display!=='scatter')return 'Calendar outputs work in a value, table or list. Use a duration for elapsed-time bars.';
    if(['box','histogram'].includes(spec.display)) {
      if(spec.display==='histogram'&&spec.groupBy.length>1)return 'Histogram comparisons use at most one grouping key. Box plots support full group tuples.';
      return '';
    }
    if(spec.display==='scatter') {
      if(!spec.groupBy.length) return 'Scatterplots need a group key: one point per group tuple.';
      if(!spec.sourceY?.trim()) return 'Add a Y expression for the scatterplot.';
      if(buckets.some(b=>(b.value!==null&&typeof b.value!=='number')||(b.y!==null&&typeof b.y!=='number'))) return 'Both scatter expressions must return numeric values.';
      return '';
    }
    if(spec.groupBy.length!==1) return 'Charts in this release need one group key. Use Table for a tuple of keys.';
    if(buckets.some(b=>b.value!==null && typeof b.value!=='number')) return 'This chart needs a numeric result. Use Table for text or boolean values.';
    if(spec.display==='line' && spec.groupBy[0]!=='day') return 'Line charts need a time or numeric axis. Choose Day (UTC) to show a trend.';
    if(['pie','donut'].includes(spec.display)) {
      if(!additive(spec.source)) return 'Pie charts need additive counts or sums. Ratios and averages work better as bars.';
      if(buckets.some(b=>b.error || (b.value!==null && (!Number.isFinite(b.value) || b.value<0)))) return 'Pie charts need finite, nonnegative quantities without group errors.';
    }
    return '';
  }
  function legendLayout(spec,width,height) {
    const position=['left','right','top','bottom','none'].includes(spec.legendPosition)?spec.legendPosition:'right';
    const side=position==='left'||position==='right',size=position==='none'?0:side?Math.min(100,width*.32):Math.min(48,height*.28);
    return {position,size,width:width-(side?size+8:0),height:height-(!side&&size?size+8:0),outerHeight:height};
  }
  function withLegend(svg,layout,entries,escape) {
    const legend=layout.position==='none'?'':`<div class="chart-legend" aria-label="Legend">${entries.map(e=>`<div class="legend-entry" title="${escape(e.description||e.label)}"><i style="background:${escape(e.color)}"></i><span class="legend-name">${escape(e.label)}</span>${e.share?`<span class="legend-share">${escape(e.share)}</span>`:''}</div>`).join('')}</div>`;
    const chart=`<div class="result chart-frame" style="height:${layout.height}px">${svg}</div>`;
    return `<div class="chart-layout legend-${layout.position}" style="height:${layout.outerHeight}px;--legend-size:${layout.size}px">${['left','top'].includes(layout.position)?legend+chart:chart+legend}</div>`;
  }
  function render(spec,visible,all,format,escape) {
    const problem=reason(spec,all);
    if(problem) return { html:`<div class="error-box"><strong>Choose a compatible display</strong><p>${escape(problem)}</p><button data-display-table>Use table</button></div>`,note:'Calculation is unchanged; adjust presentation.',reason:problem };
    if(['box','histogram'].includes(spec.display))return distributionChart(spec,visible,all,format,escape);
    if(spec.display==='scatter')return scatter(spec,visible,all,escape);
    const title=escape(spec.name), layout=legendLayout(spec,Math.max(158,spec.renderWidth||298),Math.max(70,spec.renderHeight||148));
    const round=['pie','donut'].includes(spec.display),W=round?layout.width:Math.max(158,spec.renderWidth||298),H=round?layout.height:Math.max(70,spec.renderHeight||148);
    const fullVisible=visible;
    if(spec.display==='bar-horizontal') visible=visible.slice(0,Math.max(1,Math.floor((H-48)/14)));
    const valueLabel=spec.valueLabel || spec.name;
    const keyLabel=spec.groupBy[0]==='day'?'Day (UTC)':spec.groupBy[0];
    const xLabel=spec.xLabel || (spec.display==='bar-horizontal'?valueLabel:keyLabel);
    const yLabel=spec.yLabel || (spec.display==='bar-horizontal'?keyLabel:valueLabel);
    const start=(height=H)=>`<svg class="metric-chart" viewBox="0 0 ${W} ${height}" role="img" aria-label="${title}" style="display:block;width:100%;height:100%;background:${escape(token('surface'))};font:11px -apple-system,BlinkMacSystemFont,sans-serif;color:${escape(token('text'))}"><title>${title}</title>`;
    const text=(x,y,label,anchor='start',fill=token('muted'))=>`<text x="${x}" y="${y}" text-anchor="${anchor}" fill="${escape(fill)}">${escape(String(label).length>Math.floor(W/7)?String(label).slice(0,Math.max(3,Math.floor(W/7)-1))+'…':label)}<title>${escape(label)}</title></text>`;
    const line=(x1,y1,x2,y2)=>`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${escape(token('grid'))}"/>`;
    const short=value=>{const label=spec.groupBy[0]==='day'?new Date(value).toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'}):String(value); return label.length>15?label.slice(0,13)+'…':label;};
    const nums=visible.map(b=>b.value).filter(v=>typeof v==='number' && Number.isFinite(v));
    if(!nums.length) return {html:'<div class="scalar muted">No numeric values to chart. Inspect NULL/error groups in View data.</div>',note:'No values were converted to zero.'};
    let svg=start(), note='',legendEntries=[];
    if(['pie','donut'].includes(spec.display)) {
      const positive=all.filter(b=>typeof b.value==='number' && b.value>0), total=positive.reduce((s,b)=>s+b.value,0);
      if(total===0) return {html:'<div class="scalar muted">No positive quantities to show as slices.</div>',note:'All groups are zero or NULL.'};
      const chosen=visible.filter(b=>typeof b.value==='number' && b.value>0).slice(0,8);
      const remainder=total-chosen.reduce((s,b)=>s+b.value,0);
      const slices=chosen.map(b=>({b,label:String(b.keys[0]??'NULL'),index:visible.indexOf(b),value:b.value,color:color(spec.groupBy[0],b.keys[0])}));
      if(remainder>1e-8) slices.push({label:'Other groups',index:-1,value:remainder,color:token('other')});
      legendEntries=slices.map(s=>({label:s.label,color:s.color,share:`${(s.value/total*100).toFixed(1)}%`,description:`${s.label}: ${format(s.value)} · ${(s.value/total*100).toFixed(1)}%`}));
      let angle=-Math.PI/2; const cx=W/2,cy=Math.max(18,(H-18)/2),r=Math.max(10,Math.min(W/2-8,(H-22)/2));
      slices.forEach((s,i)=>{
        const next=angle+s.value/total*Math.PI*2, x1=cx+r*Math.cos(angle),y1=cy+r*Math.sin(angle),x2=cx+r*Math.cos(next),y2=cy+r*Math.sin(next);
        const description=`${s.label}: ${format(s.value)} · ${(s.value/total*100).toFixed(1)}% of scoped quantity`;
        const attrs=`${s.index>=0?`data-bucket="${s.index}" role="button"`:`data-tooltip="${escape(description)}"`} tabindex="0" aria-label="${escape(description)}"`;
        svg+=s.value===total?`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${escape(s.color)}" ${attrs}><title>${escape(description)}</title></circle>`:`<path d="M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${next-angle>Math.PI?1:0} 1 ${x2} ${y2} Z" fill="${escape(s.color)}" ${attrs}><title>${escape(description)}</title></path>`;
        angle=next;
      });
      if(spec.display==='donut') svg+=`<circle cx="${cx}" cy="${cy}" r="${r*.62}" fill="${escape(token('surface'))}" pointer-events="none"/>`;
      svg+=text(cx,H-4,`${format(total)} total`,'middle',token('text'));
      note=`Shares use all ${all.length} groups. ${remainder>1e-8?'Other includes excluded groups; the denominator is unchanged.':'All positive quantities are represented.'}`;
    } else {
      const min=Math.min(0,...nums), max=Math.max(0,...nums), span=max-min || 1;
      if(spec.display==='bar-horizontal') {
        const left=65,right=W-48,top=12,bottom=H-37;
        const x=v=>left+(v-min)/span*(right-left), spacing=(bottom-top)/visible.length;
        const tickCount=right-left<100?1:2;
        for(let t=0;t<=tickCount;t++){const value=min+span*t/tickCount;svg+=line(x(value),top-8,x(value),bottom+4)+text(x(value),H-21,format(value),'middle');}
        visible.forEach((b,i)=>{
          const y=top+i*spacing+spacing/2; svg+=text(left-10,y+4,short(b.keys[0]),'end');
          if(typeof b.value==='number' && !b.error){const xx=Math.min(x(0),x(b.value)),width=Math.abs(x(b.value)-x(0));svg+=`<rect x="${xx}" y="${y-6}" width="${width}" height="12" rx="2" fill="${escape(color(spec.groupBy[0],b.keys[0]))}" data-bucket="${i}" role="button" tabindex="0" aria-label="Inspect ${escape(b.keys[0])}: ${escape(format(b.value))}"><title>${escape(b.keys.join(' / ')+': '+format(b.value))}</title></rect>`+text(right+12,y+4,format(b.value),'start',token('text'));}
          else svg+=text(right+12,y+4,b.error?'Error':'—');
        });
      } else {
        const left=48,right=W-16,top=10,bottom=H-37, y=v=>bottom-(v-min)/span*(bottom-top);
        const tickCount=bottom-top<60?1:2;
        for(let t=0;t<=tickCount;t++){const value=min+span*t/tickCount;svg+=line(left,y(value),right,y(value))+text(left-8,y(value)+4,format(value),'end');}
        if(spec.display==='bar-vertical') {
          const step=(right-left)/visible.length;
          visible.forEach((b,i)=>{
            const x=left+step*(i+.5), width=Math.min(36,step*.6);
            if(step>=45 || i%Math.max(1,Math.ceil(45/step))===0) svg+=text(x,H-21,short(b.keys[0]),'middle');
            if(typeof b.value==='number' && !b.error) svg+=`<rect x="${x-width/2}" y="${Math.min(y(0),y(b.value))}" width="${width}" height="${Math.abs(y(b.value)-y(0))}" rx="2" fill="${escape(color(spec.groupBy[0],b.keys[0]))}" data-bucket="${i}" role="button" tabindex="0" aria-label="Inspect ${escape(b.keys[0])}: ${escape(format(b.value))}"><title>${escape(b.keys.join(' / ')+': '+format(b.value))}</title></rect>`;
          });
        } else {
          const times=visible.map(b=>new Date(b.keys[0]).getTime()), tmin=Math.min(...times), tmax=Math.max(...times), x=t=>left+(t-tmin)/(tmax-tmin||1)*(right-left);
          let path='',open=false;
          visible.forEach((b,i)=>{
            if(typeof b.value==='number' && !b.error){path+=`${open?' L':' M'} ${x(times[i])} ${y(b.value)}`;open=true;} else open=false;
            if(i%Math.max(1,Math.ceil(visible.length/4))===0 || i===visible.length-1) svg+=text(x(times[i]),H-21,short(b.keys[0]),'middle');
          });
          svg+=`<path d="${path}" fill="none" stroke="${escape(token('accent'))}" stroke-width="2"/>`;
          visible.forEach((b,i)=>{if(typeof b.value==='number' && !b.error) svg+=`<circle cx="${x(times[i])}" cy="${y(b.value)}" r="4" fill="${escape(token('accent'))}"/><circle cx="${x(times[i])}" cy="${y(b.value)}" r="14" fill="transparent" data-bucket="${i}" role="button" tabindex="0" aria-label="Inspect ${escape(short(b.keys[0]))}: ${escape(format(b.value))}"><title>${escape(b.keys.join(' / ')+': '+format(b.value))}</title></circle>`;});
          note='Complete series · chronological axis · missing/null results break the line.';
        }
      }
      if(!note) note='Zero-based scale · same group results as the table · select a mark to inspect.';
    }
    if(!['pie','donut'].includes(spec.display)) { svg+=text(W/2,H-3,xLabel,'middle'); if(spec.yLabel) svg+=`<text transform="translate(10 ${H/2}) rotate(-90)" text-anchor="middle" fill="${escape(token('muted'))}">${escape(yLabel.length>Math.floor(H/7)?yLabel.slice(0,Math.max(3,Math.floor(H/7)-1))+'…':yLabel)}<title>${escape(yLabel)}</title></text>`; }
    if(fullVisible.length>visible.length) note+=` Showing ${visible.length} of ${fullVisible.length} ranked groups at this size; View data retains the rest.`;
    svg+='</svg>';
    const table=`<details class="chart-data"><summary>View data</summary><table><thead><tr><th>Group</th><th class="num">${escape(spec.valueLabel || "Value")}</th><th class="num">Rows</th></tr></thead><tbody>${fullVisible.map((b,i)=>`<tr data-bucket="${i}" tabindex="0"><td>${escape(short(b.keys[0]))}</td><td class="num">${escape(b.error?'Error':format(b.value))}</td><td class="num">${b.count.toLocaleString()}</td></tr>`).join('')}</tbody></table></details>`;
    return {html:(round?withLegend(svg,layout,legendEntries,escape):`<div class="result chart-frame" style="height:${H}px">${svg}</div>`)+table,note};
  }
  function scatter(spec,visible,all,escape) {
    const layout=legendLayout(spec,Math.max(200,spec.renderWidth||360),Math.max(125,spec.renderHeight||180)),W=layout.width,H=layout.height;
    const valid=b=>!b.error&&!b.yError&&typeof b.value==='number'&&Number.isFinite(b.value)&&typeof b.y==='number'&&Number.isFinite(b.y);
    const points=visible.filter(valid),skipped=visible.length-points.length,omitted=all.length-visible.length;
    const fmt=(v,axis)=>window.metricOutput.format(v,window.metricOutput.spec(spec,axis));
    const xLabel=spec.xLabel||'X value',yLabel=spec.yLabel||'Y value';
    const coverage=`${points.length} points · ${skipped} missing/error pairs${omitted?` · ${omitted} outside limit`:''}`;
    const note=`${coverage}. One point per full group tuple; axes share the same scoped rows. Independent numeric scales; no fit line.`;
    const data=`<details class="chart-data"><summary>View data</summary><table><thead><tr><th>Group</th><th>${escape(xLabel)}</th><th>${escape(yLabel)}</th></tr></thead><tbody>${visible.map((b,i)=>`<tr data-bucket="${i}" tabindex="0"><td>${escape(b.keys.join(' / '))}</td><td>${escape(b.error||fmt(b.value,'x'))}</td><td>${escape(b.yError||fmt(b.y,'y'))}</td></tr>`).join('')}</tbody></table></details>`;
    if(!points.length)return {html:`<div class="scalar muted">No complete numeric pairs.<div class="small">${escape(coverage)}</div></div>${data}`,note};
    const extent=values=>{let min=Math.min(...values),max=Math.max(...values);const pad=(max-min||Math.abs(max)||1)*.08;return [min-pad,max+pad];};
    const [xmin,xmax]=extent(points.map(b=>b.value)),[ymin,ymax]=extent(points.map(b=>b.y));
    const left=Math.min(65,W*.3),right=W-12,top=12,bottom=Math.max(35,H-40);
    const x=v=>left+(v-xmin)/(xmax-xmin)*(right-left),y=v=>bottom-(v-ymin)/(ymax-ymin)*(bottom-top);
    const text=(xx,yy,label,anchor='middle')=>`<text x="${xx}" y="${yy}" text-anchor="${anchor}" fill="${escape(token('muted'))}">${escape(label)}</text>`;
    let svg=`<svg class="metric-chart scatter-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escape(spec.name)}" style="display:block;width:100%;height:100%;font:10px -apple-system,BlinkMacSystemFont,sans-serif"><title>${escape(spec.name+': '+note)}</title>`;
    for(let i=0;i<=2;i++){const xv=xmin+(xmax-xmin)*i/2,yv=ymin+(ymax-ymin)*i/2;svg+=`<path d="M ${x(xv)} ${top} V ${bottom} M ${left} ${y(yv)} H ${right}" fill="none" stroke="${escape(token('grid'))}"/>`+text(x(xv),bottom+14,fmt(xv,'x'),i===0?'start':i===2?'end':'middle')+text(left-6,y(yv)+3,fmt(yv,'y'),'end');}
    points.forEach(b=>{const index=visible.indexOf(b),label=`${b.keys.join(' / ')}: ${xLabel} ${fmt(b.value,'x')}; ${yLabel} ${fmt(b.y,'y')}`;svg+=`<circle cx="${x(b.value)}" cy="${y(b.y)}" r="4" fill="${escape(color(spec.groupBy[0],b.keys[0]))}" opacity=".8"/><circle cx="${x(b.value)}" cy="${y(b.y)}" r="10" fill="transparent" data-bucket="${index}" tabindex="0" role="button" aria-label="Inspect ${escape(label)}"><title>${escape(label)}</title></circle>`;});
    const trim=(label,max)=>label.length>max?label.slice(0,max-1)+'…':label;
    svg+=text((left+right)/2,H-17,trim(xLabel,Math.floor(W/6)))+`<text transform="translate(10 ${(top+bottom)/2}) rotate(-90)" text-anchor="middle" fill="${escape(token('muted'))}">${escape(trim(yLabel,Math.max(5,Math.floor((bottom-top)/6))))}<title>${escape(yLabel)}</title></text>`+'</svg>';
    const categories=[...new Map(visible.map(b=>[window.metricColors.typed(b.keys[0]),b.keys[0]])).values()];
    const legendEntries=categories.map(key=>({label:String(key??'NULL'),color:color(spec.groupBy[0],key),description:`${spec.groupBy[0]}: ${key??'NULL'}`}));
    return {html:withLegend(svg,layout,legendEntries,escape)+data,note};
  }
  function distributionChart(spec,visible,all,format,escape) {
    const isBox=spec.display==='box',outerWidth=Math.max(180,spec.renderWidth||360),outerHeight=Math.max(110,spec.renderHeight||200);
    const layout=legendLayout({...spec,legendPosition:isBox?'none':spec.legendPosition||'bottom'},outerWidth,outerHeight),W=layout.width,H=layout.height;
    const label=b=>b.keys.length?b.keys.join(' / '):'All rows',shade=b=>b.keys.length?color(spec.groupBy[0],b.keys[0]):token('accent');
    const summaries=visible.filter(b=>!b.error&&(isBox?b.distribution?.summary:b.distribution?.n>0));
    const detail=b=>{const d=b.distribution,s=d?.summary;return b.error||(!s?'No numeric samples':`${label(b)}\nMin ${format(s.min)} · Q1 ${format(s.q1)}\nMedian ${format(s.median)} · Q3 ${format(s.q3)}\nMax ${format(s.max)} · Mean ${format(s.mean)}\nWhiskers ${format(s.low)} – ${format(s.high)}\n${s.n.toLocaleString()} samples · ${b.nullCount||0} NULL · ${s.outlierCount} outliers${s.outlierCount>s.outliers.length?' (20 markers shown)':''}`);};
    const table=isBox?`<details class="chart-data"><summary>View data</summary><table><thead><tr><th>Group</th>${['Min','Q1','Median','Q3','Max','Mean','Samples','NULL','Outliers'].map(t=>`<th>${t}</th>`).join('')}</tr></thead><tbody>${visible.map((b,i)=>{const s=b.distribution?.summary;return `<tr data-bucket="${i}" tabindex="0" data-tooltip="${escape(detail(b))}"><td>${escape(label(b))}</td>${['min','q1','median','q3','max','mean'].map(k=>`<td>${escape(b.error?'Error':s?format(s[k]):'—')}</td>`).join('')}<td>${s?.n??0}</td><td>${b.nullCount||0}</td><td>${s?.outlierCount??0}</td></tr>`;}).join('')}</tbody></table></details>`:`<details class="chart-data"><summary>View data</summary><table><thead><tr><th>Group</th><th>Samples</th><th>Status</th></tr></thead><tbody>${visible.map(b=>`<tr><td>${escape(label(b))}</td><td>${b.distribution?.n??0}</td><td>${escape(b.error||'No numeric samples')}</td></tr>`).join('')}</tbody></table></details>`;
    if(!summaries.length)return {html:`<div class="scalar muted">No numeric samples to summarize. NULL/error groups remain in View data.</div>${table}`,note:'Empty distributions never become zero.'};
    const left=Math.min(80,W*.26),right=W-12,top=12,bottom=H-35;
    const text=(x,y,value,anchor='middle')=>`<text x="${x}" y="${y}" text-anchor="${anchor}" fill="${escape(token('muted'))}">${escape(value)}</text>`;
    const line=(x1,y1,x2,y2,stroke=token('grid'),width=1)=>`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${escape(stroke)}" stroke-width="${width}"/>`;
    let svg=`<svg class="metric-chart distribution-chart ${isBox?'box-chart':'histogram-chart'}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escape(spec.name)}" style="display:block;width:100%;height:100%;font:10px -apple-system,BlinkMacSystemFont,sans-serif"><title>${escape(spec.name)}</title>`,note='',data=table;
    if(isBox){
      const fitting=visible.slice(0,Math.max(1,Math.floor((bottom-top)/23))),stats=summaries.map(b=>b.distribution.summary);
      let min=Math.min(...stats.map(s=>s.min)),max=Math.max(...stats.map(s=>s.max));
      if(min===max){const pad=Math.abs(min)*.05||1;min-=pad;max+=pad;}
      const x=v=>left+((v-min)/(max-min))*(right-left),step=(bottom-top)/fitting.length;
      for(let i=0;i<=2;i++){const v=min+(max-min)*i/2;svg+=line(x(v),top,x(v),bottom)+text(x(v),H-20,format(v),i===0?'start':i===2?'end':'middle');}
      fitting.forEach((b,i)=>{
        const s=b.distribution?.summary,cy=top+step*(i+.5),full=label(b),limit=Math.max(4,Math.floor(left/6)-2),short=full.length>limit?full.slice(0,limit-1)+'…':full;
        svg+=`<text x="${left-8}" y="${cy+3}" text-anchor="end" fill="${escape(token('muted'))}">${escape(short)}<title>${escape(full)}</title></text>`;
        if(!s||b.error){svg+=text((left+right)/2,cy+3,b.error?'Error':'No samples');return;}
        const c=shade(b);svg+=line(x(s.low),cy,x(s.high),cy,c,2)+line(x(s.low),cy-5,x(s.low),cy+5,c,2)+line(x(s.high),cy-5,x(s.high),cy+5,c,2);
        svg+=`<rect x="${x(s.q1)}" y="${cy-7}" width="${Math.max(1,x(s.q3)-x(s.q1))}" height="14" fill="${escape(c)}" fill-opacity=".22" stroke="${escape(c)}"/>`+line(x(s.median),cy-7,x(s.median),cy+7,c,2);
        if(spec.boxMean!==false)svg+=`<circle class="mean-marker" cx="${x(s.mean)}" cy="${cy}" r="3" fill="${escape(token('surface'))}" stroke="${escape(c)}" stroke-width="1.5"/>`;
        svg+=`<rect x="${left}" y="${cy-10}" width="${right-left}" height="20" fill="transparent" data-bucket="${visible.indexOf(b)}" data-tooltip="${escape(detail(b))}" tabindex="0" role="button" aria-label="${escape(detail(b))}"/>`;
        s.outliers.forEach(v=>{const tip=`${full}: outlier ${format(v)}\n${s.outlierCount} outliers total${s.outlierCount>s.outliers.length?' · 20 markers shown':''}`;svg+=`<circle cx="${x(v)}" cy="${cy}" r="2.5" fill="${escape(c)}"/><circle cx="${x(v)}" cy="${cy}" r="6" fill="transparent" data-tooltip="${escape(tip)}" tabindex="0" aria-label="${escape(tip)}"/>`;});
      });
      svg+=text((left+right)/2,H-4,spec.xLabel||spec.valueLabel||'Value');
      note=`Exact linearly interpolated quartiles · ${spec.boxWhiskers==='tukey'?'whiskers end at observations within 1.5 × IQR; outliers separate':'whiskers show minimum and maximum'}. ${fitting.length} of ${all.length} groups fit at this size; View data retains ranked groups.`;
    }else{
      const edges=summaries[0].distribution.edges,binCount=edges.length-1,series=summaries.slice(0,6),peak=Math.max(1,...series.flatMap(b=>b.distribution.counts));
      const histLeft=Math.min(40,W*.2),histBottom=H-35,span=right-histLeft,step=span/binCount,y=v=>histBottom-(v/peak)*(histBottom-top);
      for(const v of new Set([0,Math.round(peak/2),peak]))svg+=line(histLeft,y(v),right,y(v))+text(histLeft-5,y(v)+3,v.toLocaleString(),'end');
      const viewRows=[];
      series.forEach((b,j)=>b.distribution.counts.forEach((count,i)=>{
        const x=histLeft+step*i+j*step/series.length,width=Math.max(.5,step/series.length-1),tip=`${label(b)}\n${format(edges[i])} ≤ value ${i===binCount-1?'≤':'<'} ${format(edges[i+1])}\n${count.toLocaleString()} rows · ${b.distribution.n.toLocaleString()} numeric samples · ${b.nullCount||0} NULL`;
        svg+=`<rect x="${x}" y="${y(count)}" width="${width}" height="${histBottom-y(count)}" fill="${escape(shade(b))}"/>`;
        svg+=`<rect x="${x}" y="${Math.min(y(count),histBottom-5)}" width="${width+1}" height="${Math.max(5,histBottom-y(count))}" fill="transparent" data-bucket="${visible.indexOf(b)}" data-tooltip="${escape(tip)}" tabindex="0" role="button" aria-label="${escape(tip)}"/>`;
      }));
      [0,Math.floor(binCount/2),binCount].forEach((i,j)=>{svg+=text(histLeft+span*i/binCount,H-20,format(edges[i]),j===0?'start':j===2?'end':'middle');});
      svg+=text((histLeft+right)/2,H-4,spec.xLabel||spec.valueLabel||'Value');
      if(spec.yLabel)svg+=`<text transform="translate(9 ${(top+histBottom)/2}) rotate(-90)" text-anchor="middle" fill="${escape(token('muted'))}">${escape(spec.yLabel)}</text>`;
      visible.forEach(b=>{if(b.error||!b.distribution?.n)viewRows.push(`<tr><td>${escape(label(b))}</td><td colspan="2">${escape(b.error||'No numeric samples')}</td></tr>`);else b.distribution.counts.forEach((count,i)=>viewRows.push(`<tr tabindex="0"><td>${escape(label(b))}</td><td>${escape(format(edges[i]))} – ${escape(format(edges[i+1]))}${i===binCount-1?' (upper inclusive)':''}</td><td>${count}</td></tr>`));});
      data=`<details class="chart-data"><summary>View data</summary><table><thead><tr><th>Group</th><th>Range</th><th>Rows</th></tr></thead><tbody>${viewRows.join('')}</tbody></table></details>`;
      const entries=series.map(b=>({label:label(b),color:shade(b)}));svg+='</svg>';
      note=`${binCount} shared equal-width bins · final upper bound included · count per bin. ${series.length} of ${all.length} groups drawn; View data retains ranked groups. Bin edges use all scoped numeric values.`;
      return {html:withLegend(svg,layout,entries,escape)+data,note};
    }
    svg+='</svg>';return {html:`<div class="result chart-frame" style="height:${H}px">${svg}</div>${data}`,note};
  }

  window.metricCharts={render,reason,additive};
})();
