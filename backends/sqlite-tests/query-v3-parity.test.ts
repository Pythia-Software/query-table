import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { applyQuery, evaluateMetrics, EMPTY_QUERY, type QueryState, type FieldSchema, type AggregationResult, type QueryRequestV3, type QueryResultV3 } from "../../packages/core/src/index";
type Row = Record<string, unknown>;
const schema: FieldSchema<Row> = { name:"grouped",idField:"id",fields:[
  {name:"id",type:"text",label:"ID",source:{kind:"backend"}}, {name:"k",type:"text",label:"Key",source:{kind:"backend"}},
  {name:"n",type:"number",label:"Number",source:{kind:"backend"},aggregate:{groupable:true}},
  {name:"at",type:"datetime",label:"Time",source:{kind:"backend"},aggregate:{groupable:true}},
  {name:"label",type:"text",label:"Label",source:{kind:"backend"}}, {name:"flag",type:"bool",label:"Flag",source:{kind:"backend"}},
]};
type Stage = QueryRequestV3["source"] & { w?:QueryState["where"]; o?:QueryState["orderBy"]; l?:number; f?:number };
const state = (stage:Stage):QueryState => ({...EMPTY_QUERY,select:(stage.select??[]).map(field=>({field})),where:stage.where??stage.w??[],orderBy:stage.orderBy??stage.o??[],limit:stage.limit??stage.l??10000,offset:stage.offset??stage.f??0});
it("matches local grouped rows, representatives and calendar metrics with the real SQLite executor",()=>{
  const output=execFileSync("go",["test","-run","^TestV3FrontendParity$","-count=1","-v"],{cwd:new URL("./",import.meta.url),encoding:"utf8",timeout:120000,maxBuffer:8*1024*1024});
  const line=output.split("\n").find(line=>line.includes("V3_FIXTURES "));expect(line).toBeDefined();
  const fixtures=JSON.parse(line!.split("V3_FIXTURES ")[1]!) as {name:string;rows:Row[];request:QueryRequestV3;result:QueryResultV3}[];
  expect(fixtures.length).toBeGreaterThan(50);
  for(const {name,rows,request,result} of fixtures){
    const query:QueryState={...state(request.result),aggregations:(request.metrics??[]).map(metric=>({...metric,op:metric.op||"count",groupBy:metric.groupBy??[]})),...(request.grouping?{grouping:{...request.grouping,source:state(request.source)}}:{})};
    if(request.rows){const local=applyQuery(rows,query,schema,{now:request.now});
      // SQLite retains its existing exact-decimal AVG profile. Browser AVG
      // divides each sample before summing, so a final double can differ by an ULP.
      const actual=result.rows.map(row=>({...row})),expected=local.rows.map(row=>({...row}));
      for(let i=0;i<actual.length;i++){const a=actual[i]!.average,b=expected[i]!.average;if(typeof a==="number"&&typeof b==="number")expect(Math.abs(a-b),name).toBeLessThanOrEqual(Math.max(Math.abs(a),Math.abs(b))*1e-14);delete actual[i]!.average;delete expected[i]!.average}
      expect(actual,name).toEqual(expected);expect(result.total,name).toBe(local.total)}
    const local=evaluateMetrics(rows,query,schema,{now:request.now});
    const normalize=(metrics:AggregationResult["metrics"])=>metrics.map(metric=>({id:metric.id,scope:metric.scope,processedRows:metric.processedRows,groupCount:metric.groupCount,buckets:metric.buckets}));
    expect(normalize(result.metrics),name).toEqual(normalize(local.metrics));
  }
},120000);
