import { isAbsolute } from "node:path";
import { SessionError, type SessionService } from "./session.js";

export interface ContractInput { address: string }
export interface ContractRegistrationInput extends ContractInput { artifactPath: string }
export interface ContractInspectionInput extends ContractInput { artifactPath?: string }

export interface ContractCallInput extends ContractInput {
  functionName: string; args: unknown[]; account: string; minimumBlock?: number;
}
export interface ContractCallResult {
  operation: "simulate" | "view"; status: "succeeded" | "failed";
  address: string; functionName: string; functionType: string; artifact: RegisteredArtifact;
  accountScope: [string]; result: unknown; dataStatus: "available" | "no-return" | "unavailable";
  observedBlock: number; observedThroughBlock: number; observedAt: string;
  freshness: { cached: false; status: "sdk-synchronized" | "unavailable"; synchronizedThroughBlock?: number; blockHash?: string; exactExecutionBlock: false; minimumBlock?: number };
  chainTransactionSubmitted: false; proofMode: "fast" | "real"; proofValidityEstablished: false;
  error?: { code: "simulation-failed" | "result-unavailable" | "freshness-unavailable"; phase: "simulation" | "verification"; message: string; contractAssertion?: string };
}

export interface RegisteredArtifact { path: string; contentHash: string; classId: string; contractName: string; provenanceHash?: string }
export interface ContractAssociation {
  schemaVersion: 1; address: string; artifact: RegisteredArtifact;
  registeredAt: string; registeredAtBlock: number;
}
export interface ContractRegistrationResult {
  address: string; registered: true; reused: boolean; artifact: RegisteredArtifact;
  observedBlock: number; source: "wallet"; chainTransactionSubmitted: false;
}
export type ContractProblem = "unknown-deployment" | "artifact-unavailable" | "missing-registration" | "artifact-mismatch" | "artifact-changed";
export interface ContractInspection {
  address: string; ready: boolean; problems: ContractProblem[];
  association?: ContractAssociation;
  artifact?: RegisteredArtifact;
  localArtifact: { source: "filesystem"; status: "available" | "unavailable" | "changed"; path?: string };
  node: { source: "node"; observedBlock: number; blockPinned: true; published: boolean; currentClassId?: string; originalClassId?: string };
  wallet: {
    source: "wallet-and-node"; observedFromBlock: number; observedThroughBlock: number;
    instanceRegistered: boolean; artifactRegistered: boolean; classPublished: boolean;
    initializationStatus?: string;
  };
}

declare module "./session.js" {
  interface RuntimeOperations {
    "contract-simulate": { input: ContractCallInput; output: ContractCallResult };
    "contract-view": { input: ContractCallInput; output: ContractCallResult };
    "contract-register": { input: ContractRegistrationInput; output: ContractRegistrationResult };
    "contract-inspect": { input: ContractInspectionInput; output: ContractInspection };
  }
}

function validate(input: ContractInspectionInput) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.address)) throw new SessionError("invalid-contract-address", "Provide a 32-byte hexadecimal Aztec address.");
  if (input.artifactPath !== undefined && !isAbsolute(input.artifactPath)) throw new SessionError("invalid-artifact-path", "Provide an absolute artifact JSON path.");
}

/** Structured parent API; SDK objects stay inside the persistent worker. */
export class ContractService {
  constructor(private readonly sessions: SessionService) {}
  simulate(sessionId: string, input: ContractCallInput): Promise<ContractCallResult> {
    validateCallInput(input); return this.sessions.request(sessionId, "contract-simulate", input);
  }
  view(sessionId: string, input: ContractCallInput): Promise<ContractCallResult> {
    validateCallInput(input); return this.sessions.request(sessionId, "contract-view", input);
  }
  register(sessionId: string, input: ContractRegistrationInput): Promise<ContractRegistrationResult> {
    validate(input);
    if (!input.artifactPath) throw new SessionError("invalid-artifact-path", "Registration requires an artifact JSON path.");
    return this.sessions.request(sessionId, "contract-register", input);
  }
  inspect(sessionId: string, input: ContractInspectionInput): Promise<ContractInspection> {
    validate(input);
    return this.sessions.request(sessionId, "contract-inspect", input);
  }
}

export function validateCallInput(input: ContractCallInput): void {
  validate(input);
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.account)) throw new SessionError("invalid-account", "Select a wallet account by its 32-byte hexadecimal address.");
  if (typeof input.functionName !== "string" || !/^[A-Za-z_][A-Za-z_0-9]{0,127}$/.test(input.functionName)) throw new SessionError("invalid-function", "Select a named function from the registered artifact.");
  if (!Array.isArray(input.args)) throw new SessionError("invalid-abi-arguments", "args must be an array matching the function ABI.");
  if (input.minimumBlock !== undefined && (!Number.isSafeInteger(input.minimumBlock) || input.minimumBlock < 0)) throw new SessionError("invalid-minimum-block", "minimumBlock must be a nonnegative safe integer.");
}
