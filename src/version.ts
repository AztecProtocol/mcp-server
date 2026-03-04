import { createRequire } from "module";

const require = createRequire(import.meta.url);
export const MCP_VERSION: string = require("../package.json").version;
