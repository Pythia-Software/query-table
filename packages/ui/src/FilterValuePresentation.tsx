import { createContext, useContext, useRef, useState, type ReactNode } from 'react';
import { Popover } from './Popover';

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
  const trigger = useRef<HTMLButtonElement>(null);
  const choices=options.map(option=>typeof option==='string'?{value:option,label:presentation.label?.(field,option) ?? option}:option);
  const visible=choices.filter(option=>`${option.value} ${option.label}`.toLowerCase().includes(search.toLowerCase()));
  return <span className="qt-value-picker">
    <button ref={trigger} type="button" className="qt-chip-op-btn" aria-label={`Edit ${field} filter value`} aria-haspopup="dialog" aria-expanded={open} onClick={()=>{if(!open)setSearch('');setOpen(previous=>!previous)}}><PresentedFilterValue field={field} value={value} label={choices.find(option=>option.value===value)?.label ?? value}/>{!value&&'Choose value'}</button>
    {open&&trigger.current&&<Popover label="Choose a value" anchor={trigger.current} width={260} className="qt-value-picker-pop" onClose={()=>setOpen(false)}>
      <input className="qt-input" aria-label={`Search ${field} values`} placeholder="Search values…" value={search} onChange={e=>setSearch(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.nativeEvent.isComposing&&search){e.preventDefault();onChange(visible[0]?.value ?? search);setOpen(false)}}}/>
      <span className="qt-value-picker-list">
        {visible.map(option=><button type="button" key={option.value} aria-pressed={option.value === value} onClick={()=>{onChange(option.value);setOpen(false)}}><PresentedFilterValue field={field} value={option.value} label={option.label}/>{option.label!==option.value&&<small> {option.value}</small>}</button>)}
        {!visible.length && <p className="qt-muted">No matching values</p>}
        {search&&!choices.some(option=>option.value===search)&&<button type="button" onClick={()=>{onChange(search);setOpen(false)}}>Use “{search}”</button>}
      </span>
    </Popover>}
  </span>;
}
