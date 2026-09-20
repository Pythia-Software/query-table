import { createContext, useContext, useState, type ReactNode } from 'react';

/** Consumer-owned presentation; canonical values remain in queries and URLs. */
export interface FilterValuePresentation {
  label?: (field: string, value: string) => string;
  render?: (field: string, value: string) => ReactNode;
}
const Context = createContext<FilterValuePresentation>({});
export const FilterValueProvider = Context.Provider;
export function useFilterValuePresentation() { return useContext(Context); }
export function PresentedFilterValue({field,value,label}: {field:string;value:string;label?:string}) {
  const presentation=useContext(Context);
  return <>{presentation.render?.(field,value) ?? presentation.label?.(field,value) ?? label ?? value}</>;
}

/** Search by key or label, select canonical keys, preserve unavailable values. */
export function PresentedValueInput({field,value,options,onChange}: {
  field:string; value:string; options:Array<string | {value:string;label:string}>; onChange:(value:string)=>void;
}) {
  const presentation=useContext(Context);
  const [open,setOpen]=useState(false),[search,setSearch]=useState('');
  const choices=options.map(option=>typeof option==='string'?{value:option,label:presentation.label?.(field,option) ?? option}:option);
  const visible=choices.filter(option=>`${option.value} ${option.label}`.toLowerCase().includes(search.toLowerCase()));
  return <span style={{position:'relative'}}>
    <button type="button" aria-label={`Edit ${field} filter value`} aria-expanded={open} onClick={()=>setOpen(!open)}><PresentedFilterValue field={field} value={value} label={choices.find(option=>option.value===value)?.label ?? value}/>{!value&&'Choose value'}</button>
    {open&&<span style={{position:'absolute',top:'100%',left:0,zIndex:30,background:'var(--qt-bg, #fff)',padding:8,minWidth:220,maxHeight:300,overflowY:'auto'}} onKeyDown={e=>{if(e.key==='Escape')setOpen(false)}}>
      <input autoFocus aria-label={`Search ${field} values`} value={search} onChange={e=>setSearch(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&search){e.preventDefault();onChange(visible[0]?.value ?? search);setOpen(false)}}}/>
      {visible.map(option=><button type="button" key={option.value} style={{display:'block'}} onClick={()=>{onChange(option.value);setOpen(false)}}><PresentedFilterValue field={field} value={option.value} label={option.label}/>{option.label!==option.value&&<small> {option.value}</small>}</button>)}
      {search&&!choices.some(option=>option.value===search)&&<button type="button" onClick={()=>{onChange(search);setOpen(false)}}>Use “{search}”</button>}
    </span>}
  </span>;
}
