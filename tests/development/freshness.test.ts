import {afterEach,expect,it} from "vitest";
import {writeFile,unlink} from "node:fs/promises";
import {join} from "node:path";
import {assertFreshArtifact} from "../../src/development/freshness.js";
import {buildFixture,type BuildFixtureOptions,type Cleanups} from "./build-fixture.js";
const cleanups:Cleanups=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup();});
async function fixture(options?:BuildFixtureOptions){
 const f=await buildFixture(cleanups,{contractName:"Fixture",...options});
 return {...f,args:{jobs:f.jobs,buildJobId:f.buildJobId,artifactPath:f.path,runtime:f.runtime}};
}
it("returns the artifact and build fields for a fresh build",async()=>{
 const {args,project,path,provenanceHash}=await fixture();
 const fresh=await assertFreshArtifact({...args,projectPath:project});
 expect(fresh).toMatchObject({artifact:{path,provenanceHash},projectPath:project,kind:"compile"});
});
it("reports an unknown job",async()=>{
 const {args}=await fixture();
 await expect(assertFreshArtifact({...args,buildJobId:"missing"})).rejects.toMatchObject({code:"invalid-build",message:expect.stringContaining("Unknown build job")});
});
it("rejects an incomplete job",async()=>{
 const {args}=await fixture({complete:false});
 await expect(assertFreshArtifact(args)).rejects.toMatchObject({code:"invalid-build",message:expect.stringContaining("not a completed compile or test job")});
});
it("rejects a job of the wrong kind",async()=>{
 const {args}=await fixture({kind:"other"});
 await expect(assertFreshArtifact(args)).rejects.toThrow("invalid-build");
});
it("rejects a runtime whose paths differ from the build",async()=>{
 const {args,runtime}=await fixture();
 const message=expect.stringContaining("different installation or Node executable");
 await expect(assertFreshArtifact({...args,runtime:{...runtime,runtimeNode:{...runtime.runtimeNode,path:"/other/node"}}})).rejects.toMatchObject({code:"invalid-build",message});
 await expect(assertFreshArtifact({...args,runtime:{...runtime,installationRoot:"/other"}})).rejects.toMatchObject({code:"invalid-build",message});
});
it("rejects an expected project path that differs from the build",async()=>{
 const {args}=await fixture();
 await expect(assertFreshArtifact({...args,projectPath:"/elsewhere"})).rejects.toMatchObject({code:"invalid-build",message:expect.stringContaining("different project")});
});
it("rejects an artifact that is not in the job",async()=>{
 const {args,project}=await fixture();const other=join(project,"other.json");await writeFile(other,"{}");
 await expect(assertFreshArtifact({...args,artifactPath:other})).rejects.toMatchObject({code:"stale-artifact"});
});
it("rejects changed artifact bytes",async()=>{
 const {args,path}=await fixture();await writeFile(path,JSON.stringify({name:"Rebuilt",functions:[]}));
 await expect(assertFreshArtifact(args)).rejects.toThrow("stale-artifact");
});
it("rejects a changed source file",async()=>{
 const {args,project}=await fixture();await writeFile(join(project,"Nargo.toml"),'[package]\nname="changed"\ntype="contract"');
 await expect(assertFreshArtifact(args)).rejects.toMatchObject({code:"stale-artifact"});
});
it("rejects a deleted artifact file",async()=>{
 const {args,path}=await fixture();await unlink(path);
 await expect(assertFreshArtifact(args)).rejects.toMatchObject({code:"stale-artifact"});
 await expect(assertFreshArtifact({...args,artifactPath:join(path,"child.json")})).rejects.toMatchObject({code:"stale-artifact"});
});
