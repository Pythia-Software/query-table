import { expect, it } from "vitest";
import { applyQuery, compileFormula, EMPTY_QUERY, sourceDependencies, sourceExecutionSchema,
  toQueryRequestV3, type FieldSchema, type QueryState, type ComputedExecution, type QueryCapabilitiesV3 } from "../src/index";

const schema: FieldSchema<Record<string, unknown>> = { name: "narrow", idField: "id", fields: [
  {name:"id", label:"ID",type:"text",source:{kind:"backend"}},
  {name:"key", label:"Key",type:"text",source:{kind:"backend",path:"owner.key"}},
  {name:"n", label:"Number",type:"number",source:{kind:"backend"}},
  {name:"rank",label:"Rank",type:"number",source:{kind:"backend"}},
  {name:"label",label:"Label",type:"text",source:{kind:"backend"},sort:{field:"rank"}},
  {name:"long",label:"Long text",type:"text",source:{kind:"backend"}},
] };
const query: QueryState = {...EMPTY_QUERY, select:[{field:"total"}], where:[{field:"total",op:">",value:"0"}], grouping:{
  source:{...EMPTY_QUERY,where:[{field:"n",op:">=",value:"2"}]},keys:["key"],
  summaries:[{id:"total",op:"sum",field:"n"},{id:"example",op:"row",field:"label"}],
  representative:{orderBy:[{field:"label",dir:"desc",nulls:"last"}]},
}};
const rows = [{id:"1",owner:{key:"a"},n:1,rank:1,label:"old",long:"unused"},
  {id:"2",owner:{key:"a"},n:2,rank:2,label:"new",long:"unused"}];

it("includes hidden representative inputs and sort bindings, separating HAVING aliases from source fields",()=>{
  const plan=sourceDependencies(query,schema);
  expect(plan.fields).toEqual(["id","key","label","n","rank"]);
  expect(plan.baseFields).not.toContain("total");expect(plan.fields).not.toContain("long");
  expect(plan.paths.key).toBe("owner.key");
  const narrow=rows.map(({long,...row})=>row);
  expect(applyQuery(narrow,query,schema)).toEqual(applyQuery(rows,query,schema));
});

it("discovers transitive computed inputs and rejects unavailable dependencies",()=>{
  const base=compileFormula("[n]*2",schema.fields);
  const child=compileFormula("[@computed/base]+1",schema.fields,name=>name==="@computed/base"?base:undefined);
  const withComputed=sourceExecutionSchema(schema,{profile:"qt-sqlite-v1",planToken:"",resolvedRevisions:{base:"1",child:"1"},fields:{
    "@computed/child":{type:"number",select:true,sort:true,measure:true,group:true,filter:true},
  }});
  const grouped={...query,grouping:{...query.grouping!,keys:["@computed/child"]}};
  const plan=sourceDependencies(grouped,withComputed,name=>name==="@computed/child"?child:name==="@computed/base"?base:undefined);
  expect(plan.baseFields).toContain("n");expect(plan.baseFields).not.toContain("@computed/child");
  expect(()=>sourceDependencies({...query,grouping:{...query.grouping!,keys:["gone"]}},schema)).toThrow();
});

it("groups approved materialized computed keys and retains source predicates",()=>{
  const execution:ComputedExecution={profile:"qt-sqlite-v1",planToken:"",resolvedRevisions:{double:"1"},fields:{
    "@computed/double":{type:"number",select:true,sort:true,measure:true,group:true,filter:true},
  }};
  const approved=sourceExecutionSchema(schema,execution);
  const grouped:QueryState={...query,select:[{field:"@computed/double"},{field:"total"}],grouping:{
    ...query.grouping!,keys:["@computed/double"],source:{...EMPTY_QUERY,where:[{field:"@computed/double",op:">",value:"2"}]},
  }};
  const result=applyQuery(rows.map(row=>({...row,"@computed/double":row.n*2})),grouped,approved);
  expect(result.rows).toHaveLength(1);expect(result.rows[0]).toMatchObject({"@computed/double":4,total:2});
  const unapproved=sourceExecutionSchema(schema,{...execution,fields:{"@computed/double":{...execution.fields["@computed/double"]!,filter:false}}});
  expect(()=>applyQuery(rows,grouped,unapproved)).toThrow("unavailable field");
  const capabilities:QueryCapabilitiesV3={version:3,profile:"qt-sqlite-v1",groupedRows:true,calendarGrouping:true,computedSourceFilters:true,regex:false,maxRows:10000,maxGroups:2000,maxPopulation:250000};
  expect(toQueryRequestV3(grouped,schema,capabilities,execution,{now:1}).diagnostics).toEqual([]);
  const regex={...grouped,grouping:{...grouped.grouping!,source:{...EMPTY_QUERY,where:[{field:"key",op:"matches_regex" as const,value:"a"}]}}};
  expect(toQueryRequestV3(regex,schema,capabilities,execution).diagnostics.join(" ")).toContain("regex");
  expect(()=>applyQuery(rows,regex,approved)).toThrow("isolated");
});
