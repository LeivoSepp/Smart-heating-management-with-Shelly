'use strict';
/*
Engine memory of v4.9 and the current script in the Espruino interpreter (npm run test:memory).
Each case runs one calculation cycle with each of the SETTINGS and reads process.memory():
  peak     most variable blocks used at once while the script loads and plans, checked after
           every allocation, with garbage collected between callbacks as the idle loop would
  retained blocks still used after the cycle, comparable to mem_used on the device
both counted above the mock baseline and turned to bytes with blocksize. A second run gives
the script only the baseline plus SHELLY_SCRIPT_BYTES and must still plan the same schedules.
*/
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { SCRIPT } = require('../harness');
const { measure, hasEspruino, espruinoBinary } = require('./engine');
const { LEGACY_SCRIPT, DEFAULT_CONF, QUARTER_OWNER_CONF, QUARTER_HOT_WATER_CONF, NORMAL_DAY, SPRING_DAY, AUTUMN_DAY, NEGATIVE_DAY } = require('../settings');

const SHELLY_SCRIPT_BYTES = 25 * 1024;
// Two instances share the device's script memory, so each may keep this much after a cycle;
// between the callbacks of a cycle the day's prices are live as well (retained peak, reported only)
const RETAINED_LIMIT_BYTES = 8 * 1024;
const MEASURE_VARIABLES = 5000;

const SETTINGS = [
    ['default hourly', DEFAULT_CONF],
    ['storage tank, 15 min', QUARTER_OWNER_CONF],
    ['hot water, 15 min', QUARTER_HOT_WATER_CONF],
    ['whole day, 15 min', Object.assign({}, DEFAULT_CONF, { HeatingTime: 24, AlwaysOnPrice: -500, SlotMinutes: 15 })],
];
const DAYS = [NORMAL_DAY, SPRING_DAY, AUTUMN_DAY, NEGATIVE_DAY].map((day) => [day.isoDate, day.fixture, day.now]);
const VERSIONS = [['v4.9', LEGACY_SCRIPT], ['current', SCRIPT]];

function assertCleanRun(run, label) {
    assert.ok(run.result, `${label}: no MEMRESULT in the output\n${run.output.slice(-2000)}`);
    assert.equal(run.result.crashed, null, `${label}: ${run.result.crashed}`);
    assert.deepEqual(run.mockErrors, [], label);
    assert.equal(run.isOutOfMemory, false, `${label}: out of memory`);
    assert.deepEqual(run.result.errors, [], `${label}: Espruino error flags`);
    assert.deepEqual(run.timespecs, run.nodeTimespecs, `${label}: schedules differ from the Node harness`);
}

function bytesAbove(blocks, result) {
    return (blocks - result.baseline) * result.blocksize;
}

async function measureVersion(scriptFile, fixture, now, conf, label) {
    const options = { scriptFile, elering: fixture, now, kvs: { SmartHeatingConf1: JSON.stringify(conf) } };
    const run = await measure(Object.assign({ variables: MEASURE_VARIABLES }, options));
    assertCleanRun(run, label);
    assert.ok(run.result.peak < MEASURE_VARIABLES, `${label}: the measuring pool is full, raise MEASURE_VARIABLES`);
    const budget = run.result.baseline + Math.floor(SHELLY_SCRIPT_BYTES / run.result.blocksize);
    const budgetRun = await measure(Object.assign({ variables: budget }, options));
    return {
        peakBytes: bytesAbove(run.result.peak, run.result),
        retainedBytes: bytesAbove(run.result.retainedEnd, run.result),
        retainedPeakBytes: bytesAbove(run.result.retainedPeak, run.result),
        blocksize: run.result.blocksize,
        version: run.result.version,
        budgetRun,
    };
}

describe('engine memory in Espruino', { concurrency: true }, () => {
    before(() => {
        assert.ok(hasEspruino(), `No Espruino binary at ${espruinoBinary()}: run tests/espruino/build-espruino.sh or set ESPRUINO_BIN`);
    });

    for (const [settingName, conf] of SETTINGS) {
        for (const [dayName, fixture, now] of DAYS) {
            it(`${settingName}, ${dayName}: the current script peaks no higher than v4.9 and fits ${SHELLY_SCRIPT_BYTES} B`, async (t) => {
                const results = {};
                for (const [versionName, scriptFile] of VERSIONS) {
                    const label = `${versionName} ${settingName} ${dayName}`;
                    const measured = await measureVersion(scriptFile, fixture, now, conf, label);
                    t.diagnostic(`${versionName.padEnd(7)} peak ${measured.peakBytes} B, retained ${measured.retainedBytes} B ` +
                        `(between callbacks up to ${measured.retainedPeakBytes} B; blocksize ${measured.blocksize}, Espruino ${measured.version})`);
                    assertCleanRun(measured.budgetRun, `${label} within ${SHELLY_SCRIPT_BYTES} B`);
                    results[versionName] = measured;
                }
                assert.ok(results.current.peakBytes <= results['v4.9'].peakBytes,
                    `current peak ${results.current.peakBytes} B > v4.9 peak ${results['v4.9'].peakBytes} B`);
                assert.ok(results.current.retainedBytes <= RETAINED_LIMIT_BYTES,
                    `current retains ${results.current.retainedBytes} B > ${RETAINED_LIMIT_BYTES} B`);
            });
        }
    }
});
