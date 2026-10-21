import {randomUUID} from "node:crypto";
import type {RuntimeContext,registerRuntimeOperation} from "./runtime-worker.js";
import type {RuntimeOperations} from "./session.js";
import {loadRegisteredContract} from "./contract-operations.js";
import {prepareFunctionArguments,resolveCallAccount,selectCallFunction,contractAssertion} from "./call-operations.js";
import type {SubmissionOutcome} from "./transactions.js";
import {observeSubmission} from "./submission.js";
export const SEND_ERROR_MESSAGES:Record<string,string>={
 "invalid-send-function":"Send requires a state-changing public or private function; use view/simulate for utility or static functions.",
 "unknown-send-preparation":"The prepared call is absent or already submitted; it was not replayed.",
};
interface PendingSend {interaction:any;account:any;address:string;abi:any;submitted:boolean;createdAt:number}
const prepared=new Map<string,PendingSend>();
function fail(code:string):never{throw Object.assign(new Error(SEND_ERROR_MESSAGES[code]),{code});}
async function prepare(input:RuntimeOperations["send-prepare"]["input"],context:RuntimeContext):Promise<RuntimeOperations["send-prepare"]["output"]>{
 const loaded=await loadRegisteredContract(context,input.address);
 if(loaded.association.artifact.contentHash!==input.expectedContentHash)throw Object.assign(new Error("Registered artifact changed."),{code:"artifact-changed"});
 const abi=await selectCallFunction(context,loaded.artifact,input.functionName);
 if(abi.functionType==="utility" || abi.isStatic===true)fail("invalid-send-function");
 const args=await prepareFunctionArguments(context,abi,input.args);const account=await resolveCallAccount(context,input.account);
 const {Contract}=await context.loadModule("@aztec-labs/aztec.js/contracts");
 const contract=await Contract.at(loaded.address,loaded.artifact,context.wallet);const interaction=contract.methods[abi.name](...args);
 await interaction.request();
 for(const [key,value] of prepared)if(Date.now()-value.createdAt>600000)prepared.delete(key);
 if(prepared.size>=100)fail("unknown-send-preparation");
 const preparedId=randomUUID();prepared.set(preparedId,{interaction,account,address:loaded.address.toString(),abi,submitted:false,createdAt:Date.now()});
 return {preparedId,address:loaded.address.toString(),artifact:loaded.association.artifact,registered:true};
}
async function submit(input:{preparedId:string},context:RuntimeContext):Promise<SubmissionOutcome>{
 const pending=prepared.get(input.preparedId);if(!pending || pending.submitted)fail("unknown-send-preparation");pending.submitted=true;
 const outcome=await observeSubmission(context,
  ()=>pending.interaction.send({from:pending.account,wait:"NO_WAIT"}),
  error=>contractAssertion(error,pending.abi));
 return {address:pending.address,registered:true,...outcome};
}
export function installSendOperations(register:typeof registerRuntimeOperation){
 register("send-prepare",prepare);register("send-submit",submit);register("send-discard",async input=>{prepared.delete(input.preparedId);return{discarded:true};});
}
