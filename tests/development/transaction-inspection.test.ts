import {expect,it,vi} from 'vitest';
import {inspectTransaction} from '../../src/development/deployment-operations.js';
it('projects bounded public effects without exposing private logs',async()=>{
 const txHash='0x'+'01'.repeat(32);
 const getTxReceipt=vi.fn(async()=>({status:'proposed',executionResult:'success',blockNumber:5,txEffect:{noteHashes:[1n],nullifiers:[2n],l2ToL1Msgs:[],publicDataWrites:[{leafSlot:3n,value:4n}],privateLogs:[{private:'not-returned'}],contractClassLogs:[],publicLogs:[{contractAddress:'0xcontract',fields:Array.from({length:300},()=>5n)}]}}));
 const context:any={node:{getTxReceipt},network:{rollupVersion:1},loadModule:async()=>({TxHash:{fromString:(value:string)=>value}})};
 const result=await inspectTransaction({txHash,includeEffects:true},context);
 expect(result).toMatchObject({effects:{publicDataWrites:[{slot:'3',value:'4'}],privateLogCount:1},events:{truncated:true,privateEvents:'not-enumerated'}});
 expect(JSON.stringify(result)).not.toContain('not-returned');expect((result.events as any).public[0].fields).toHaveLength(256);
 expect(getTxReceipt).toHaveBeenCalledWith(txHash,{includeTxEffect:true});
});
