'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createShelly, HEATING_SCRIPT } = require('../harness');
const limits = require('../limits');
const { DEVICE_DAYLIGHT_SAVING, CYCLE_SECONDS, MILLISECONDS_PER_SECOND } = require('../settings');

const SIMULATED_DEVICE = path.join(__dirname, 'shelly-device.js');
const ONE_CYCLE = path.join(__dirname, 'one-cycle.js');
const BINARY = path.join(__dirname, 'bin', 'espruino');
const TIMEOUT_MS = 120000;
const REPORTED_OUTPUT_CHARACTERS = 2000;
const POOL_BLOCKS = 5000;
const MARKS = { result: 'MEMRESULT', error: 'DEVICEERROR' };
const KVS_KEY_WITH_DATE_TEXT = /^SmartHeatingSys/;
const KVS_FIELD_WITH_DATE_TEXT = 'LastCalculation';

function hasBinary() {
    return fs.existsSync(BINARY);
}

function runInNode(caseOptions) {
    const sim = createShelly(caseOptions).load().runFor(CYCLE_SECONDS);
    if (sim.crashed) throw new Error('The run in Node crashed: ' + sim.crashed);
    return sim;
}

function withoutDateText(params) {
    const value = JSON.parse(params.value);
    delete value[KVS_FIELD_WITH_DATE_TEXT];
    return { key: params.key, value };
}

function scenarioCall(call) {
    const hasDateText = call.method.toLowerCase() === 'kvs.set' && KVS_KEY_WITH_DATE_TEXT.test(call.params.key);
    const compared = hasDateText ? withoutDateText(call.params) : call.params;
    return { method: call.method, answer: call.answer, hasDateText, paramsText: JSON.stringify(compared === undefined ? null : compared) };
}

function scenarioRead(read) {
    return { name: read.name, argumentsText: `${read.type} ${read.id}`, answer: read.answer };
}

function scenarioOf(sim, isComparing) {
    return {
        now: Date.parse(sim.options.now),
        deviceInfo: sim.options.deviceInfo,
        scriptId: sim.options.scriptId,
        daylightSaving: DEVICE_DAYLIGHT_SAVING,
        calls: sim.calls.map(scenarioCall),
        reads: sim.reads.map(scenarioRead),
        isComparing,
        dateTextField: KVS_FIELD_WITH_DATE_TEXT,
        pendingTaskLimit: limits.RPC_CALL_LIMIT + limits.TIMER_LIMIT,
        runSeconds: CYCLE_SECONDS,
        millisecondsPerSecond: MILLISECONDS_PER_SECOND,
        marks: MARKS,
    };
}

// stdin stays open: at end of input the Espruino console reads junk into its input line, which lives in the measured pool
function runBinary(files, poolBlocks) {
    return new Promise((resolve, reject) => {
        const child = spawn(BINARY, files, {
            env: Object.assign({}, process.env, { ESPRUINO_VARS: String(poolBlocks) }),
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let output = '';
        let isTimedOut = false;
        const killTimer = setTimeout(() => {
            isTimedOut = true;
            child.kill('SIGKILL');
        }, TIMEOUT_MS);
        child.stdout.on('data', (chunk) => { output += chunk; });
        child.stderr.on('data', (chunk) => { output += chunk; });
        child.on('error', reject);
        child.on('close', (exitCode, signal) => {
            clearTimeout(killTimer);
            resolve({ output: output.replace(/\r/g, ''), exitCode, signal, isTimedOut });
        });
    });
}

function linesAfter(lines, mark) {
    return lines.filter((line) => line.startsWith(mark + ' ')).map((line) => line.slice(mark.length + 1));
}

function parse(run, poolBlocks) {
    const lines = run.output.split('\n');
    const [resultText] = linesAfter(lines, MARKS.result);
    if (!resultText || run.exitCode !== 0) {
        const ending = run.isTimedOut ? `was killed after ${TIMEOUT_MS} ms` : `ended with exit code ${run.exitCode} and signal ${run.signal}`;
        throw new Error(`Espruino ${resultText ? 'printed a result but' : 'printed no result and'} ${ending}:\n${run.output.slice(-REPORTED_OUTPUT_CHARACTERS)}`);
    }
    const result = JSON.parse(resultText);
    return {
        peakBytes: (result.peakBlocks - result.baselineBlocks) * result.blockBytes,
        retainedBytes: (result.retainedBlocks - result.baselineBlocks) * result.blockBytes,
        blockBytes: result.blockBytes,
        isPoolFull: result.peakBlocks >= poolBlocks,
        callCount: result.callCount,
        readCount: result.readCount,
        crashed: result.crashed,
        engineErrors: result.errors,
        deviceErrors: linesAfter(lines, MARKS.error),
        output: run.output,
    };
}

async function runInEspruino(directory, scriptFile, sim, run) {
    const scenarioFile = path.join(directory, run.isComparing ? 'compare.js' : 'measure.js');
    fs.writeFileSync(scenarioFile, 'var __scenario = ' + JSON.stringify(scenarioOf(sim, run.isComparing)) + ';\n');
    return parse(await runBinary([scenarioFile, SIMULATED_DEVICE, scriptFile, ONE_CYCLE], run.poolBlocks), run.poolBlocks);
}

async function measure(caseOptions, poolBlocks = POOL_BLOCKS) {
    const sim = runInNode(caseOptions);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-espruino-'));
    try {
        let scriptFile = HEATING_SCRIPT;
        if (typeof caseOptions.code === 'string') {
            scriptFile = path.join(directory, 'script.js');
            fs.writeFileSync(scriptFile, caseOptions.code + '\n');
        }
        const measured = await runInEspruino(directory, scriptFile, sim, { isComparing: false, poolBlocks });
        const compared = await runInEspruino(directory, scriptFile, sim, { isComparing: true, poolBlocks });
        return Object.assign(measured, {
            differencesFromNode: measured.deviceErrors.concat(compared.deviceErrors),
            callsInNode: sim.calls.length,
            readsInNode: sim.reads.length,
        });
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

module.exports = { measure, hasBinary, BINARY };
