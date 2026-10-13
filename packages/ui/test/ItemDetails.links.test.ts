// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { EMPTY_QUERY, createQueryLinkService, localQuerySnapshotCache,
  type FieldSchema, type QueryState } from "@pythia-software/query-table-core";
import { useQueryTable } from "@pythia-software/query-table-react";
import { ItemDetailsActions } from "../src/ItemDetails";
import { defaultRenderers } from "../src/renderers";

(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT = true;
const schema: FieldSchema<{id:number;name:string}> = {name:"runs",idField:"id",fields:[
  {name:"id",label:"Id",type:"number",source:{kind:"backend"}},
  {name:"name",label:"Name",type:"text",source:{kind:"backend"}},
]};
const rows = Array.from({length:100},(_,id)=>({id,name:String(id)}));
let cleanup: (()=>void) | undefined;
afterEach(()=>{cleanup?.();cleanup=undefined;vi.useRealTimers();vi.restoreAllMocks();});

it("renders and rerenders 100 oversized row page actions without filling the link cache", async()=>{
  vi.useFakeTimers();window.history.replaceState(null,"","/runs");
  let text: string | null = null;
  const getItem = vi.fn(()=>text);
  const setItem = vi.fn((_key:string,value:string)=>{text=value;});
  const cache = localQuerySnapshotCache({storage:{getItem,setItem}});
  const view = {version:1 as const,properties:[{id:"name",field:"name"}]};
  const query: QueryState = {...EMPTY_QUERY,where:[{field:"name",op:"contains",value:Array.from({length:200},(_,i)=>String(i*7919)).join(",")}],
    itemDetails:{modes:["page"],page:{urlTemplate:"",target:"_blank"},views:{hover:view,modal:view,expand:view}}};
  const links = {cache,maxUrlBytes:160};
  const container = document.createElement("div");document.body.appendChild(container);const root=createRoot(container);
  cleanup=()=>{act(()=>root.unmount());container.remove();};
  function Table(){
    const api=useQueryTable({schema,clientRows:rows,initialQuery:query,itemDetails:true,syncUrl:true,links,debounceMs:0});
    return createElement("div",null,rows.map(row=>createElement(ItemDetailsActions<{id:number;name:string}>,{key:row.id,api:api.itemDetails!,query:api.query,
      id:row.id,row,renderers:defaultRenderers,expandedId:String(row.id)})));
  }
  await act(async()=>{root.render(createElement(Table));await vi.advanceTimersByTimeAsync(500);});
  const collectionUrl=window.location.href;
  expect(new URL(collectionUrl).searchParams.get("q")).toMatch(/^@/);
  expect(setItem).toHaveBeenCalledOnce();expect(getItem.mock.calls.length).toBeLessThan(10);
  const reads=getItem.mock.calls.length;
  await act(async()=>{root.render(createElement(Table));});
  expect(setItem).toHaveBeenCalledOnce();expect(getItem).toHaveBeenCalledTimes(reads);
  const actions=container.querySelectorAll<HTMLButtonElement>('button[aria-label$="on page"]');
  expect(actions).toHaveLength(100);expect(actions[99]!.disabled).toBe(false);
  const open=vi.spyOn(window,"open").mockReturnValue(null);
  act(()=>actions[99]!.click());
  expect(open).toHaveBeenCalledOnce();expect(setItem).toHaveBeenCalledTimes(2);
  const service=createQueryLinkService("runs",undefined,{cache,maxUrlBytes:160});
  const itemQuery=await service.resolve(String(open.mock.calls[0]![0]));
  expect(itemQuery?.itemDetails?.active?.id).toBe(99);
  expect((await service.resolve(collectionUrl))?.itemDetails?.active).toBeUndefined();
});
