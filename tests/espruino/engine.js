'use strict';
/*
Runs a script for one calculation cycle in the Espruino Linux build and reads the engine's
memory from process.memory(). The same scenario first runs in the Node harness, which gives
the HTTP answers for the Espruino mocks and the schedules both runs must agree on.
Build the binary with tests/espruino/build-espruino.sh or point ESPRUINO_BIN at one.
*/
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createShelly, DEFAULT_SCRIPTS, DEFAULT_DEVICE_INFO, LOCATION } = require('../harness');

const MOCK = path.join(__dirname, 'shelly-mock.js');
const DRIVER = path.join(__dirname, 'run.js');
const DEFAULT_BINARY = path.join(__dirname, 'bin', 'espruino');
const RUN_SECONDS = 120;
const TIMEOUT_MS = 120000;
const SCRIPT_ID = 1;
const SCRIPTS = DEFAULT_SCRIPTS;
const DEVICE_INFO = DEFAULT_DEVICE_INFO;

function espruinoBinary() {
    return process.env.ESPRUINO_BIN || DEFAULT_BINARY;
}

function hasEspruino() {
    return fs.existsSync(espruinoBinary());
}

function nodeRun(options) {
    const sim = createShelly(Object.assign({ scripts: SCRIPTS, deviceInfo: DEVICE_INFO, scriptId: SCRIPT_ID }, options))
        .load().runFor(RUN_SECONDS);
    if (sim.crashed) throw new Error('Node harness run crashed: ' + sim.crashed.stack);
    return sim;
}

function scenarioOf(options, sim) {
    const http = {};
    for (const { url, answer } of sim.httpAnswers) http[url] = answer;
    return {
        now: Date.parse(options.now),
        kvs: Object.assign({}, options.kvs),
        deviceInfo: DEVICE_INFO,
        location: LOCATION,
        scriptId: SCRIPT_ID,
        scripts: SCRIPTS,
        http,
        runSeconds: RUN_SECONDS,
    };
}

// stdin stays open: at EOF the Espruino console would read junk into its input line, which lives in the pool
function runBinary(files, variables) {
    return new Promise((resolve, reject) => {
        const child = spawn(espruinoBinary(), files, {
            env: Object.assign({}, process.env, { ESPRUINO_VARS: String(variables) }),
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let output = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
        child.stdout.on('data', (chunk) => { output += chunk; });
        child.stderr.on('data', (chunk) => { output += chunk; });
        child.on('error', reject);
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal, output: output.replace(/\r/g, '') });
        });
    });
}

function parseOutput(run) {
    const lines = run.output.split('\n');
    const resultLine = lines.find((line) => line.startsWith('MEMRESULT '));
    return {
        exitCode: run.code,
        signal: run.signal,
        result: resultLine ? JSON.parse(resultLine.slice('MEMRESULT '.length)) : null,
        timespecs: lines.filter((line) => line.startsWith('MOCK schedule.create '))
            .map((line) => JSON.parse(line.slice('MOCK schedule.create '.length)).timespec),
        mockErrors: lines.filter((line) => line.startsWith('MOCKERR')),
        isOutOfMemory: run.output.indexOf('OUT OF MEMORY') >= 0,
        output: run.output,
    };
}

/*
options: scriptFile, elering, now, kvs as in harness.js, variables = size of the variable pool.
Returns the Espruino run (result, timespecs created, errors) and the Node harness timespecs.
*/
async function measure(options) {
    const sim = nodeRun(options);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-espruino-'));
    const scenarioFile = path.join(dir, 'scenario.js');
    try {
        fs.writeFileSync(scenarioFile, 'var __scenario = ' + JSON.stringify(scenarioOf(options, sim)) + ';\n');
        const run = await runBinary([scenarioFile, MOCK, options.scriptFile, DRIVER], options.variables);
        return Object.assign(parseOutput(run), { nodeTimespecs: [...sim.schedules.values()].map((job) => job.timespec) });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

module.exports = { measure, hasEspruino, espruinoBinary };
