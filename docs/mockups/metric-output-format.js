/* Design-only output presentation. Uses native Intl; raw values never change. */
(() => {
  const temporal=new Set(['duration','date','time','datetime']);
  const durationUnits={milliseconds:1,seconds:1000,minutes:60000,hours:3600000,days:86400000};
  const units=kind=>kind==='duration'?Object.keys(durationUnits).map(value=>({value,label:value[0].toUpperCase()+value.slice(1)})):[
    {value:'iso',label:kind==='time'?'ISO time / timestamp':kind==='date'?'ISO date / timestamp':'ISO timestamp'},
    {value:'epochSeconds',label:'Unix seconds'}, {value:'epochMilliseconds',label:'Unix milliseconds'},
    ...(kind==='time'?[{value:'secondsOfDay',label:'Seconds since midnight'},{value:'millisecondsOfDay',label:'Milliseconds since midnight'}]:[])
  ];
  const styles=kind=>kind==='duration'?[{value:'human',label:'Human readable · 23h20m'},{value:'long',label:'Long · 23 hours, 20 minutes'},{value:'clock',label:'Clock · 23:20:00'},{value:'custom',label:'Custom format string'}]:[
    {value:'human',label:kind==='date'?'Readable · Oct 8, 2026':kind==='time'?'24-hour · 14:30:00':'Readable date & time'},
    {value:'iso',label:kind==='date'?'ISO · 2026-10-08':kind==='time'?'12-hour · 2:30:00 PM':'ISO-style date & time'},
    {value:'custom',label:'Custom format string'}
  ];
  const defaultPattern=kind=>kind==='duration'?'{h}h {m}m':kind==='date'?'YYYY-MM-DD':kind==='time'?'HH:mm:ss':'YYYY-MM-DD HH:mm:ss Z';
  const spec=(d,axis='value')=>({format:axis==='value'?d.format:d[axis+'Format']||'number',decimals:d.decimals??1,...d.outputFormats?.[axis]});
  const number=value=>{if(typeof value==='number'&&Number.isFinite(value))return value;if(typeof value==='string'&&/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())){const n=Number(value);if(Number.isFinite(n))return n;}throw Error('Expected a finite number in the selected source unit.');};
  const zone=spec=>spec.timeZone==='local'?Intl.DateTimeFormat().resolvedOptions().timeZone:spec.timeZone||'UTC';
  const pad=(n,width=2)=>String(n).padStart(width,'0');
  function validate(s) {
    if(!temporal.has(s.format))return '';
    if(!styles(s.format).some(style=>style.value===(s.style||'human')))return 'Choose a supported label format.';
    if(!units(s.format).some(u=>u.value===(s.sourceUnit||(s.format==='duration'?'milliseconds':'iso'))))return 'Choose a supported source unit.';
    if(s.format!=='duration'){try{new Intl.DateTimeFormat('en-US',{timeZone:zone(s)});}catch{return 'Enter a valid IANA timezone, such as America/Denver.';}}
    if(s.style==='custom'){
      const pattern=s.pattern??'';if(!pattern.trim())return 'Enter a format string.';if(pattern.length>160)return 'Format strings are limited to 160 characters.';
      if(s.format==='duration'){
        const rest=pattern.replace(/\{(?:d|h|hh|m|mm|s|ss|ms)\}/g,'');
        if(/[{}]/.test(rest))return 'Duration tokens: {d}, {h}, {hh}, {m}, {mm}, {s}, {ss}, {ms}.';
        if(rest===pattern)return 'Include at least one duration token.';
      }else{
        if(/[\[\]]/.test(pattern.replace(/\[[^\]]*\]/g,'')))return 'Close each [literal] section.';
        const tokens=pattern.match(/\[[^\]]*\]|YYYY|MMMM|MMM|MM|DD|ddd|HH|hh|mm|ss|SSS|A|Z|[A-Za-z]+/g)||[];
        if(tokens.some(t=>!t.startsWith('[')&&!['YYYY','MMMM','MMM','MM','DD','ddd','HH','hh','mm','ss','SSS','A','Z'].includes(t)))return 'Use supported date/time tokens; wrap literal words in [brackets].';
        if(!tokens.some(t=>!t.startsWith('[')))return 'Include at least one date/time token.';
      }
    }
    return '';
  }
  function duration(value,s) {
    const ms=number(value)*durationUnits[s.sourceUnit||'milliseconds'];
    if(!Number.isFinite(ms)||Math.abs(ms)>Number.MAX_SAFE_INTEGER)throw Error('Duration exceeds safe millisecond precision.');
    const sign=ms<0?'−':'',abs=Math.abs(ms),rounded=Math.round(abs),seconds=Math.floor(rounded/1000);
    const days=Math.floor(seconds/86400),totalHours=Math.floor(seconds/3600);
    const displayHours=s.style==='custom'&&s.pattern?.includes('{d}')?totalHours%24:totalHours;
    const parts={d:days,h:displayHours,hh:pad(displayHours),m:Math.floor(seconds/60)%60,mm:pad(Math.floor(seconds/60)%60),s:seconds%60,ss:pad(seconds%60),ms:pad(rounded%1000,3)};
    if(s.style==='custom')return sign+s.pattern.replace(/\{(d|hh|h|mm|m|ss|s|ms)\}/g,(_,k)=>String(parts[k]));
    if(s.style==='clock')return `${sign}${pad(totalHours)}:${parts.mm}:${parts.ss}${rounded%1000?'.'+parts.ms:''}`;
    const fmt=n=>n.toLocaleString('en-US',{maximumFractionDigits:3});
    if(abs<1000)return `${sign}${abs>0&&abs<.001?'<0.001':fmt(abs)}${s.style==='long'?(abs===1?' millisecond':' milliseconds'):'ms'}`;
    if(abs<60000){const sec=Math.round(abs)/1000;if(sec<60)return `${sign}${fmt(sec)}${s.style==='long'?(sec===1?' second':' seconds'):'s'}`;}
    // Round before decomposing so 59.9999s -> 1m, never 60s or 1m60s.
    const sec=Math.round(abs/1000),values=[Math.floor(sec/86400),Math.floor(sec/3600)%24,Math.floor(sec/60)%60,sec%60],short=['d','h','m','s'],long=['day','hour','minute','second'];
    const rendered=values.map((v,i)=>v?{v,i}:null).filter(Boolean).slice(0,2).map(({v,i})=>s.style==='long'?`${v} ${long[i]}${v===1?'':'s'}`:`${v}${short[i]}`);
    return sign+rendered.join(s.style==='long'?', ':'');
  }
  function validCalendar(year,month,day){if(year<1||year>9999)return false;const d=new Date(0);d.setUTCFullYear(year,month-1,day);d.setUTCHours(0,0,0,0);return d.getUTCFullYear()===year&&d.getUTCMonth()===month-1&&d.getUTCDate()===day;}
  function instant(value,s) {
    const unit=s.sourceUnit||'iso';let ms,timeOnly=false,dateOnly=false;
    if(unit==='epochSeconds'||unit==='epochMilliseconds')ms=number(value)*(unit==='epochSeconds'?1000:1);
    else if(unit==='secondsOfDay'||unit==='millisecondsOfDay'){
      ms=number(value)*(unit==='secondsOfDay'?1000:1);if(ms<0||ms>=86400000)throw Error('Time of day must be between midnight and the next midnight.');timeOnly=true;
    }else{
      if(typeof value!=='string')throw Error('Expected an ISO string. Choose Unix units for numeric timestamps.');
      const date=value.match(/^(\d{4})-(\d{2})-(\d{2})$/),clock=value.match(/^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
      const stamp=value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/);
      const calendar=date||stamp;
      if(calendar&&!validCalendar(+calendar[1],+calendar[2],+calendar[3]))throw Error('Invalid calendar date.');
      if(date){if(s.format==='time')throw Error('A date without a time cannot be displayed as Time.');ms=Date.parse(value+'T00:00:00Z');dateOnly=true;}
      else if(clock&&s.format==='time'){const h=+clock[1],m=+clock[2],sec=+(clock[3]||0);if(h>23||m>59||sec>59)throw Error('Invalid clock time.');ms=((h*60+m)*60+sec)*1000+Number((clock[4]||'').padEnd(3,'0'));timeOnly=true;}
      else if(stamp){if(+stamp[4]>23||+stamp[5]>59||+stamp[6]>59)throw Error('Invalid timestamp time.');ms=Date.parse(value);}
      else throw Error('Use ISO dates, clock times, or timestamps with an explicit timezone; ambiguous text is not guessed.');
    }
    if(!Number.isFinite(ms)||Math.abs(ms)>8640000000000000)throw Error('Timestamp is outside the supported date range.');
    const date=new Date(ms);if(date.getUTCFullYear()<1||date.getUTCFullYear()>9999)throw Error('Calendar output supports years 0001 through 9999.');
    return {date,timeZone:timeOnly||dateOnly?'UTC':zone(s),timeOnly,dateOnly};
  }
  function calendar(value,s) {
    const parsed=instant(value,s),{date,timeZone}=parsed;
    const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date).map(p=>[p.type,p.value]));
    if(s.style==='custom'||s.style==='iso'&&s.format!=='time'){
      const month=length=>new Intl.DateTimeFormat('en-US',{timeZone,month:length}).format(date);
      const tz=new Intl.DateTimeFormat('en-US',{timeZone,timeZoneName:'shortOffset'}).formatToParts(date).find(p=>p.type==='timeZoneName').value;
      const offset=tz.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/),zoneOffset=offset?offset[1]+pad(offset[2])+':'+(offset[3]||'00'):'+00:00';
      const parts={YYYY:p.year.padStart(4,'0'),MM:p.month,DD:p.day,HH:p.hour,hh:pad(+p.hour%12||12),mm:p.minute,ss:p.second,SSS:pad(date.getUTCMilliseconds(),3),MMM:month('short'),MMMM:month('long'),ddd:new Intl.DateTimeFormat('en-US',{timeZone,weekday:'short'}).format(date),A:+p.hour<12?'AM':'PM',Z:zoneOffset};
      return (s.style==='custom'?s.pattern:defaultPattern(s.format)).replace(/\[[^\]]*\]|YYYY|MMMM|MMM|MM|DD|ddd|HH|hh|mm|ss|SSS|A|Z/g,t=>t.startsWith('[')?t.slice(1,-1):parts[t]);
    }
    const options=s.format==='date'?{year:'numeric',month:'short',day:'numeric'}:s.format==='time'?{hour:'2-digit',minute:'2-digit',second:'2-digit',...(s.style==='iso'?{hour12:true}:{hourCycle:'h23'})}:{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',timeZoneName:'short'};
    return new Intl.DateTimeFormat('en-US',{...options,timeZone}).format(date);
  }
  function result(value,s) {
    if(value===null||value===undefined)return {text:'—'};
    try{
      const problem=validate(s);if(problem)throw Error(problem);
      if(s.format==='duration')return {text:duration(value,s)};
      if(['date','time','datetime'].includes(s.format))return {text:calendar(value,s)};
      if(typeof value!=='number')return {text:String(value)};
      if(!Number.isFinite(value))throw Error('Expected a finite result.');
      return {text:(s.format==='percent'?value*100:value).toLocaleString('en-US',{minimumFractionDigits:s.decimals??1,maximumFractionDigits:s.decimals??1})+(s.format==='percent'?'%':'')};
    }catch(error){return {text:'Invalid format',error:error.message,raw:value};}
  }
  window.metricOutput={spec,units,styles,defaultPattern,validate,result,format:(value,s)=>result(value,s).text,isTemporal:kind=>temporal.has(kind)};
})();
