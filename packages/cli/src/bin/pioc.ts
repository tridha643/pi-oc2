#!/usr/bin/env node
import { runPiocCli } from "../pioc-cli.js";

const outcome = await runPiocCli(process.argv.slice(2));
process.exitCode = outcome.exitCode;
