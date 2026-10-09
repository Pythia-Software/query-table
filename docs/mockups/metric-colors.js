/* Prototype of a caller-owned, per-table metric theme. No runtime dependencies.
 * Inject window.metricTheme before this script, or call metricColors.setTheme(). */
(() => {
  const defaults={
    layers:[
      {id:'categorical',colors:['#0969da','#8250df','#1a7f37','#bf8700','#bc4c00','#cf4b8c']},
      {id:'workers',colors:['#007c91','#598234','#b36200','#7e5bef']},
      {id:'outcomes',colors:['var(--qt-pass-fg, #1a7f37)','var(--qt-fail-fg, #d1242f)']}
    ],
    dimensions:{
      platform:{layer:'categorical',domain:['linux','macos','windows','android','freebsd']},
      worker:{layer:'workers',domain:['worker-1','worker-2','worker-3','worker-4']},
      overall:{layer:'outcomes',domain:['PASS','FAIL']}
    },
    tokens:{accent:'var(--qt-accent, #0969da)',text:'var(--qt-text, #1f2328)',muted:'var(--qt-muted, #656d76)',grid:'var(--qt-border-subtle, #eaeef2)',surface:'var(--qt-metric-surface, #fff)',other:'var(--qt-metric-other, #8c959f)',null:'var(--qt-muted, #656d76)',error:'var(--qt-fail-fg, #d1242f)'}
  };
  let theme;
  const typed=value=>JSON.stringify([value===null?'null':typeof value,value]);
  const hash=value=>{let h=2166136261;for(const c of value){h^=c.codePointAt(0);h=Math.imul(h,16777619);}return h>>>0;};
  const validColor=(value,fallback)=>typeof value==='string'&&CSS.supports('color',value)?value:fallback;
  function configure(config={}) {
    const layers=Array.isArray(config.layers)?config.layers.filter(l=>typeof l.id==='string'&&Array.isArray(l.colors)&&l.colors.length).map(l=>({id:l.id,colors:l.colors.map(c=>validColor(c,defaults.tokens.accent))})):defaults.layers;
    theme={layers:layers.length?layers:defaults.layers,dimensions:{...defaults.dimensions,...config.dimensions},tokens:{...defaults.tokens}};
    for(const key of Object.keys(theme.tokens))theme.tokens[key]=validColor(config.tokens?.[key],theme.tokens[key]);
  }
  function category(field,value) {
    if(value===null)return theme.tokens.null;
    const dimension=theme.dimensions[field],layer=theme.layers.find(l=>l.id===dimension?.layer)||theme.layers[hash(field)%theme.layers.length];
    const override=dimension?.overrides?.find(o=>typed(o.value)===typed(value));
    if(override)return validColor(override.color,theme.tokens.accent);
    const index=dimension?.domain?.findIndex(v=>typed(v)===typed(value))??-1;
    // Hash fallback does not depend on observed order, rank, result page or scope.
    return layer.colors[(index>=0?index:hash(field+'\0'+typed(value)))%layer.colors.length];
  }
  configure(window.metricTheme);
  window.metricColors={category,token:name=>theme.tokens[name]||theme.tokens.accent,typed,
    setTheme:config=>{configure(config);window.dispatchEvent(new Event('metric-theme-change'));}};
})();
