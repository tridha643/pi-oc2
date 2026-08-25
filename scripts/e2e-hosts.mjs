#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const piocBin = join(repositoryRoot, 'packages/cli/dist/bin/pioc.js');
const opencode2Bin = process.env.PIOC_OPENCODE2_BIN ?? join(repositoryRoot, 'packages/cli/node_modules/.bin/opencode2');
const piModel = process.env.PIOC_PI_MODEL ?? 'openai-codex/gpt-5.4-mini';
const opencode2Model = process.env.PIOC_OPENCODE2_MODEL ?? 'openai/gpt-5.4-mini';

function run(command, args, options = {}) {
    return new Promise((resolveRun, rejectRun) => {
        const child = spawn(command, args, {
            cwd: options.cwd ?? repositoryRoot,
            env: { ...process.env, ...options.env },
            // Pi print mode reads piped stdin. An open inherited pipe makes it wait forever for EOF.
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const timeoutMs = options.timeoutMs ?? 180_000;
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timedOut = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
        }, timeoutMs);
        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString('utf8');
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString('utf8');
        });
        child.on('error', (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            rejectRun(error);
        });
        child.on('close', (exitCode) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (timedOut) {
                rejectRun(new Error(`${command} ${args.join(' ')} exceeded ${timeoutMs}ms\n${stderr || stdout}`));
                return;
            }
            if (exitCode === 0) {
                resolveRun({ stdout, stderr });
                return;
            }
            rejectRun(new Error(`${command} ${args.join(' ')} exited ${exitCode}\n${stderr || stdout}`));
        });
    });
}

async function runStage(label, command, args, options) {
    console.error(`[e2e] ${label}`);
    return run(command, args, options);
}

function findOpenCodeToolOutput(jsonLines, toolName) {
    for (const line of jsonLines.trim().split('\n')) {
        if (line.length === 0) continue;
        const event = JSON.parse(line);
        if (event.type === 'tool_use' && event.part?.tool === toolName) {
            const output = event.part.state?.output;
            return typeof output === 'string' ? output : output?.content;
        }
    }
    return undefined;
}

// Pi's non-interactive trust/session resolution is reliable under the canonical Unix temp root;
// macOS's per-process TMPDIR can resolve through changing private symlink prefixes between child processes.
const temporaryBase = process.platform === 'win32' ? tmpdir() : '/tmp';
const temporaryRoot = await mkdtemp(join(temporaryBase, 'pioc-real-hosts-'));
const sourceRoot = join(temporaryRoot, 'source');
const outputRoot = join(temporaryRoot, 'out');
const opencodeProject = join(temporaryRoot, 'opencode-project');

try {
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(outputRoot, { recursive: true });
    await mkdir(opencodeProject, { recursive: true });

    await runStage('build compiler', 'pnpm', ['build']);
    await runStage('initialize fixture', process.execPath, [piocBin, 'init', sourceRoot]);
    await runStage('generate both targets', process.execPath, [
        piocBin,
        'port',
        sourceRoot,
        '--manifest',
        join(sourceRoot, 'pioc.port.json'),
        '--out',
        outputRoot,
    ]);
    await runStage(
        'verify deterministic output',
        process.execPath,
        [piocBin, 'verify', outputRoot],
        { env: { PIOC_OPENCODE2_BIN: opencode2Bin } },
    );

    const piTarget = join(outputRoot, 'generated/pi');
    const opencode2Target = join(outputRoot, 'generated/opencode2');
    await runStage('install generated Pi dependencies', 'pnpm', ['install', '--ignore-scripts'], { cwd: piTarget });
    await runStage('install generated OpenCode dependencies', 'pnpm', ['install', '--ignore-scripts'], { cwd: opencode2Target });

    const piRun = await runStage(
        'invoke generated Pi tool',
        'pi',
        [
            '--no-session',
            '--no-context-files',
            '--no-skills',
            '--no-prompt-templates',
            '--no-themes',
            '--no-extensions',
            '-e',
            piTarget,
            '--no-builtin-tools',
            '--model',
            piModel,
            '--thinking',
            'off',
            '-p',
            'Call the hello tool exactly once with {"name":"E2E"}. Return only the final text from the tool.',
        ],
        { cwd: sourceRoot, env: { PI_OFFLINE: '1' }, timeoutMs: 240_000 },
    );
    if (piRun.stdout.trim() !== 'Hello, E2E!') {
        throw new Error(`Pi returned unexpected output: ${JSON.stringify(piRun.stdout.trim())}`);
    }

    await writeFile(
        join(opencodeProject, 'opencode.jsonc'),
        `${JSON.stringify({ plugin: [pathToFileURL(join(opencode2Target, 'server.ts')).href] }, null, 2)}\n`,
    );
    const openCodeRun = await runStage(
        'invoke generated OpenCode 2 tool',
        opencode2Bin,
        [
            'run',
            '--standalone',
            '--auto',
            '--model',
            opencode2Model,
            '--format',
            'json',
            'Invoke the hello tool exactly once with {"name":"E2E"}. Return only its output.',
        ],
        { cwd: opencodeProject, timeoutMs: 300_000 },
    );
    const openCodeOutput = findOpenCodeToolOutput(openCodeRun.stdout, 'hello');
    if (openCodeOutput !== 'Hello, E2E!') {
        throw new Error(`OpenCode 2 did not return the generated hello tool output.\n${openCodeRun.stdout}`);
    }

    const lock = JSON.parse(await readFile(join(outputRoot, 'pioc.lock.json'), 'utf8'));
    console.log(JSON.stringify({
        status: 'passed',
        pi: piRun.stdout.trim(),
        opencode2: openCodeOutput,
        targetProfile: lock.targetProfile,
        temporaryRoot: process.env.PIOC_E2E_KEEP === '1' ? temporaryRoot : undefined,
    }, null, 2));
} finally {
    if (process.env.PIOC_E2E_KEEP !== '1') {
        await rm(temporaryRoot, { recursive: true, force: true });
    }
}
