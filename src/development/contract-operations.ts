import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { RuntimeContext, registerRuntimeOperation } from "./runtime-worker.js";
import type { ContractAssociation, ContractInspection, ContractInspectionInput, ContractRegistrationInput, ContractRegistrationResult, RegisteredArtifact } from "./contracts.js";

export const CONTRACT_ERROR_MESSAGES: Record<string, string> = {
  "invalid-contract-address": "Provide a valid 32-byte Aztec address.",
  "invalid-artifact-path": "Provide an absolute artifact JSON path.",
  "artifact-unavailable": "The selected artifact is missing, unreadable, or exceeds the 64 MiB limit.",
  "invalid-artifact": "The selected JSON does not contain a valid compiled Aztec contract artifact.",
  "artifact-mismatch": "The artifact class does not match the contract's current deployed class.",
  "artifact-changed": "This deployment already has a different artifact association. Rebuilding never replaces it automatically.",
  "unknown-deployment": "The node has no published instance at this address; registration requires a known deployed instance.",
  "missing-registration": "Register this contract and artifact with the active wallet before using it.",
  "registration-store-corrupt": "The persisted artifact association or snapshot is inconsistent; inspect or reset this session's state.",
};
function fail(code: string): never { throw Object.assign(new Error(CONTRACT_ERROR_MESSAGES[code]), { code }); }
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

async function addressValue(context: RuntimeContext, value: string) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) fail("invalid-contract-address");
  const { AztecAddress } = await context.loadModule("@aztec-labs/aztec.js/addresses");
  try {
    const address = AztecAddress.fromStringUnsafe(value);
    if (!await address.isValid()) fail("invalid-contract-address");
    return address;
  } catch { return fail("invalid-contract-address"); }
}

async function artifactBytes(path: string) {
  if (typeof path !== "string" || !isAbsolute(path)) fail("invalid-artifact-path");
  try {
    const canonical = await realpath(path);
    const info = await stat(canonical);
    if (!info.isFile() || info.size > MAX_ARTIFACT_BYTES) fail("artifact-unavailable");
    const bytes = await readFile(canonical);
    if (bytes.length > MAX_ARTIFACT_BYTES) fail("artifact-unavailable");
    return { path: canonical, bytes, contentHash: digest(bytes) };
  } catch { return fail("artifact-unavailable"); }
}

async function parseArtifact(context: RuntimeContext, bytes: Buffer) {
  const { loadContractArtifact, contractArtifactFromBuffer, contractArtifactToBuffer } = await context.loadModule("@aztec-labs/stdlib/abi");
  const { getContractClassFromArtifact } = await context.loadModule("@aztec-labs/stdlib/contract");
  try {
    // The schema validates serialized fields, not the Fr/Buffer instances returned by the loader.
    const artifact = contractArtifactFromBuffer(contractArtifactToBuffer(loadContractArtifact(JSON.parse(bytes.toString("utf8")))));
    const contractClass = await getContractClassFromArtifact(artifact);
    return { artifact, classId: contractClass.id.toString(), contractName: String(artifact.name).slice(0, 128) };
  } catch { return fail("invalid-artifact"); }
}

export interface LoadedArtifact {
  path: string; bytes: Buffer; contentHash: string; artifact: any; classId: string; contractName: string; provenanceHash?: string;
}

export async function loadArtifact(context: RuntimeContext, path: string): Promise<LoadedArtifact> {
  const selected = await artifactBytes(path);
  return { ...selected, ...await parseArtifact(context, selected.bytes) };
}

async function storageDirectory(context: RuntimeContext, name: string) {
  const path = join(context.stateDirectory, name);
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (await realpath(path) !== path) fail("registration-store-corrupt");
  return path;
}

async function associationFor(context: RuntimeContext, address: string): Promise<ContractAssociation | undefined> {
  const path = join(context.stateDirectory, "contract-associations", `${address}.json`);
  try {
    if (await realpath(path) !== path || (await stat(path)).size > 16384) fail("registration-store-corrupt");
    const value = JSON.parse(await readFile(path, "utf8"));
    if (value.schemaVersion !== 1 || value.address !== address ||
        !isAbsolute(value.artifact?.path ?? "") || !/^[a-f0-9]{64}$/.test(value.artifact?.contentHash ?? "") ||
        typeof value.artifact?.classId !== "string" || typeof value.artifact?.contractName !== "string") fail("registration-store-corrupt");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return fail("registration-store-corrupt");
  }
}

async function saveSnapshot(context: RuntimeContext, bytes: Buffer, contentHash: string) {
  const directory = await storageDirectory(context, "contract-artifacts");
  const path = join(directory, `${contentHash}.json`);
  try { await writeFile(path, bytes, { mode: 0o600, flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (await realpath(path) !== path || (await artifactBytes(path)).contentHash !== contentHash) fail("registration-store-corrupt");
  }
}

export async function saveArtifactSnapshot(context: RuntimeContext, selected: LoadedArtifact): Promise<void> {
  if (digest(selected.bytes) !== selected.contentHash) fail("registration-store-corrupt");
  await saveSnapshot(context, selected.bytes, selected.contentHash);
}

export async function recordContractAssociation(context: RuntimeContext, value: string, selected: LoadedArtifact, observedBlock: number): Promise<ContractAssociation> {
  const address = (await addressValue(context, value)).toString();
  const existing = await associationFor(context, address);
  if (existing && (existing.artifact.contentHash !== selected.contentHash || existing.artifact.classId !== selected.classId)) fail("artifact-changed");
  if (digest(selected.bytes) !== selected.contentHash) fail("registration-store-corrupt");
  await saveSnapshot(context, selected.bytes, selected.contentHash);
  const association: ContractAssociation = existing ?? {
    schemaVersion: 1, address,
    artifact: { path: selected.path, contentHash: selected.contentHash, classId: selected.classId, contractName: selected.contractName, ...(selected.provenanceHash ? { provenanceHash: selected.provenanceHash } : {}) },
    registeredAt: new Date().toISOString(), registeredAtBlock: observedBlock,
  };
  const directory = await storageDirectory(context, "contract-associations");
  const temporary = join(directory, `${address}.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(association), { mode: 0o600, flag: "wx" });
  await rename(temporary, join(directory, `${address}.json`));
  return association;
}

async function storedArtifact(context: RuntimeContext, association: ContractAssociation) {
  const path = join(context.stateDirectory, "contract-artifacts", `${association.artifact.contentHash}.json`);
  try {
    if (await realpath(path) !== path) fail("registration-store-corrupt");
    const loaded = await artifactBytes(path);
    if (loaded.contentHash !== association.artifact.contentHash) fail("registration-store-corrupt");
    const parsed = await parseArtifact(context, loaded.bytes);
    if (parsed.classId !== association.artifact.classId) fail("registration-store-corrupt");
    return parsed.artifact;
  } catch { return fail("registration-store-corrupt"); }
}

async function walletState(context: RuntimeContext, address: any, instance: any) {
  const metadata = await context.wallet.getContractMetadata(address);
  const contractClass = instance ? await context.wallet.getContractClassMetadata(instance.currentContractClassId) : undefined;
  return {
    instanceRegistered: !!metadata.instance,
    artifactRegistered: contractClass?.isArtifactRegistered === true,
    classPublished: contractClass?.isContractClassPubliclyRegistered === true,
    initializationStatus: metadata.initializationStatus === undefined ? undefined : String(metadata.initializationStatus).slice(0, 64),
  };
}

export async function registerContract(input: ContractRegistrationInput, context: RuntimeContext): Promise<ContractRegistrationResult> {
  const address = await addressValue(context, input.address);
  const canonical = address.toString();
  const selected = await artifactBytes(input.artifactPath);
  const existing = await associationFor(context, canonical);
  if (existing && existing.artifact.contentHash !== selected.contentHash) fail("artifact-changed");
  const observedBlock = await context.node.getBlockNumber();
  const instance = await context.node.getContract(address, observedBlock);
  if (!instance) fail("unknown-deployment");
  const parsed = existing
    ? { artifact: await storedArtifact(context, existing), classId: existing.artifact.classId, contractName: existing.artifact.contractName }
    : await parseArtifact(context, selected.bytes);
  if (parsed.classId !== instance.currentContractClassId.toString()) fail("artifact-mismatch");
  const current = await walletState(context, address, instance);
  const reused = !!existing && current.instanceRegistered && current.artifactRegistered;
  const artifact: RegisteredArtifact = existing?.artifact ?? {
    path: selected.path, contentHash: selected.contentHash, classId: parsed.classId, contractName: parsed.contractName,
  };
  if (!reused) {
    await saveSnapshot(context, selected.bytes, selected.contentHash);
    await context.wallet.registerContract(instance, parsed.artifact);
    await recordContractAssociation(context, canonical, { ...selected, ...parsed }, observedBlock);
  }
  return { address: canonical, registered: true, reused, artifact, observedBlock, source: "wallet", chainTransactionSubmitted: false };
}

export async function inspectContract(input: ContractInspectionInput, context: RuntimeContext): Promise<ContractInspection> {
  const address = await addressValue(context, input.address);
  const canonical = address.toString();
  const association = await associationFor(context, canonical);
  const observedBlock = await context.node.getBlockNumber();
  const instance = await context.node.getContract(address, observedBlock);
  const problems: ContractInspection["problems"] = [];
  if (!instance) problems.push("unknown-deployment");
  const path = input.artifactPath ?? association?.artifact.path;
  let artifact: RegisteredArtifact | undefined;
  let localStatus: ContractInspection["localArtifact"]["status"] = "unavailable";
  if (path) {
    try {
      const loaded = await artifactBytes(path);
      const parsed = await parseArtifact(context, loaded.bytes);
      artifact = { path: loaded.path, contentHash: loaded.contentHash, classId: parsed.classId, contractName: parsed.contractName };
      localStatus = association && association.artifact.contentHash !== loaded.contentHash ? "changed" : "available";
      if (localStatus === "changed") problems.push("artifact-changed");
      if (instance && parsed.classId !== instance.currentContractClassId.toString()) problems.push("artifact-mismatch");
    } catch (error) {
      if (!["artifact-unavailable", "invalid-artifact"].includes((error as { code?: string }).code ?? "")) throw error;
    }
  }
  if (!artifact) problems.push("artifact-unavailable");
  if (association && instance && association.artifact.classId !== instance.currentContractClassId.toString() && !problems.includes("artifact-mismatch")) problems.push("artifact-mismatch");
  const wallet = await walletState(context, address, instance);
  if (!association || !wallet.instanceRegistered || !wallet.artifactRegistered) problems.push("missing-registration");
  const observedThroughBlock = await context.node.getBlockNumber();
  return {
    address: canonical, ready: problems.length === 0, problems, association, artifact,
    localArtifact: { source: "filesystem", status: localStatus, path },
    node: { source: "node", observedBlock, blockPinned: true, published: !!instance,
      currentClassId: instance?.currentContractClassId.toString(), originalClassId: instance?.originalContractClassId.toString() },
    wallet: { source: "wallet-and-node", observedFromBlock: observedBlock, observedThroughBlock, ...wallet },
  };
}

export async function loadRegisteredContract(context: RuntimeContext, value: string) {
  const address = await addressValue(context, value);
  const association = await associationFor(context, address.toString());
  if (!association) fail("missing-registration");
  const observedBlock = await context.node.getBlockNumber();
  const instance = await context.node.getContract(address, observedBlock);
  if (!instance) fail("unknown-deployment");
  if (instance.currentContractClassId.toString() !== association.artifact.classId) fail("artifact-mismatch");
  const metadata = await walletState(context, address, instance);
  if (!metadata.instanceRegistered || !metadata.artifactRegistered) fail("missing-registration");
  return { address, association, artifact: await storedArtifact(context, association), instance, observedBlock };
}

export function installContractOperations(register: typeof registerRuntimeOperation) {
  register("contract-register", registerContract);
  register("contract-inspect", inspectContract);
}
