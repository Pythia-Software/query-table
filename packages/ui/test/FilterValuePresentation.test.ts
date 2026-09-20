// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect,it,vi } from 'vitest';
import { FilterValueProvider, PresentedValueInput } from '../src/FilterValuePresentation';
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it('renders rich current values and options while emitting only stable keys',()=>{
  const node=document.createElement('div');const root=createRoot(node);const change=vi.fn();
  act(()=>root.render(createElement(FilterValueProvider,{value:{render:(_field,value)=>createElement('strong',null,value==='opaque'?'★ Display name':value)}},createElement(PresentedValueInput,{field:'labels',value:'opaque',options:[{value:'opaque',label:'Display name'},'legacy'],onChange:change}))));
  expect(node.textContent).toContain('★ Display name');
  act(()=>node.querySelector('button')!.click());
  const option=Array.from(node.querySelectorAll('button')).find(button=>button.textContent==='★ Display name opaque');
  expect(option).toBeDefined();
  act(()=>option!.click());
  expect(change).toHaveBeenCalledWith('opaque');
  act(()=>root.unmount());
});

it('uses object labels without a provider and submits a canonical key with Enter',()=>{
  const node=document.createElement('div');document.body.append(node);const root=createRoot(node);const change=vi.fn();
  act(()=>root.render(createElement(PresentedValueInput,{field:'labels',value:'opaque',options:[{value:'opaque',label:'Display name'},'legacy'],onChange:change})));
  expect(node.querySelector('button')!.textContent).toBe('Display name');
  act(()=>node.querySelector('button')!.click());
  const input=node.querySelector('input')!;
  act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'Display');input.dispatchEvent(new Event('input',{bubbles:true}))});
  act(()=>input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})));
  expect(change).toHaveBeenCalledWith('opaque');
  act(()=>root.unmount());node.remove();
});
