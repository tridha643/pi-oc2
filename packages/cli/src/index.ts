/** Programmatic entry point for embedding `pioc` instead of spawning it as a binary. */
export { runPiocCli, rootCommand, type RunPiocCliOutcome } from "./pioc-cli.js";

export { runAnalyzeCommand, type AnalyzeCommandInput, type AnalyzeCommandResult } from "./analyze-command.js";
export { runPortCommand, type PortCommandInput, type PortCommandResult } from "./port-command.js";
export { runVerifyCommand, type VerifyCommandInput, type VerifyCommandResult } from "./verify-command.js";
export { runInitCommand, type InitCommandInput, type InitCommandResult } from "./init-command.js";

export { PiocCliError, EXIT_DOMAIN_FAILURE, EXIT_ENVIRONMENT_FAILURE, EXIT_INTERNAL_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from "./cli-error.js";
