import {afterEach,expect,it,vi} from "vitest";
import {mkdtemp,mkdir,writeFile,readFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import {Jobs} from "../../src/development/jobs.js";
import {projectProvenance} from "../../src/development/artifacts.js";
import {TransactionService} from "../../src/development/transactions.js";
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup();});
const hash=(text:string)=>createHash("sha256").update(text).digest("hex");
const address="0x"+"11".repeat(32);const txHash="0x"+"22".repeat(32);
async function fixture(){
 const project=await mkdtemp(join(tmpdir(),"mcp-deploy-"));const jobs=new Jobs();cleanups.push(async()=>{await jobs.close();await rm(project,{recursive:true,force:true});});
 await writeFile(join(project,"Nargo.toml"),'[package]\nname="fixture"\ntype="contract"');
 const path=join(project,"artifact.json");const artifact=JSON.stringify({name:"Fixture",functions:[]});await writeFile(path,artifact);
 const runtime:any={target:"fixture",installationRoot:project,supported:false,runtimeNode:{path:process.execPath,version:process.version},cli:{identity:"fixture"},compiler:{identity:"fixture"},packages:[],publicExports:[],provenance:{sourceIdentity:"unverified"},diagnostics:[]};
 const selection={operation:"compile"};const provenanceHash=await projectProvenance(project,runtime,selection);const contentHash=hash(artifact);
 const build=jobs.start("compile",async()=>({projectPath:project,operation:"compile",selection,toolchain:{installationRoot:project,nodeExecutable:process.execPath},provenanceHash,artifacts:[{path,contentHash,provenanceHash}]}));await jobs.wait(build.id);
 const stateDirectory=join(project,".aztec-mcp/sessions/fixture");await mkdir(stateDirectory,{recursive:true});
 const snapshot:any={sessionId:"session",projectPath:project,stateDirectory,runtime,proofMode:"fast",runtimeIdentity:"runtime",networkIdentity:"network"};
 const request=vi.fn(async(_id:string,operation:string,_input?:unknown)=>{
   if(operation==="contract-inspect")return {association:{artifact:{path,contentHash,provenanceHash,classId:"registered-class"}},problems:[],node:{published:true,currentClassId:"registered-class"},wallet:{instanceRegistered:true,artifactRegistered:true}};
   if(operation==="send-prepare")return {preparedId:"prepared",address,artifact:{path,contentHash,provenanceHash},registered:true};
   if(operation==="send-submit")return {address,txHash,registered:true,submitted:true,outcome:"submitted",submissionReached:true};
   if(operation==="send-discard")return {discarded:true};
   if(operation==="deployment-prepare")return {preparedId:"prepared",address,artifact:{path,contentHash,provenanceHash},registered:false};
   if(operation==="deployment-submit")return {address,txHash,registered:true,submitted:true};
   if(operation==="transaction-receipt")return {txHash,status:"proposed",executionResult:"success",blockNumber:4,blockHash:"0x"+"33".repeat(32),source:"node",scope:"public"};
   if(operation==="deployment-discard")return {discarded:true};
   if(operation==="deployment-complete")return {address,registered:true,published:true,initialized:true};
   throw new Error(`Unexpected operation ${operation}`);
 });
 const sessions:any={status:vi.fn(async()=>snapshot),request};const service=new TransactionService(sessions,jobs);
 const args={sessionId:"session",buildJobId:build.id,artifactPath:path,account:address,initializerName:"constructor",arguments:[],initialize:true};
 return{project,jobs,service,args,request,stateDirectory,sessions};
}
it("records the hash before waiting and retains deployment evidence through inclusion",async()=>{
 const {service,args,jobs,stateDirectory,request}=await fixture();
 const job=await service.deploy(args);const result=await jobs.wait(job.id);
 expect(result.status).toBe("completed");expect(result.evidence).toMatchObject({txHash,address,proofMode:"fast",submissionAttempted:true});
 expect(result.result).toMatchObject({included:true,registered:true,published:true,initialized:true,txHash,address});
 const journal=JSON.parse(await readFile(join(stateDirectory,"jobs",`${job.id}.json`),"utf8"));expect(journal.state).toBe("included");expect(journal.txHash).toBe(txHash);expect(journal).not.toHaveProperty("arguments");
 expect(request.mock.calls.map(c=>c[1])).toEqual(["deployment-prepare","deployment-submit","transaction-receipt","deployment-complete","deployment-discard"]);
});
it("rejects rebuilt artifacts and malformed initializer selection before submission",async()=>{
 const {service,args,request}=await fixture();
 await expect(service.deploy({...args,initializerName:"bad name"})).rejects.toThrow("invalid-initializer");
 await writeFile(args.artifactPath,JSON.stringify({name:"Rebuilt",functions:[]}));
 await expect(service.deploy(args)).rejects.toThrow("stale-artifact");expect(request).not.toHaveBeenCalled();
});
it("persists submitting before calling the worker and records unknown outcomes without retry",async()=>{
 const {service,args,jobs,request,stateDirectory}=await fixture();
 const original=request.getMockImplementation()!;
 request.mockImplementation(async(id,operation)=>{
  if(operation==="deployment-submit"){
   const {readdir}=await import("node:fs/promises");const [name]=(await readdir(join(stateDirectory,"jobs"))).filter(n=>n.endsWith(".json"));
   const journal=JSON.parse(await readFile(join(stateDirectory,"jobs",name),"utf8"));expect(journal.state).toBe("submitting");expect(journal.submissionAttempted).toBe(true);
   throw new Error("worker disappeared");
  }
  return original(id,operation);
 });
 const job=await service.deploy(args);const result=await jobs.wait(job.id);
 expect(result.status).toBe("failed");expect(result.evidence).toMatchObject({state:"unknown-outcome",submissionAttempted:true,chainTransactionCancelled:false});
 expect(request.mock.calls.filter(c=>c[1]==="deployment-submit")).toHaveLength(1);
});
it("cancels local waiting after submission while preserving the hash",async()=>{
 const {service,args,jobs,request}=await fixture();const original=request.getMockImplementation()!;
 let releaseSubmit:(value:any)=>void=()=>{};let entered:()=>void=()=>{};const submitting=new Promise<void>(resolve=>{entered=resolve;});
 request.mockImplementation(async(id,operation)=>{
  if(operation==="deployment-submit"){entered();return new Promise(resolve=>{releaseSubmit=resolve;});}
  return original(id,operation);
 });
 const job=await service.deploy(args);await submitting;jobs.cancel(job.id);
 releaseSubmit({address,txHash,registered:true,submitted:true});const result=await jobs.wait(job.id);
 expect(result.status).toBe("cancelled");expect(result.result).toMatchObject({txHash,cancelledWaiting:true,chainTransactionCancelled:false});expect(result.evidence).toMatchObject({txHash,state:"cancelled-waiting"});
 expect(request.mock.calls.filter(c=>c[1]==="transaction-receipt")).toHaveLength(0);
});
it("distinguishes a reverted inclusion from successful deployment",async()=>{
 const {service,args,jobs,request}=await fixture();const original=request.getMockImplementation()!;
 request.mockImplementation(async(id,operation)=>operation==="transaction-receipt"?{txHash,status:"proposed",executionResult:"reverted",blockNumber:4,blockHash:"0x"+"33".repeat(32),source:"node",scope:"public"}:original(id,operation));
 const result=await jobs.wait((await service.deploy(args)).id);
 expect(result.status).toBe("failed");expect(result.error).toMatchObject({code:"transaction-failed",details:{txHash,receipt:{executionResult:"reverted"}}});
 expect(request.mock.calls.some(c=>c[1]==="deployment-complete")).toBe(false);
});
it("sends a registered contract call through the same tracked lifecycle",async()=>{
 const {service,args,jobs}=await fixture();
 const job=await service.send({sessionId:args.sessionId,address,account:address,functionName:"increment",args:[address]});
 const result=await jobs.wait(job.id);expect(result.status).toBe("completed");expect(result.result).toMatchObject({txHash,included:true,accountScope:[address],proofValidityEstablished:false});
});
it.each([
 ["preparation-failed","simulation-failed",false,undefined,"failed"],
 ["submission-rejected","submission-rejected",true,txHash,"failed"],
 ["unknown-outcome","unknown-submission-outcome",true,txHash,"unknown-outcome"],
])("distinguishes %s without resending",async(outcome,code,reached,knownHash,state)=>{
 const {service,args,jobs,request}=await fixture();const original=request.getMockImplementation()!;
 request.mockImplementation(async(id,operation)=>operation==="send-submit"?{address,txHash:knownHash,registered:true,submitted:false,outcome,submissionReached:reached,error:{code,message:"Safe failure evidence"}}:original(id,operation));
 const result=await jobs.wait((await service.send({sessionId:args.sessionId,address,account:address,functionName:"transfer",args:[]})).id);
 expect(result.status).toBe("failed");expect(result.error?.code).toBe(code);expect(result.evidence).toMatchObject({state,submissionReached:reached,txHash:knownHash});
 expect(request.mock.calls.filter(c=>c[1]==="send-submit")).toHaveLength(1);
});
it.each([
 ["preparation-failed","transaction-preparation-failed",false,undefined,"failed"],
 ["submission-rejected","submission-rejected",true,txHash,"failed"],
 ["unknown-outcome","unknown-submission-outcome",true,txHash,"unknown-outcome"],
])("records deployment %s with the same broadcast evidence as sends",async(outcome,code,reached,knownHash,state)=>{
 const {service,args,jobs,request,stateDirectory}=await fixture();const original=request.getMockImplementation()!;
 request.mockImplementation(async(id,operation)=>operation==="deployment-submit"?{address,txHash:knownHash,registered:false,submitted:false,outcome,submissionReached:reached,error:{code,message:"Safe failure evidence"}}:original(id,operation));
 const job=await service.deploy(args);const result=await jobs.wait(job.id);
 expect(result.status).toBe("failed");expect(result.evidence).toMatchObject({state,submissionReached:reached,txHash:knownHash});
 const journal=JSON.parse(await readFile(join(stateDirectory,"jobs",`${job.id}.json`),"utf8"));
 expect(journal).toMatchObject({state,submissionAttempted:true,submissionReached:reached});expect(journal.txHash).toBe(knownHash);
 expect(request.mock.calls.filter(c=>c[1]==="deployment-submit")).toHaveLength(1);
});
it("blocks lifecycle changes during asynchronous admission and queued jobs",async()=>{
 const {service,args,jobs,sessions}=await fixture();const snapshot=await sessions.status();
 let release:(value:any)=>void=()=>{};sessions.status.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
 const starting=service.send({sessionId:args.sessionId,address,account:address,functionName:"increment",args:[address]});
 expect(()=>service.assertIdle(args.sessionId)).toThrow("session-busy");release(snapshot);
 const job=await starting;expect(service.activeJobIds(args.sessionId)).toContain(job.id);expect(()=>service.assertIdle(args.sessionId)).toThrow("session-busy");
 await jobs.wait(job.id);expect(()=>service.assertIdle(args.sessionId)).not.toThrow();
});
it("releases lifecycle ownership when a queued transaction is cancelled",async()=>{
 const {service,args,jobs}=await fixture();
 const job=await service.send({sessionId:args.sessionId,address,account:address,functionName:"increment",args:[address]});
 jobs.cancel(job.id);expect((await jobs.wait(job.id)).status).toBe("cancelled");
 expect(()=>service.assertIdle(args.sessionId)).not.toThrow();
});

it("sends the registered snapshot after rebuilding the original artifact",async()=>{
 const {service,args,jobs,request}=await fixture();const original=request.getMockImplementation()!;
 await writeFile(args.artifactPath,JSON.stringify({name:"Rebuilt",functions:[]}));
 request.mockImplementation(async(id,operation)=>{
  const result=await original(id,operation);
  return operation==="contract-inspect"?{...result,problems:["artifact-changed","artifact-mismatch"],artifact:{classId:"rebuilt-class"}}:result;
 });
 const job=await service.send({sessionId:args.sessionId,address,account:address,functionName:"increment",args:[]});
 const completed = await jobs.wait(job.id);
 expect(completed.status).toBe("completed");
 const inspection = await original(args.sessionId,"contract-inspect");
 expect(request).toHaveBeenCalledWith(args.sessionId,"send-prepare",expect.objectContaining({expectedContentHash:inspection.association!.artifact.contentHash}));
 expect(request.mock.calls.filter(call=>call[1]==="send-submit")).toHaveLength(1);
});
it("rejects a registered snapshot whose class no longer matches the node",async()=>{
 const {service,args,request}=await fixture();const original=request.getMockImplementation()!;
 request.mockImplementation(async(id,operation)=>{
  const result=await original(id,operation);
  return operation==="contract-inspect"?{...result,node:{published:true,currentClassId:"different-class"}}:result;
 });
 await expect(service.send({sessionId:args.sessionId,address,account:address,functionName:"increment",args:[]})).rejects.toThrow("missing-registration");
 expect(request.mock.calls.some(call=>call[1]==="send-prepare")).toBe(false);
});
it("does not complete a deployment on an included status without block evidence",async()=>{
 const {service,args,jobs,request}=await fixture();const original=request.getMockImplementation()!;
 request.mockImplementation(async(id,operation)=>operation==="transaction-receipt"?{txHash,status:"proposed",executionResult:"success",source:"node",scope:"public"}:original(id,operation));
 const result=await jobs.wait((await service.deploy(args)).id);
 expect(result.status).toBe("failed");
 expect(result.evidence).toMatchObject({state:"unknown-outcome"});
 expect(request.mock.calls.some(call=>call[1]==="deployment-complete")).toBe(false);
});
