import { readEnv } from "../src/config/env.js";
try { readEnv(); console.log("Backend runtime environment is valid. Values are not printed."); }
catch (error) { console.error(error.message); process.exitCode = 1; }
