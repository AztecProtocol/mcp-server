import {mkdtemp,mkdir,writeFile,realpath,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {Jobs} from "../../src/development/jobs.js";
import {hash,projectProvenance} from "../../src/development/artifacts.js";
import type {ToolchainReport} from "../../src/development/toolchain.js";
export type Cleanups=Array<()=>Promise<void>>;
export interface BuildFixtureOptions{contractName?:string;runtime?:Partial<ToolchainReport>;kind?:"compile"|"test"|"other";complete?:boolean}
export async function buildFixture(cleanups:Cleanups,{contractName="Token",runtime:overrides={},kind="compile",complete=true}:BuildFixtureOptions={}){
 const root=await realpath(await mkdtemp(join(tmpdir(),"mcp-build-fixture-")));const project=join(root,"project");await mkdir(project);const jobs=new Jobs();
 cleanups.push(async()=>{await jobs.close();await rm(root,{recursive:true,force:true});});
 await writeFile(join(project,"Nargo.toml"),'[package]\nname="fixture"\ntype="contract"');
 const path=join(project,"artifact.json");const artifact=JSON.stringify({name:contractName,functions:[]});await writeFile(path,artifact);
 const runtime:ToolchainReport={target:"fixture",installationRoot:"/opt/aztec",supported:true,runtimeNode:{path:"/opt/node",version:"v24.0.0"},cli:{path:"/opt/aztec/bin/aztec",identity:"v6.0.0-rc.3"},compiler:{identity:"fixture"},packages:[],publicExports:[],provenance:{sourceIdentity:"unverified"},diagnostics:[],...overrides};
 const toolchain={installationRoot:runtime.installationRoot,nodeExecutable:runtime.runtimeNode.path};
 const selection={operation:"compile"};const provenanceHash=await projectProvenance(project,runtime,selection);const contentHash=hash(artifact);
 const build=jobs.start(kind,async()=>{if(!complete)throw new Error("boom");return {projectPath:project,operation:"compile",selection,toolchain,provenanceHash,artifacts:[{path,contentHash,provenanceHash,contractName}]};});await jobs.wait(build.id);
 return {root,project,jobs,runtime,toolchain,path,provenanceHash,contentHash,buildJobId:build.id};
}
