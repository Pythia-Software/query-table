// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EMPTY_QUERY, applyQuery, createGroupingModel, encodeQuery, evaluateMetrics, memoryStorageAdapter, memoryQuerySnapshotCache,
  type QueryState, type FieldSchema, type QueryRequestV3,
  type QueryResultV3, type Transport, type QueryCapabilitiesV3, type QuerySnapshot } from "@pythia-software/query-table-core";
import { useQueryTable, type QueryTableApi, type UseQueryTableOptions } from "../src/useQueryTable";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
type Row = { id: string; k: string; n: number; at: string };
const schema: FieldSchema<Row> = { name:"source",idField:"id",defaultSelect:[{field:"id"},{field:"k"},{field:"n"},{field:"at"}],fields:[
  {name:"id",type:"text",label:"ID",source:{kind:"backend"}}, {name:"k",type:"text",label:"Key",source:{kind:"backend"}},
  {name:"n",type:"number",label:"Number",source:{kind:"backend"},aggregate:{groupable:true}},
  {name:"at",type:"datetime",label:"Time",source:{kind:"backend"},aggregate:{groupable:true}},
]};
let cleanup: (()=>void) | undefined;
function mount(options: UseQueryTableOptions<Row> | (()=>UseQueryTableOptions<Row>)) {
  const root=createRoot(document.createElement("div"));let api!:QueryTableApi<Row>;
  let renders=0;
  function Probe(){if(++renders>150)throw Error("Unexpected controller render loop.");api=useQueryTable(typeof options==="function"?options():options);return null}
  act(()=>root.render(createElement(Probe)));cleanup=()=>act(()=>root.unmount());
  return Object.assign(()=>api,{rerender:()=>act(()=>root.render(createElement(Probe)))});
}
async function settle(){await act(async()=>{});await act(async()=>{await vi.advanceTimersByTimeAsync(500)})}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-13T12:00:00Z"));localStorage.clear();window.history.replaceState(null,"","/source")});
afterEach(()=>{cleanup?.();cleanup=undefined;vi.useRealTimers()});

it("requests grouping source stats only for backend fields and forwards cancellation",async()=>{
  const extended:FieldSchema<Row>={...schema,fields:[...schema.fields,
    {name:"double",label:"Double",type:"number",source:{kind:"derived",dependencies:["n"],accessor:row=>row.n*2}},
  ]};
  const fetchFieldStats=vi.fn(async(names:string[],signal?:AbortSignal)=>{
    if(names.some(name=>!["id","k","n","at"].includes(name)))throw Error("Unknown backend field");
    if(signal?.aborted)throw new DOMException("Aborted","AbortError");
    return Object.fromEntries(names.map(name=>[name,{distinct:5}]));
  });
  const transport:Transport<Row>={fetchRows:vi.fn(async()=>({rows:[],total:0})),fetchFieldStats,
    fetchQueryV3:vi.fn(),queryCapabilities:{version:3,profile:"qt-sqlite-v1",groupedRows:true,calendarGrouping:true,computedSourceFilters:false,regex:false,maxRows:10000,maxGroups:2000,maxPopulation:250000}};
  const api=mount({schema:extended,transport,debounceMs:0});await settle();
  const controller=new AbortController();
  let stats:unknown;
  await act(async()=>{stats=await api().grouping!.source.fieldStats(["n","double","@computed/local","unknown","n"],controller.signal)});
  expect(stats).toEqual({n:{distinct:5}});expect(fetchFieldStats).toHaveBeenCalledWith(["n"],controller.signal);
  fetchFieldStats.mockClear();
  await act(async()=>{expect(await api().grouping!.source.fieldStats(["double","@computed/local"],controller.signal)).toEqual({})});
  expect(fetchFieldStats).not.toHaveBeenCalled();
  controller.abort();
  await act(async()=>{await expect(api().grouping!.source.fieldStats(["n"],controller.signal)).rejects.toThrow("Aborted")});
});

it.each(["/tools", "?", "#"])("restores relative router locations (%s)",async form=>{
  const fetchRows=vi.fn(async()=>({rows:[],total:0}));
  const api=mount({schema,transport:{fetchRows},syncUrl:true,queryParameter:"q_tools",debounceMs:0});
  await settle();
  const token=encodeQuery({...EMPTY_QUERY,limit:17});
  const location=`/tools?q_tools=${token}&host=route#one`;
  window.history.pushState(null,"",location);
  const relative=form==="/tools"?location:form==="?"?window.location.search+window.location.hash:window.location.hash;
  await act(async()=>{await api().restoreLocation(relative)});await settle();
  expect(api().query.limit).toBe(17);expect(api().restoration.ready).toBe(true);
  act(()=>api().setLimit(7));await settle();expect(api().canUndo).toBe(true);
  const calls=fetchRows.mock.calls.length;
  window.history.pushState(null,"",window.location.pathname+window.location.search+"&unrelated=1#two");
  await act(async()=>{await api().restoreLocation(window.location.search+window.location.hash)});await settle();
  expect(api().query.limit).toBe(7);expect(api().canUndo).toBe(true);expect(fetchRows).toHaveBeenCalledTimes(calls);
});

it("resolves relative snapshot links and holds requests for invalid relative links",async()=>{
  const fetchRows=vi.fn(async()=>({rows:[],total:0}));
  const code="a".repeat(22);
  const snapshots={save:vi.fn(),resolve:vi.fn(async()=>({version:1 as const,code,token:encodeQuery({...EMPTY_QUERY,limit:23}),createdAt:1}))};
  const storage={...memoryStorageAdapter(),snapshots};
  const api=mount({schema,transport:{fetchRows},storage,syncUrl:true,queryParameter:"q_tools",debounceMs:0,links:{cache:memoryQuerySnapshotCache()}});
  await settle();
  const relative=`/tools?q_tools=@${code}&host=route`;
  window.history.pushState(null,"",relative);
  await act(async()=>{await api().restoreLocation(relative)});await settle();
  expect(snapshots.resolve).toHaveBeenCalledOnce();expect(api().query.limit).toBe(23);expect(api().restoration.ready).toBe(true);
  for(const link of ["/tools?q_tools=x&q_tools=y&host=route#duplicate","?q_tools=corrupt&host=route#corrupt"]){
    fetchRows.mockClear();window.history.pushState(null,"",link);
    const incoming=window.location.href;
    await act(async()=>{await expect(api().restoreLocation(link)).rejects.toThrow()});await settle();
    expect(api().restoration.status).toBe("error");expect(fetchRows).not.toHaveBeenCalled();expect(window.location.href).toBe(incoming);
  }
});

it("restores pushState explicitly and gates requests through slow resolution and duplicate errors",async()=>{
  const fetchRows=vi.fn(async()=>({rows:[],total:0}));let resolve!: (snapshot:QuerySnapshot|null)=>void;
  const store={...memoryStorageAdapter(),snapshots:{save:vi.fn(async(_key:string,snapshot:QuerySnapshot)=>snapshot),resolve:vi.fn(()=>new Promise<QuerySnapshot|null>(done=>{resolve=done}))}};
  const api=mount({schema,transport:{fetchRows},storage:store,syncUrl:true,debounceMs:0,links:{cache:memoryQuerySnapshotCache()}});
  await settle();expect(api().restoration.ready).toBe(true);fetchRows.mockClear();
  window.history.pushState(null,"","/source?q=@aaaaaaaaaaaaaaaaaaaaaa&host=route#one");
  let restore!:Promise<void>;act(()=>{restore=api().restoreLocation(window.location.href)});await settle();
  expect(api().restoration.status).toBe("resolving");expect(fetchRows).not.toHaveBeenCalled();
  act(()=>api().setLimit(7));await settle();
  await act(async()=>{resolve({version:1,code:"a".repeat(22),token:"2j.eyJsIjoyNX0",createdAt:1});await restore});
  expect(api().query.limit).toBe(7);expect(api().restoration.ready).toBe(true);
  fetchRows.mockClear();window.history.pushState(null,"","/source?q=x&q=y&host=route#two");
  await act(async()=>{await expect(api().restoreLocation(window.location.href)).rejects.toThrow("conflicting")});await settle();
  expect(api().restoration.status).toBe("error");expect(fetchRows).not.toHaveBeenCalled();expect(window.location.search).toContain("q=x&q=y");
  act(()=>api().resetAll());await settle();expect(api().restoration.ready).toBe(true);
});

it("ignores unrelated router changes and pauses a hidden mounted controller",async()=>{
  let active=true;const fetchRows=vi.fn(async()=>({rows:[],total:0}));
  const transport={fetchRows};
  const api=mount(()=>({schema,transport,syncUrl:true,active,debounceMs:0}));await settle();
  act(()=>api().setLimit(7));await settle();expect(api().canUndo).toBe(true);
  window.history.pushState(null,"",window.location.pathname+window.location.search+"#different");
  await act(async()=>{await api().restoreLocation(window.location.href)});expect(api().query.limit).toBe(7);expect(api().canUndo).toBe(true);
  active=false;act(()=>api().setOffset(1));await settle();const address=window.location.href;fetchRows.mockClear();
  act(()=>api().setLimit(9));await settle();expect(window.location.href).toBe(address);expect(fetchRows).not.toHaveBeenCalled();expect(api().restoration.ready).toBe(false);
});

it.each([false,true])("preserves undo, redo and restored state across activation (URL sync: %s)",async syncUrl=>{
  let active=true;
  const loadLast=vi.fn(async()=>({...EMPTY_QUERY,limit:25}));
  const storage={...memoryStorageAdapter(),loadLast};
  const transport={fetchRows:vi.fn(async()=>({rows:[],total:0}))};
  const api=mount(()=>({schema,storage,transport,syncUrl,active,debounceMs:0}));await settle();
  expect(api().query.limit).toBe(25);
  act(()=>api().setLimit(7));act(()=>api().setOffset(1));act(()=>api().undo());await settle();
  expect(api().query.limit).toBe(7);expect(api().canUndo).toBe(true);expect(api().canRedo).toBe(true);
  active=false;api.rerender();await settle();
  const calls=transport.fetchRows.mock.calls.length,address=window.location.href;
  await settle();expect(transport.fetchRows).toHaveBeenCalledTimes(calls);expect(window.location.href).toBe(address);
  active=true;api.rerender();await settle();
  expect(loadLast).toHaveBeenCalledOnce();expect(api().query.limit).toBe(7);
  expect(api().canUndo).toBe(true);expect(api().canRedo).toBe(true);expect(api().restoration.ready).toBe(true);
  act(()=>api().redo());expect(api().query.offset).toBe(1);
  act(()=>api().undo());act(()=>api().undo());expect(api().query.limit).toBe(25);
});

it("restores an initially hidden table on its first activation only",async()=>{
  let active=false;
  const loadLast=vi.fn(async()=>({...EMPTY_QUERY,limit:25}));
  const storage={...memoryStorageAdapter(),loadLast};
  const transport={fetchRows:vi.fn(async()=>({rows:[],total:0}))};
  const api=mount(()=>({schema,storage,transport,syncUrl:true,active,debounceMs:0}));await settle();
  expect(loadLast).not.toHaveBeenCalled();expect(transport.fetchRows).not.toHaveBeenCalled();
  active=true;api.rerender();await settle();expect(api().query.limit).toBe(25);
  act(()=>api().setLimit(7));await settle();
  active=false;api.rerender();await settle();active=true;api.rerender();await settle();
  expect(loadLast).toHaveBeenCalledOnce();expect(api().query.limit).toBe(7);expect(api().canUndo).toBe(true);
});

it("keeps a pending restoration through a hidden interval without starting it again",async()=>{
  let active=true,resolve!: (snapshot:QuerySnapshot|null)=>void;
  window.history.replaceState(null,"","/source?q=@aaaaaaaaaaaaaaaaaaaaaa");
  const snapshots={save:vi.fn(async(_key:string,snapshot:QuerySnapshot)=>snapshot),resolve:vi.fn(()=>new Promise<QuerySnapshot|null>(done=>{resolve=done}))};
  const storage={...memoryStorageAdapter(),snapshots};
  const transport={fetchRows:vi.fn(async()=>({rows:[],total:0}))};
  const api=mount(()=>({schema,storage,transport,syncUrl:true,active,debounceMs:0,links:{cache:memoryQuerySnapshotCache()}}));
  await settle();expect(api().restoration.status).toBe("resolving");
  active=false;api.rerender();await settle();
  await act(async()=>{resolve({version:1,code:"a".repeat(22),token:"2j.eyJsIjoyNX0",createdAt:1})});await settle();
  expect(api().query.limit).toBe(25);expect(transport.fetchRows).not.toHaveBeenCalled();
  active=true;api.rerender();await settle();
  expect(snapshots.resolve).toHaveBeenCalledOnce();expect(api().query.limit).toBe(25);expect(api().restoration.ready).toBe(true);
});

it("executes grouped rows and shown-group metrics through the negotiated v3 transport",async()=>{
  const rows:Row[]=[{id:"1",k:"a",n:1,at:"2026-10-13T12:00:00Z"},{id:"2",k:"a",n:3,at:"2026-10-13T12:00:00Z"},{id:"3",k:"b",n:10,at:"2026-10-13T12:00:00Z"}];
  const capabilities:QueryCapabilitiesV3={version:3,groupedRows:true,calendarGrouping:true,computedSourceFilters:true,regex:false,maxRows:10000,maxGroups:2000,maxPopulation:250000,profile:"qt-sqlite-v1"};
  const fetchQueryV3=vi.fn(async(request:QueryRequestV3):Promise<QueryResultV3>=>{
    const source={...EMPTY_QUERY,...request.source,select:request.source.select.map(field=>({field}))};
    const query:QueryState={...EMPTY_QUERY,...request.result,select:request.result.select.map(field=>({field})),aggregations:request.metrics,...(request.grouping?{grouping:{...request.grouping,source}}:{})};
    const resultSchema=request.grouping?createGroupingModel(schema).resultSchema(request.grouping.keys,request.grouping.summaries):schema;
    const result=applyQuery(rows,query,schema,{now:request.now});
    return {version:3,now:request.now,sourceTotal:rows.length,rows:request.rows?result.rows:[],total:result.total,schema:{name:resultSchema.name,idField:resultSchema.idField,fields:resultSchema.fields.map(field=>({name:field.name,type:field.type}))},metrics:evaluateMetrics(rows,query,schema,{now:request.now}).metrics,execution:{profile:request.profile,planToken:"",resolvedRevisions:{},fields:{}}};
  });
  const query:QueryState={...EMPTY_QUERY,grouping:{source:{...EMPTY_QUERY,where:[{field:"n",op:">=" as const,value:"1"}]},keys:["k"],summaries:[{id:"total",op:"sum",field:"n"}],representative:null},select:[{field:"k"},{field:"total"}],where:[{field:"total",op:">=" as const,value:"4"}],orderBy:[{field:"total",dir:"desc"}],limit:1,aggregations:[{id:"page",op:"sum",field:"total",groupBy:[],scope:"shownRows"}]};
  const transport={fetchRows:vi.fn(async()=>({rows:[],total:0})),queryCapabilities:capabilities,fetchQueryV3};
  const api=mount({schema,transport,initialQuery:query,debounceMs:0});await settle();
  expect(api().error).toBeNull();expect(api().grouping?.supported).toBe(true);expect(api().rows[0]).toMatchObject({k:"b",total:10});expect(api().total).toBe(2);
  expect(api().aggregations.results?.metrics[0]?.buckets[0]?.value).toBe(10);expect(transport.fetchRows).not.toHaveBeenCalled();
  expect(fetchQueryV3.mock.calls.some(([request])=>request.rows)).toBe(true);expect(fetchQueryV3.mock.calls.some(([request])=>!request.rows)).toBe(true);
  expect(new Set(fetchQueryV3.mock.calls.map(([request])=>request.now)).size).toBe(1);
});

it("reports unsupported remote metrics without downloading the matching population",async()=>{
  const transport:Transport<Row>={fetchRows:vi.fn(async()=>({rows:[],total:1_000_000}))};
  const initialQuery:QueryState={...EMPTY_QUERY,select:[{field:"id"}],limit:2,offset:7,
    aggregations:[{id:"count",op:"count",groupBy:[]}]};
  const api=mount({schema,transport,initialQuery,debounceMs:0});await settle();
  expect(api().aggregations.error?.message).toContain("metric-capable server transport");
  expect(transport.fetchRows).toHaveBeenCalledOnce();
  expect(transport.fetchRows).toHaveBeenCalledWith(expect.objectContaining({limit:2,offset:7}),expect.any(AbortSignal));
  expect(api().rows).toEqual([]);expect(api().total).toBe(1_000_000);
});

it("preserves canonical predicates and validates hidden computed fields in ordinary v3 rows and metrics",async()=>{
  const execution={profile:"qt-sqlite-v1",planToken:"",resolvedRevisions:{double:"1"},fields:{
    "@computed/double":{type:"number" as const,select:true,sort:true,measure:true,group:true,filter:true},
  }};
  const row:Row={id:"1",k:"a",n:2,at:"2026-10-13T12:00:00Z"};
  const fetchQueryV3=vi.fn(async(request:QueryRequestV3):Promise<QueryResultV3>=>({
    version:3,now:request.now,sourceTotal:1,total:1,rows:request.rows?[row]:[],
    schema:{name:schema.name,idField:schema.idField,fields:[...schema.fields.map(({name,type})=>({name,type})),{name:"@computed/double",type:"number"}]},
    metrics:request.metrics.map(metric=>({id:metric.id,scope:"allMatching",processedRows:1,groupCount:1,buckets:[{keys:[],value:1,count:1}]})),execution,
  }));
  const transport:Transport<Row>={fetchRows:vi.fn(async()=>({rows:[],total:0})),fetchQueryV3,
    queryCapabilities:{version:3,profile:execution.profile,groupedRows:true,calendarGrouping:true,computedSourceFilters:true,regex:false,maxRows:10000,maxGroups:2000,maxPopulation:250000}};
  const initialQuery:QueryState={...EMPTY_QUERY,select:[{field:"id"},{field:"n"}],where:[{field:"@computed/double",op:">",value:"2"}],
    aggregations:[{id:"count",op:"count",groupBy:[]}]};
  const api=mount({schema,transport,computedExecution:execution,initialQuery,debounceMs:0});await settle();
  expect(api().query.where).toEqual(initialQuery.where);expect(api().error).toBeNull();expect(api().rows).toEqual([row]);
  expect(api().aggregations.error).toBeNull();expect(api().aggregations.results?.metrics[0]?.buckets[0]?.value).toBe(1);
  for (const [request] of fetchQueryV3.mock.calls) expect(request.source.where[0]).toMatchObject({field:"@computed/double"});
  expect(transport.fetchRows).not.toHaveBeenCalled();
  const calls=fetchQueryV3.mock.calls.length;
  act(()=>api().setQuery({...initialQuery,where:[{field:"@computed/double",op:">",value:"3"}]}));await settle();
  expect(fetchQueryV3.mock.calls.length).toBeGreaterThan(calls);
  expect(fetchQueryV3.mock.calls.at(-1)![0].source.where[0]).toMatchObject({value:"3"});
});

it("uses fresh clocks for ordinary v3 relative filters and explicit previews",async()=>{
  const execution={profile:"qt-sqlite-v1",planToken:"",resolvedRevisions:{double:"1"},fields:{
    "@computed/double":{type:"number" as const,select:true,sort:true,measure:true,group:true,filter:true},
  }};
  const fetchQueryV3=vi.fn(async(request:QueryRequestV3):Promise<QueryResultV3>=>{
    const projection=request.grouping?createGroupingModel(schema).resultSchema(request.grouping.keys,request.grouping.summaries):schema;
    return {version:3,now:request.now,sourceTotal:0,total:0,rows:[],
      schema:{name:projection.name,idField:projection.idField,fields:projection.fields.map(({name,type})=>({name,type}))},
      metrics:request.metrics.map(metric=>({id:metric.id,scope:"allMatching",processedRows:0,groupCount:0,buckets:[]})),execution};
  });
  const transport:Transport<Row>={fetchRows:vi.fn(async()=>({rows:[],total:0})),fetchQueryV3,
    queryCapabilities:{version:3,profile:execution.profile,groupedRows:true,calendarGrouping:true,computedSourceFilters:true,regex:false,maxRows:10000,maxGroups:2000,maxPopulation:250000}};
  const initialQuery:QueryState={...EMPTY_QUERY,select:[{field:"id"}],where:[{field:"@computed/double",op:">",value:"2"}],
    aggregations:[{id:"count",op:"count",groupBy:[]}]};
  const api=mount({schema,transport,computedExecution:execution,initialQuery,debounceMs:0});await settle();
  const mountedAt=fetchQueryV3.mock.calls[0]![0].now;
  vi.setSystemTime(new Date(mountedAt+3_600_000));
  const editedAt=Date.now();fetchQueryV3.mockClear();
  act(()=>api().setQuery({...initialQuery,where:[...initialQuery.where,{field:"at",op:">=",value:"-1h"}]}));await settle();
  expect(api().error).toBeNull();expect(api().aggregations.error).toBeNull();
  expect(fetchQueryV3.mock.calls.some(([request])=>request.rows)).toBe(true);
  expect(fetchQueryV3.mock.calls.some(([request])=>!request.rows)).toBe(true);
  for(const [request] of fetchQueryV3.mock.calls)expect(request.now).toBeGreaterThanOrEqual(editedAt);
  vi.setSystemTime(new Date(editedAt+3_600_000));
  const previewAt=Date.now();
  await act(async()=>{await api().aggregations.preview!(initialQuery.aggregations!)});
  expect(fetchQueryV3.mock.calls.at(-1)![0].now).toBe(previewAt);
  const draft:QueryState={...EMPTY_QUERY,select:[{field:"k"}],grouping:{source:api().query,keys:["k"],summaries:[],representative:null}};
  await act(async()=>{await api().grouping!.preview!(draft)});
  expect(fetchQueryV3.mock.calls.at(-1)![0].now).toBe(previewAt);
});

it("keeps legacy local metric behavior when a transport also exposes v3",async()=>{
  const rows:Row[]=[{id:"1",k:"a",n:2,at:"2026-10-13T12:00:00Z"}];
  const initialQuery:QueryState={...EMPTY_QUERY,where:[{field:"removed",op:"=",value:"old saved filter"}],
    aggregations:[{id:"count",op:"count",groupBy:[]}]};
  const transport:Transport<Row>={fetchRows:vi.fn(async()=>({rows,total:1})),fetchQueryV3:vi.fn()};
  const api=mount({schema,clientRows:rows,transport,initialQuery,debounceMs:0});await settle();
  expect(api().aggregations.error).toBeNull();expect(api().aggregations.results?.metrics[0]?.buckets[0]?.value).toBe(1);
  expect(transport.fetchQueryV3).not.toHaveBeenCalled();
});
