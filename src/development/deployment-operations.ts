import { classifyReceipt } from "./transaction-journal.js";
import {randomUUID} from "node:crypto";
import type {RuntimeContext,registerRuntimeOperation} from "./runtime-worker.js";
import type {RuntimeOperations} from "./session.js";
import {loadArtifact,saveArtifactSnapshot,recordContractAssociation,type LoadedArtifact} from "./contract-operations.js";
import {prepareFunctionArguments,resolveCallAccount,contractAssertion} from "./call-operations.js";
import type {TransactionReceipt} from "./transactions.js";
import {observeSubmission} from "./submission.js";
export const DEPLOYMENT_ERROR_MESSAGES:Record<string,string>={
 "stale-artifact":"The selected build artifact has changed; compile again before deployment.",
 "invalid-initializer":"Select an initializer from the compiled contract ABI and provide its exact arguments.",
 "invalid-deployment":"Deployment requires an explicit initialization choice.",
 "unknown-preparation":"The prepared deployment is absent or has already been submitted; no operation was replayed.",
 "deployment-send-failed":"Deployment submission did not return a transaction hash; reconcile the job before starting another deployment.",
 "deployment-not-included":"The deployment is not successfully included and cannot be recorded as deployed.",
 "invalid-transaction-hash":"Provide a valid 32-byte transaction hash.",
};
function fail(code:string):never{throw Object.assign(new Error(DEPLOYMENT_ERROR_MESSAGES[code]),{code});}
interface Pending {method:any;instance:any;selected:LoadedArtifact;account:any;initializer?:any;initialize:boolean;submitted:boolean;createdAt:number;txHash?:string}
const pending=new Map<string,Pending>();
export async function prepareDeployment(input:RuntimeOperations["deployment-prepare"]["input"],context:RuntimeContext):Promise<RuntimeOperations["deployment-prepare"]["output"]>{
 if(typeof input.initialize!=="boolean")fail("invalid-deployment");
 const selected=await loadArtifact(context,input.artifactPath);
 selected.provenanceHash=input.provenanceHash;
 if(selected.contentHash!==input.expectedContentHash)fail("stale-artifact");
 const account=await resolveCallAccount(context,input.account);
 const {getAllFunctionAbis}=await context.loadModule("@aztec-labs/stdlib/abi");
 const initializers=getAllFunctionAbis(selected.artifact).filter((fn:any)=>fn.isInitializer);
 const initializer=input.initializerName?initializers.find((fn:any)=>fn.name===input.initializerName):initializers.find((fn:any)=>fn.name==="constructor")??(initializers.length===1?initializers[0]:undefined);
 if((input.initializerName && !initializer) || (!initializer && (input.initialize || input.arguments.length)))fail("invalid-initializer");
 const args=initializer?await prepareFunctionArguments(context,initializer,input.arguments):[];
 const {Contract}=await context.loadModule("@aztec-labs/aztec.js/contracts");
 const method=Contract.deploy(context.wallet,selected.artifact,args,initializer?.name,{deployer:account});
 const instance=await method.getInstance();
 if(instance.currentContractClassId.toString()!==selected.classId)fail("stale-artifact");
 await saveArtifactSnapshot(context,selected);
 for(const [key,value] of pending)if(Date.now()-value.createdAt>600000)pending.delete(key);
 if(pending.size>=100)fail("unknown-preparation");
 const preparedId=randomUUID();pending.set(preparedId,{method,instance,selected,account,initializer,initialize:input.initialize,submitted:false,createdAt:Date.now()});
 return {preparedId,address:instance.address.toString(),artifact:{path:selected.path,contentHash:selected.contentHash,provenanceHash:input.provenanceHash,contractName:selected.contractName},registered:false};
}
async function submitDeployment(input:{preparedId:string},context:RuntimeContext){
 const prepared=pending.get(input.preparedId);if(!prepared || prepared.submitted)fail("unknown-preparation");
 prepared.submitted=true;
 const outcome=await observeSubmission(context,
  ()=>prepared.method.send({from:prepared.account,wait:"NO_WAIT",skipInitialization:!prepared.initialize}),
  error=>prepared.initializer?contractAssertion(error,prepared.initializer):undefined);
 prepared.txHash=outcome.txHash;
 return {address:prepared.instance.address.toString(),registered:outcome.submitted,...outcome};
}
export async function inspectTransaction(input:{txHash:string;includeEffects?:boolean},context:RuntimeContext):Promise<TransactionReceipt>{
 if(!/^0x[0-9a-fA-F]{64}$/.test(input.txHash))fail("invalid-transaction-hash");
 const {TxHash}=await context.loadModule("@aztec-labs/stdlib/tx");
 const receipt=await context.node.getTxReceipt(TxHash.fromString(input.txHash),{includeTxEffect:input.includeEffects===true});
 const effect=receipt.txEffect;
 const fields=(values:any[])=>values.slice(0,256).map(value=>value.toString());
 const effects=effect?{noteHashes:fields(effect.noteHashes),nullifiers:fields(effect.nullifiers),l2ToL1Messages:fields(effect.l2ToL1Msgs),publicDataWrites:effect.publicDataWrites.slice(0,256).map((value:any)=>({slot:value.leafSlot.toString(),value:value.value.toString()})),privateLogCount:effect.privateLogs.length,contractClassLogCount:effect.contractClassLogs.length,source:"node",scope:"public",truncated:[effect.noteHashes,effect.nullifiers,effect.l2ToL1Msgs,effect.publicDataWrites].some(values=>values.length>256)}:undefined;
 const events=effect?{public:effect.publicLogs.slice(0,64).map((value:any)=>({contractAddress:value.contractAddress.toString(),fields:fields(value.fields),encoding:"raw-fields"})),scope:"public",decoded:false,privateEvents:"not-enumerated",truncated:effect.publicLogs.length>64 || effect.publicLogs.some((value:any)=>value.fields.length>256)}:undefined;
 return {txHash:input.txHash,status:String(receipt.status),executionResult:receipt.executionResult===undefined?undefined:String(receipt.executionResult),blockNumber:receipt.blockNumber===undefined?undefined:Number(receipt.blockNumber),blockHash:receipt.blockHash?.toString(),transactionFee:receipt.transactionFee?.toString(),error:typeof receipt.error==="string"?receipt.error.slice(0,1024):undefined,observedAt:new Date().toISOString(),network:context.network,effects,events,source:"node",scope:"public"};
}
async function completeDeployment(input:{preparedId:string;txHash:string},context:RuntimeContext){
 const prepared=pending.get(input.preparedId);if(!prepared || prepared.txHash!==input.txHash)fail("unknown-preparation");
 const receipt=await inspectTransaction({txHash:input.txHash},context);
 if(classifyReceipt(input.txHash, receipt) !== "included")fail("deployment-not-included");
 const observedBlock=await context.node.getBlockNumber();const instance=await context.node.getContract(prepared.instance.address,observedBlock);
 if(!instance || instance.currentContractClassId.toString()!==prepared.selected.classId)fail("deployment-not-included");
 const metadata=await context.wallet.getContractMetadata(prepared.instance.address);
 if(!metadata.instance)await context.wallet.registerContract(instance,prepared.selected.artifact);
 await recordContractAssociation(context,instance.address.toString(),prepared.selected,observedBlock);
 return {address:instance.address.toString(),registered:true,published:true,initialized:prepared.initialize};
}
export function installDeploymentOperations(register:typeof registerRuntimeOperation){
 register("deployment-prepare",prepareDeployment);register("deployment-submit",submitDeployment);register("deployment-complete",completeDeployment);register("transaction-receipt",inspectTransaction);
 register("deployment-discard",async(input)=>{pending.delete(input.preparedId);return{discarded:true};});
}
