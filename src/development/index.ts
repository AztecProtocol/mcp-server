import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { isAbsolute, normalize, sep } from "node:path";
import { inspectToolchain } from "./toolchain.js";
import { BuildService, type BuildArguments } from "./build.js";
import { Jobs } from "./jobs.js";
import { SessionService, type SessionOpenOptions } from "./session.js";
import type { RuntimeValidator } from "./policy.js";
import { ContractService } from "./contracts.js";
import { TransactionService } from "./transactions.js";
import { RecoveryService } from "./recovery.js";
import { ReleaseService, scriptSafe, type PackageInput } from "./release.js";

export interface DevelopmentBoundary {
  listTools(): Tool[];
  callTool(name: string, args: Record<string, unknown> | undefined): Promise<CallToolResult>;
  shutdown?(): Promise<void>;
}
/** Validator injection is for code-owned integration harnesses, never MCP input or environment. */
export interface DevelopmentOptions { validateRuntime?: RuntimeValidator }
interface ArgumentDefinition {
  schema: Record<string, unknown>;
  validate(value: unknown, name: string): void;
}
type Fields = Record<string, ArgumentDefinition>;
function invalid(message: string): never { throw new McpError(ErrorCode.InvalidParams, message); }
function parameter(schema: Record<string, unknown>, accepts: (value: unknown) => boolean, expectation: string): ArgumentDefinition {
  return { schema, validate(value, name) { if (!accepts(value)) invalid(`${name} must be ${expectation}.`); } };
}
const string = parameter({ type: "string", minLength: 1 }, value => typeof value === "string" && value.length > 0, "a nonempty string");
const path = parameter(string.schema, value => typeof value === "string" && isAbsolute(value), "an absolute path");
const array = parameter({ type: "array" }, Array.isArray, "an array");
const boolean = parameter({ type: "boolean" }, value => typeof value === "boolean", "a boolean");
function integer(minimum: number, maximum?: number): ArgumentDefinition {
  return parameter(
    { type: "integer", minimum, ...(maximum === undefined ? {} : { maximum }) },
    value => typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && (maximum === undefined || value <= maximum),
    `a safe integer from ${minimum}${maximum === undefined ? " upwards" : ` to ${maximum}`}`,
  );
}
const timeout = integer(1, 1800000);
function pattern(regex: RegExp, expectation: string): ArgumentDefinition {
  return parameter({ type: "string", pattern: regex.source }, value => typeof value === "string" && regex.test(value), expectation);
}
const packageName = pattern(/^[A-Za-z0-9_][A-Za-z0-9_-]*$/, "a package name");
const testFilter = parameter(string.schema, value => typeof value === "string" && value.length > 0 && !value.startsWith("-"), "a test selection without flags");
function isCanonicalPath(value: unknown): boolean {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value) return false;
  return value === sep || !value.endsWith(sep);
}
const canonicalPath = parameter(string.schema, isCanonicalPath, "an absolute normalized path");
const hexAddress = pattern(/^0x[0-9a-fA-F]{64}$/, "a 0x hex address of 64 hex digits");
const identifier = pattern(/^[A-Za-z_][A-Za-z0-9_]*$/, "an identifier");
function isHttpUrl(value: unknown): boolean {
  if (typeof value !== "string" || /[\x00-\x1f\x7f]/.test(value)) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  return ["http:", "https:"].includes(url.protocol) && url.username === "" && url.password === "";
}
const httpUrl = parameter({ type: "string", format: "uri" }, isHttpUrl, "an http: or https: URL without credentials or control characters");
function isReleaseArgument(item: unknown): boolean {
  if (typeof item === "string") return scriptSafe(item);
  if (typeof item === "number") return Number.isSafeInteger(item) && item >= 0 && !Object.is(item, -0);
  return typeof item === "boolean";
}
const releaseArguments = parameter({ type: "array", items: { type: ["string", "number", "boolean"] } }, value => Array.isArray(value) && value.every(isReleaseArgument),
  "an array of constructor arguments that are strings not beginning with '-' and without control characters, non-negative safe integers or booleans");
const plainName = parameter(string.schema, value => typeof value === "string" && value.length > 0 && scriptSafe(value), "a nonempty string that does not begin with '-' and has no control characters");
const fee = refine(objectArguments({ method: parameter({ type: "string", enum: ["fee_juice", "fpc-sponsored"] }, value => value === "fee_juice" || value === "fpc-sponsored", '"fee_juice" or "fpc-sponsored"'), fpcAddress: hexAddress }, ["method"]), ({ method, fpcAddress }, name) => {
  if ((method === "fpc-sponsored") !== (fpcAddress !== undefined)) invalid(`${name}.fpcAddress is required for "fpc-sponsored" and rejected for "fee_juice".`);
});
const selection = { installationRoot: path, nodeExecutable: path };
const session = { sessionId: string };
function objectArguments(fields: Fields, required = Object.keys(fields)): ArgumentDefinition {
  return {
    schema: { type: "object", additionalProperties: false, properties: Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.schema])), required },
    validate(value, name) {
      if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${name} must be an object.`);
      const args = value as Record<string, unknown>;
      for (const key of Object.keys(args)) if (!Object.hasOwn(fields, key)) invalid(`Unexpected argument: ${name}.${key}.`);
      for (const key of required) if (!Object.hasOwn(args, key)) invalid(`${name}.${key} is required.`);
      for (const [key, field] of Object.entries(fields)) if (Object.hasOwn(args, key)) field.validate(args[key], `${name}.${key}`);
    },
  };
}
function operation(name: string, fields: Fields, required = Object.keys(fields)): ArgumentDefinition {
  const selector = parameter({ const: name, type: "string" }, value => value === name, `"${name}"`);
  return objectArguments({ operation: selector, ...fields }, ["operation", ...required]);
}
function refine(definition: ArgumentDefinition, check: (args: Record<string, unknown>, name: string) => void): ArgumentDefinition {
  return { schema: definition.schema, validate(value, name) { definition.validate(value, name); check(value as Record<string, unknown>, name); } };
}
const callFields = { ...session, address: string, functionName: string, args: array, account: string, minimumBlock: integer(0) };
const callRequired = ["sessionId", "address", "functionName", "args", "account"];
const proofFields = {
  proofMode: parameter({ type: "string", enum: ["fast", "real"] }, value => value === "fast" || value === "real", '"fast" or "real"'),
  proving: objectArguments({
    backend: parameter({ const: "NativeUnixSocket", type: "string" }, value => value === "NativeUnixSocket", '"NativeUnixSocket"'),
    crsPath: string, threads: integer(1, 16),
  }, ["backend", "crsPath"]),
};
const operations: Record<string, Record<string, ArgumentDefinition>> = {
  aztec_dev_inspect: {
    environment: operation("environment", selection),
    session: operation("session", session),
    accounts: operation("accounts", session),
    contract: operation("contract", { ...session, address: string, artifactPath: path }, ["sessionId", "address"]),
    transaction: operation("transaction", { ...session, txHash: string }),
  },
  aztec_dev_contract: {
    register: operation("register", { ...session, address: string, artifactPath: path }),
    simulate: operation("simulate", callFields, callRequired),
    view: operation("view", callFields, callRequired),
    send: operation("send", { ...session, address: string, functionName: string, args: array, account: string, timeoutMs: timeout }, callRequired),
    deploy: operation("deploy", { ...session, buildJobId: string, artifactPath: path, account: string, args: array, initialize: boolean, initializerName: string, timeoutMs: timeout }, ["sessionId", "buildJobId", "artifactPath", "account", "args", "initialize"]),
  },
  aztec_dev_build: {
    compile: operation("compile", { projectPath: path, ...selection, package: packageName, timeoutMs: timeout }, ["projectPath", ...Object.keys(selection)]),
    test: operation("test", { projectPath: path, ...selection, package: packageName, testFilter, timeoutMs: timeout }, ["projectPath", ...Object.keys(selection)]),
  },
  aztec_dev_job: {
    status: operation("status", { jobId: string }),
    logs: operation("logs", { jobId: string, offset: integer(0) }, ["jobId"]),
    cancel: operation("cancel", { jobId: string }),
    "list-persisted": operation("list-persisted", session),
    recover: operation("recover", { ...session, jobId: string }),
  },
  aztec_dev_release: {
    package: refine(operation("package", {
      buildJobId: string, artifactPath: path, ...selection, outputDirectory: canonicalPath, args: releaseArguments, initialize: boolean, initializerName: identifier,
      account: plainName, fee, nodeUrl: httpUrl, contractAlias: plainName,
    }, ["buildJobId", "artifactPath", ...Object.keys(selection), "outputDirectory", "args", "initialize", "account", "fee", "nodeUrl"]), (args, name) => {
      if (args.initialize === false && Object.hasOwn(args, "initializerName")) invalid(`${name}.initializerName is rejected when ${name}.initialize is false.`);
    }),
  },
  aztec_dev_session: {
    open: operation("open", { projectPath: path, ...selection, nodeUrl: string, ...proofFields }, ["projectPath", ...Object.keys(selection), "nodeUrl"]),
    switch: operation("switch", { ...session, projectPath: path, ...selection, nodeUrl: string, ...proofFields }, ["sessionId", "projectPath", ...Object.keys(selection), "nodeUrl"]),
    status: operation("status", session),
    close: operation("close", session),
    reset: operation("reset", session),
  },
};
function schema(name: string): Tool["inputSchema"] { return { type: "object", oneOf: Object.values(operations[name]).map(operation => operation.schema) }; }
function validate(name: string, args: Record<string, unknown> | undefined): asserts args is Record<string, unknown> {
  if (!args || typeof args.operation !== "string" || !Object.hasOwn(operations[name], args.operation)) invalid(`Unsupported operation for ${name}.`);
  operations[name][args.operation].validate(args, "arguments");
}
function result(value: unknown): CallToolResult {
  const structuredContent = value !== null && typeof value === "object" && !Array.isArray(value) ? { ...value } : { result: value };
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent };
}

export function createDevelopmentBoundary(options: DevelopmentOptions = {}): DevelopmentBoundary {
  const jobs = new Jobs();
  const builds = new BuildService(options.validateRuntime, jobs);
  const sessions = new SessionService(options.validateRuntime);
  const contracts = new ContractService(sessions);
  const transactions = new TransactionService(sessions, jobs);
  const recovery = new RecoveryService(sessions, jobs);
  const releases = new ReleaseService(options.validateRuntime, jobs);
  sessions.setLifecycleGuard(sessionId => { transactions.assertIdle(sessionId); recovery.assertIdle(sessionId); });
  const tools: Tool[] = [
    {
      name: "aztec_dev_inspect",
      description: "Inspect an explicitly selected installation or an active session's environment/accounts. Reports provenance and compatibility; never installs tools or provisions networks.",
      inputSchema: schema("aztec_dev_inspect"),
    },
    {
      name: "aztec_dev_contract",
      description: "Register, simulate, query, deploy or send contract calls in the active local session. Deployments and sends return tracked transaction jobs; views and simulations never submit transactions.",
      inputSchema: schema("aztec_dev_contract"),
    },
    {
      name: "aztec_dev_build",
      description: "Compile or run TXE-backed tests through a tracked job. Requires a validated runtime and no node or wallet session. Poll aztec_dev_job for results, diagnostics and logs.",
      inputSchema: schema("aztec_dev_build"),
    },
    {
      name: "aztec_dev_job",
      description: "Read a tracked job, retrieve bounded logs, cancel local waiting, list persisted transactions, or reconcile an interrupted job against its original network. Recovery never submits or retries a transaction.",
      inputSchema: schema("aztec_dev_job"),
    },
    {
      name: "aztec_dev_session",
      description: "Open, inspect, close, switch or reset one persistent local wallet. Close preserves accounts; reset explicitly discards this session's MCP-owned wallet state. Unresolved submissions block switching/resetting. The borrowed node is never stopped.",
      inputSchema: schema("aztec_dev_session"),
    },
    {
      name: "aztec_dev_release",
      description: "Write a deploy script, checklist and manifest for a verified local build so the user can deploy to a public Aztec network with their own wallet. Never signs, submits or contacts a network.",
      inputSchema: schema("aztec_dev_release"),
    },
  ];
  return {
    listTools: () => tools,
    async callTool(name, args) {
      if (!tools.some(tool => tool.name === name)) throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      try {
        validate(name, args);
        const op = args.operation;
        if (name === "aztec_dev_inspect") {
          if (op === "transaction") {
            return result(await transactions.inspect(args.sessionId as string, args.txHash as string));
          }
          if (op === "contract") {
            return result(await contracts.inspect(args.sessionId as string, { address: args.address as string, artifactPath: args.artifactPath as string | undefined }));
          }
          if (op === "environment") {
            return result(await inspectToolchain({ installationRoot: args.installationRoot as string, nodeExecutable: args.nodeExecutable as string }));
          }
          if (op === "session" || op === "accounts") {
            return result(op === "accounts" ? await sessions.accounts(args.sessionId as string) : await sessions.status(args.sessionId as string));
          }
        }
        if (name === "aztec_dev_contract" && op === "register") {
          return result(await contracts.register(args.sessionId as string, { address: args.address as string, artifactPath: args.artifactPath as string }));
        }
        if (name === "aztec_dev_contract" && (op === "simulate" || op === "view")) {
          const input = { address: args.address as string, functionName: args.functionName as string, args: args.args as unknown[], account: args.account as string, minimumBlock: args.minimumBlock as number | undefined };
          return result(await contracts[op](args.sessionId as string, input));
        }
        if (name === "aztec_dev_contract" && op === "deploy") {
          return result(await transactions.deploy({ sessionId: args.sessionId as string, buildJobId: args.buildJobId as string, artifactPath: args.artifactPath as string, account: args.account as string, arguments: args.args as unknown[], initialize: args.initialize as boolean, initializerName: args.initializerName as string | undefined, timeoutMs: args.timeoutMs as number | undefined }));
        }
        if (name === "aztec_dev_contract" && op === "send") {
          return result(await transactions.send({ sessionId: args.sessionId as string, address: args.address as string, functionName: args.functionName as string, args: args.args as unknown[], account: args.account as string, timeoutMs: args.timeoutMs as number | undefined }));
        }
        if (name === "aztec_dev_build" && (op === "compile" || op === "test")) {
          return result(await builds.start(args as unknown as BuildArguments));
        }
        if (name === "aztec_dev_job" && (op === "list-persisted" || op === "recover")) {
          return result(op === "recover" ? await recovery.reconcile(args.sessionId as string, args.jobId as string) : await recovery.list(args.sessionId as string));
        }
        if (name === "aztec_dev_job" && ["status", "logs", "cancel"].includes(String(op))) {
          const id = args.jobId as string;
          return result(op === "logs" ? jobs.logs(id, { offset: args.offset as number | undefined }) : op === "cancel" ? jobs.cancel(id) : jobs.get(id));
        }
        if (name === "aztec_dev_release" && op === "package") {
          const { operation: _operation, ...input } = args;
          return result(await releases.package(input as unknown as PackageInput));
        }
        if (name === "aztec_dev_session") {
          if (op === "open" || op === "switch") {
            return result(op === "switch" ? await sessions.switchTo(args.sessionId as string, args as unknown as SessionOpenOptions) : await sessions.open(args as unknown as SessionOpenOptions));
          }
          if (op === "status" || op === "close" || op === "reset") {
            return result(op === "close" ? await sessions.close(args.sessionId as string) : op === "reset" ? await sessions.reset(args.sessionId as string) : await sessions.status(args.sessionId as string));
          }
        }
        invalid(`Unsupported operation for ${name}.`);
      } catch (error) {
        if (error instanceof McpError) throw error;
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "operation-failed";
        const value = { error: { code, message: error instanceof Error ? error.message : String(error) } };
        return { ...result(value), isError: true };
      }
    },
    async shutdown() { await jobs.close(); await sessions.shutdown(); },
  };
}
