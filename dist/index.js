import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const pkg = require("../package.json");
/** The diarchy package version, read from package.json at runtime. */
export const VERSION = pkg.version;
//# sourceMappingURL=index.js.map