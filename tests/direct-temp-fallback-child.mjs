import process from "node:process";

import { tempDir } from "./helpers.mjs";

process.stdout.write(tempDir("grok-plugin-repo-"));
