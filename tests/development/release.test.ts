import {afterAll,afterEach,beforeEach,expect,it,vi} from "vitest";
import {mkdir,writeFile,readFile,readdir,rm,stat,symlink} from "node:fs/promises";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {ErrorCode,McpError} from "@modelcontextprotocol/sdk/types.js";
import {runtimeIdentity} from "../../src/development/policy.js";
import {ReleaseService,renderDeployScript,renderChecklist,type ReleaseManifest} from "../../src/development/release.js";
import {createDevelopmentBoundary} from "../../src/development/index.js";
import {buildFixture,type Cleanups} from "./build-fixture.js";
const cleanups:Cleanups=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup();});
const fpcAddress="0x"+"ab".repeat(32);
const generatedAt="2026-10-21T12:00:00.000Z";
async function fixture(kind:"compile"|"test"="compile",complete=true){
 const f=await buildFixture(cleanups,{kind,complete});
 const validator=vi.fn(async()=>f.runtime);const service=new ReleaseService(validator,f.jobs,()=>new Date(generatedAt));
 const outputDirectory=join(f.root,"release");
 const input:any={buildJobId:f.buildJobId,artifactPath:f.path,...f.toolchain,outputDirectory,args:["1000",7,true],initialize:true,account:"alice",fee:{method:"fpc-sponsored",fpcAddress},nodeUrl:"https://node.example:8080"};
 return {...f,validator,service,input,outputDirectory};
}
const scriptFixture=fileURLToPath(new URL("../fixtures/development/release/deploy.sh",import.meta.url));
const checklistFixture=fileURLToPath(new URL("../fixtures/development/release/CHECKLIST.md",import.meta.url));
const baseManifest:ReleaseManifest={
 schemaVersion:1,generatedAt,build:{jobId:"job",kind:"compile",projectPath:"/work/project",provenanceHash:"p"},
 artifact:{path:"/work/project/artifact.json",sha256:"0123456789abcdef".repeat(4),contractName:"Token"},
 deployment:{args:["1000",7,true],initialize:true,initializerName:"constructor",account:"alice",contractAlias:"token",nodeUrl:"https://node.example:8080"},
 fee:{method:"fpc-sponsored",fpcAddress},
 toolchain:{installationRoot:"/opt/aztec",nodeExecutable:"/opt/node",runtimeIdentity:"r",cli:{path:"/opt/aztec/bin/aztec-wallet"}},
};
const withDeployment=(deployment:Partial<ReleaseManifest["deployment"]>):ReleaseManifest=>({...baseManifest,deployment:{...baseManifest.deployment,...deployment}});
const absent=async(path:string)=>expect(stat(path)).rejects.toMatchObject({code:"ENOENT"});
it("writes the manifest for a verified build",async()=>{
 const f=await fixture();const start=vi.spyOn(f.jobs,"start");
 const result=await f.service.package({...f.input,initializerName:"constructor"});
 const manifest={
  schemaVersion:1,generatedAt,
  build:{jobId:f.buildJobId,kind:"compile",projectPath:f.project,provenanceHash:f.provenanceHash},
  artifact:{path:f.path,sha256:f.contentHash,contractName:"Token"},
  deployment:{args:["1000",7,true],initialize:true,initializerName:"constructor",account:"alice",contractAlias:"token",nodeUrl:"https://node.example:8080"},
  fee:{method:"fpc-sponsored",fpcAddress},
  toolchain:{installationRoot:"/opt/aztec",nodeExecutable:"/opt/node",runtimeIdentity:runtimeIdentity(f.runtime),cli:{path:"/opt/aztec/bin/aztec-wallet",identity:"v6.0.0-rc.3"}},
 };
 expect(result).toEqual({outputDirectory:f.outputDirectory,files:{script:join(f.outputDirectory,"deploy.sh"),checklist:join(f.outputDirectory,"CHECKLIST.md"),manifest:join(f.outputDirectory,"manifest.json")},manifest});
 const {script,checklist,manifest:file}=result.files;
 expect((await stat(checklist)).mode&0o777).toBe(0o600);
 expect(await readFile(checklist,"utf8")).toBe(renderChecklist(manifest as ReleaseManifest,script));
 expect(f.validator).toHaveBeenCalledWith(f.toolchain);
 expect(JSON.parse(await readFile(file,"utf8"))).toEqual(manifest);
 expect((await stat(file)).mode&0o777).toBe(0o600);
 expect((await stat(f.outputDirectory)).mode&0o777).toBe(0o700);
 expect((await stat(script)).mode&0o777).toBe(0o700);
 expect(await readFile(script,"utf8")).toBe(renderDeployScript(manifest as ReleaseManifest));
 expect(await readdir(f.outputDirectory)).toEqual(["CHECKLIST.md","deploy.sh","manifest.json"]);
 expect(start).not.toHaveBeenCalled();
});
it("omits optional deployment and fee fields and honours an explicit alias",async()=>{
 const f=await fixture("test");
 const {manifest}=await f.service.package({...f.input,initialize:false,fee:{method:"fee_juice"},contractAlias:"my-token"});
 expect(manifest.build.kind).toBe("test");
 expect(manifest.deployment).not.toHaveProperty("initializerName");
 expect(manifest.deployment).toMatchObject({initialize:false,contractAlias:"my-token"});
 expect(manifest.fee).toEqual({method:"fee_juice"});
});
it("reports an unsupported runtime before any other check",async()=>{
 const f=await fixture();
 f.validator.mockRejectedValueOnce(new McpError(ErrorCode.InvalidParams,"unsupported-runtime: rejected"));
 await expect(f.service.package({...f.input,buildJobId:"missing"})).rejects.toThrow("unsupported-runtime");
 f.validator.mockResolvedValueOnce({...f.runtime,cli:{identity:"v6.0.0-rc.3"}});
 await expect(f.service.package(f.input)).rejects.toMatchObject({code:"unsupported-runtime"});
 await absent(f.outputDirectory);
});
it.each([
 ["missing job",(f:any)=>({...f.input,buildJobId:"missing"}),"invalid-build"],
 ["incomplete job",(f:any)=>f.input,"invalid-build",false],
 ["runtime mismatch",(f:any)=>{f.validator.mockResolvedValueOnce({...f.runtime,runtimeNode:{...f.runtime.runtimeNode,path:"/other/node"}});return f.input;},"invalid-build"],
 ["changed artifact",async(f:any)=>{await writeFile(f.path,JSON.stringify({name:"Rebuilt",functions:[]}));return f.input;},"stale-artifact"],
 ["deleted artifact",async(f:any)=>{await rm(f.path);return f.input;},"stale-artifact"],
 ["changed source",async(f:any)=>{await writeFile(join(f.project,"Nargo.toml"),'[package]\nname="changed"\ntype="contract"');return f.input;},"stale-artifact"],
] as const)("rejects a %s before creating the output directory",async(_name,prepare,code,complete=true)=>{
 const f=await fixture("compile",complete);
 await expect(f.service.package(await prepare(f))).rejects.toMatchObject({code});
 await absent(f.outputDirectory);
});
it("rejects an existing output directory and a missing parent",async()=>{
 const f=await fixture();await mkdir(f.outputDirectory);
 await expect(f.service.package(f.input)).rejects.toMatchObject({code:"output-exists"});
 expect(await readdir(f.outputDirectory)).toEqual([]);
 await expect(f.service.package({...f.input,outputDirectory:join(f.root,"absent","release")})).rejects.toMatchObject({code:"output-parent-missing"});
});
it("rejects an output directory below a symbolic link and removes it",async()=>{
 const f=await fixture();const real=join(f.root,"real");await mkdir(real);const link=join(f.root,"link");await symlink(real,link);
 await expect(f.service.package({...f.input,outputDirectory:join(link,"release")})).rejects.toMatchObject({code:"output-not-canonical"});
 expect(f.validator).toHaveBeenCalled();
 await absent(join(real,"release"));
});
it("returns service errors as tool results through the boundary",async()=>{
 const f=await fixture();const boundary=createDevelopmentBoundary({validateRuntime:f.validator});cleanups.push(async()=>{await boundary.shutdown?.();});
 const {buildJobId:_,...input}=f.input;
 const response=await boundary.callTool("aztec_dev_release",{operation:"package",...input,buildJobId:"missing"});
 expect(response.isError).toBe(true);
 expect(response.structuredContent).toMatchObject({error:{code:"invalid-build"}});
});
const validateRuntime=vi.fn();const boundary=createDevelopmentBoundary({validateRuntime});
beforeEach(()=>{validateRuntime.mockClear();});
afterAll(async()=>{await boundary.shutdown?.();});
it.each([
 {fee:{method:"fpc-public",fpcAddress}},
 {fee:{method:"fpc-sponsored"}},
 {fee:{method:"fee_juice",fpcAddress}},
 {fee:{method:"fpc-sponsored",fpcAddress:"0xzz"}},
 {fee:{method:"fee_juice",extra:true}},
 {fee:{method:"fpc-sponsored",fpcAddress:"0xabcd"}},
 {outputDirectory:"release"},
 {outputDirectory:"/tmp/release/"},
 {outputDirectory:"/tmp/other/../release"},
 {artifactPath:"artifact.json"},
 {nodeUrl:"ws://node.example"},
 {nodeUrl:"not a url"},
 {nodeUrl:"https://node.example\n/x"},
 {nodeUrl:"https://user:secret@node.example"},
 {initialize:false,initializerName:"constructor"},
 {initializerName:"1bad"},
 {args:[{nested:true}]},
 {args:[null]},
 {args:["--from"]},
 {args:[-5]},
 {args:[-0]},
 {args:[1.5]},
 {args:[1e22]},
 {args:[2**53]},
 {args:["a\u0007b"]},
 {account:"-x"},
 {account:"alice\nbob"},
 {contractAlias:"to\tken"},
 {contractAlias:"--alias"},
 {unexpected:true},
])("rejects invalid release arguments %j before any work",async patch=>{
 const args={operation:"package",buildJobId:"build",artifactPath:"/tmp/artifact.json",installationRoot:"/opt/aztec",nodeExecutable:"/opt/node",outputDirectory:"/tmp/release",args:[],initialize:true,account:"alice",fee:{method:"fee_juice"},nodeUrl:"http://localhost:8080",...patch};
 await expect(boundary.callTool("aztec_dev_release",args)).rejects.toMatchObject({code:-32602});
 expect(validateRuntime).not.toHaveBeenCalled();
});
it("renders the deploy script exactly as the checked-in fixture",async()=>{
 expect(renderDeployScript(baseManifest)).toBe(await readFile(scriptFixture,"utf8"));
});
it("single-quotes every input value and escapes embedded quotes",()=>{
 const hostile=`it's $HOME "x" ; rm -rf /`;
 const script=renderDeployScript(withDeployment({args:[hostile,"back\\slash"],account:"o'brien"}));
 expect(script).toContain(`--args 'it'\\''s $HOME "x" ; rm -rf /' 'back\\slash' \\\n`);
 expect(script).toContain(`ACCOUNT='o'\\''brien'\n`);
 expect(script.split("\n").filter(line=>line.includes("rm -rf")).every(line=>line.includes(`'it'\\''s $HOME "x" ; rm -rf /'`))).toBe(true);
});
it("chooses the initializer flag from the initialize setting and name",()=>{
 const none=renderDeployScript(withDeployment({initialize:false,initializerName:undefined}));
 expect(none).toContain("  --no-init \\\n");expect(none).not.toContain("--init");
 const named=renderDeployScript(withDeployment({initializerName:"set up"}));
 expect(named).toContain("  --init 'set up' \\\n");expect(named).not.toContain("--no-init");
 const neither=renderDeployScript(withDeployment({initializerName:undefined}));
 expect(neither).not.toContain("--init");expect(neither).not.toContain("--no-init");
});
it("omits --args for an empty list and renders numbers and booleans with String",()=>{
 expect(renderDeployScript(withDeployment({args:[]}))).not.toContain("--args");
 expect(renderDeployScript(withDeployment({args:[7,false]}))).toContain("  --args '7' 'false' \\\n");
});
it("renders the fee_juice payment string",()=>{
 expect(renderDeployScript({...baseManifest,fee:{method:"fee_juice"}})).toContain("PAYMENT='method=fee_juice'\n");
});
it.skipIf(spawnSync("bash",["--version"]).error!==undefined)("renders a script that bash parses without running it",()=>{
 expect(spawnSync("bash",["-n",scriptFixture]).status).toBe(0);
});
it.each(["deploy.sh","CHECKLIST.md"])("removes the written files and the directory when the write of %s fails, and rethrows the original error",async name=>{
 const f=await fixture();const failure=new Error("disk full");
 const write=vi.fn(async(path:string,content:string,mode:number)=>{
  if(path.endsWith(name))throw failure;
  await writeFile(path,content,{mode});
 });
 const service=new ReleaseService(f.validator,f.jobs,()=>new Date(generatedAt),write);
 await expect(service.package(f.input)).rejects.toBe(failure);
 expect(write).toHaveBeenCalledTimes(name==="deploy.sh"?2:3);
 await absent(f.outputDirectory);
});
it("renders the checklist exactly as the checked-in fixture",async()=>{
 const text=renderChecklist({...baseManifest,toolchain:{...baseManifest.toolchain,cli:{...baseManifest.toolchain.cli,identity:"v6.0.0-rc.3"}}},"/work/release/deploy.sh");
 expect(text).toBe(await readFile(checklistFixture,"utf8"));
});
it("renders the fee_juice checklist without a sponsor address and says unknown for a missing CLI identity",()=>{
 const text=renderChecklist({...baseManifest,fee:{method:"fee_juice"}},"/work/release/deploy.sh");
 expect(text).toContain("fee juice");expect(text).not.toContain(fpcAddress);expect(text).not.toContain("sponsor");
 expect(text).toContain("`unknown`");
 expect(text).toContain("create-account --node-url 'https://node.example:8080' --alias 'alice' --payment 'method=fee_juice'\n");
});
it("single-quotes every checklist command value so hostile input stays one inert word",()=>{
 const text=renderChecklist(withDeployment({nodeUrl:"https://node.example/x; rm -rf ~ #",account:"o'brien"}),"/work/release/deploy.sh");
 const commands=text.split("```bash\n").slice(1).map(block=>block.slice(0,block.indexOf("   ```")).split("\n").filter(Boolean)).flat();
 expect(commands).toHaveLength(6);
 for(const line of commands)expect(line.replace(/'[^']*'|\\'/g,"")).not.toMatch(/rm -rf|brien/);
 expect(text).toContain("   curl -s -X POST 'https://node.example/x; rm -rf ~ #' -H ");
 expect(text).toContain("create-account --node-url 'https://node.example/x; rm -rf ~ #' --alias 'o'\\''brien' --payment ");
 expect(text.split("\n").filter(line=>line.includes("rm -rf")).every(line=>line.includes("'https://node.example/x; rm -rf ~ #'"))).toBe(true);
});
it("refuses to render a script with a value that could be read as an option, a control character or a newline in the timestamp",()=>{
 expect(()=>renderDeployScript(withDeployment({args:["-5"]}))).toThrow("invalid-script-value");
 expect(()=>renderDeployScript(withDeployment({args:[-5]}))).toThrow("invalid-script-value");
 expect(()=>renderDeployScript(withDeployment({account:"-x"}))).toThrow("invalid-script-value");
 expect(()=>renderDeployScript(withDeployment({contractAlias:"--alias"}))).toThrow("invalid-script-value");
 expect(()=>renderDeployScript(withDeployment({args:["line\nbreak"]}))).toThrow("invalid-script-value");
 expect(()=>renderDeployScript(withDeployment({initializerName:"set\tup"}))).toThrow("invalid-script-value");
 expect(()=>renderDeployScript({...baseManifest,generatedAt:"2026-10-21T12:00:00Z\nrm -rf /"})).toThrow("invalid-script-value");
});
it("renders every file before it creates the output directory",async()=>{
 const f=await fixture();const write=vi.fn();
 const service=new ReleaseService(f.validator,f.jobs,()=>new Date(generatedAt),write);
 await expect(service.package({...f.input,account:"-x"})).rejects.toMatchObject({code:"invalid-script-value"});
 expect(write).not.toHaveBeenCalled();
 await absent(f.outputDirectory);
});
