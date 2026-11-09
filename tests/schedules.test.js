'use strict';
/*
Schedule bookkeeping of the current script: SmartHeatingSys keeps a list of schedule
IDs (v4.9 kept one), the script and the watchdog delete every listed schedule.
*/
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createShelly, runWatchdog, ROOT } = require('./harness');
const { KVS_VALUE_LIMIT, kvsLength, storedForm, DEFAULT_CONF, QUARTER_CONF } = require('./settings');

const CONF = JSON.stringify(DEFAULT_CONF);
const MANY_IDS = [100, 101, 102, 103, 104, 105, 106, 107];
const JOB = { timespec: '0 0 23 * * *', calls: [{ method: 'Switch.Set', params: { id: 0, on: true } }] };
const WATCHDOG_MIN = fs.readFileSync(path.join(ROOT, 'files', 'watchdog-min.js'), 'utf8');
const WATCHDOG = fs.readFileSync(path.join(ROOT, 'files', 'watchdog.js'), 'utf8');

function jobs(ids) {
    const result = {};
    for (const id of ids) result[id] = JOB;
    return result;
}

function sys(existing) {
    return JSON.stringify({ LastCalculation: 'x', ExistingSchedule: existing, Version: 4.9 });
}

function run(options) {
    const sim = createShelly(Object.assign({ kvs: { SmartHeatingConf1: CONF } }, options)).load().runFor(120);
    assert.equal(sim.crashed, null, sim.logs.join('\n'));
    return sim;
}

describe('schedule IDs in SmartHeatingSys', () => {
    it('migrates the single v4.9 schedule ID and deletes that schedule', () => {
        const sim = run({ kvs: { SmartHeatingConf1: CONF, SmartHeatingSys1: sys(7) }, schedules: { 7: JOB } });
        assert.equal(sim.schedules.has(7), false);
        assert.deepEqual(sim.json('SmartHeatingSys1').ExistingSchedule, [...sim.schedules.keys()]);
        assert.equal(sim.json('SmartHeatingSys1').Version, sim.eval('_.newV'));
        assert.deepEqual(sim.json('SmartHeatingConf1'), storedForm(DEFAULT_CONF));
        assert.ok(sim.logs.some((line) => line.indexOf('migrated to a list of schedules') >= 0));
    });

    it('deletes every schedule in the list before creating new ones', () => {
        const sim = run({
            kvs: { SmartHeatingConf1: CONF, SmartHeatingSys1: sys([3, 4, 5, 6]) },
            schedules: { 3: JOB, 4: JOB, 5: JOB, 6: JOB, 9: JOB },
        });
        for (const id of [3, 4, 5, 6]) assert.equal(sim.schedules.has(id), false);
        assert.equal(sim.schedules.has(9), true, 'schedules of others stay');
    });


    it('keeps SmartHeatingSys with four three-digit schedule IDs within the KVS value limit', () => {
        const sim = run({ kvs: { SmartHeatingConf1: JSON.stringify(QUARTER_CONF) }, schedules: jobs(MANY_IDS.slice(0, 4)) });
        const stored = sim.json('SmartHeatingSys1');
        assert.equal(stored.ExistingSchedule.length, 4);
        assert.ok(stored.ExistingSchedule.every((id) => id >= 100), JSON.stringify(stored));
        assert.ok(kvsLength(sim.kvs.SmartHeatingSys1) <= KVS_VALUE_LIMIT, sim.kvs.SmartHeatingSys1);
    });

    it('keeps a schedule it could not delete for the next calculation', () => {
        const sim = run({ kvs: { SmartHeatingConf1: CONF, SmartHeatingSys1: sys([7, 8]) }, schedules: { 7: JOB, 8: JOB }, scheduleDeleteFail: [7] });
        assert.ok(sim.logs.some((line) => line.indexOf('Schedule 7 not deleted') >= 0), sim.logs.join('\n'));
        assert.equal(sim.schedules.get(7).enable, false, 'disabled so that it stops switching the relay');
        assert.equal(sim.schedules.has(8), false);
        const stored = sim.json('SmartHeatingSys1').ExistingSchedule;
        assert.ok(stored.indexOf(7) >= 0 && stored.length === 2, JSON.stringify(stored));
    });

    it('reports a schedule it could neither delete nor disable and ends the cycle', () => {
        const sim = run({ kvs: { SmartHeatingConf1: CONF, SmartHeatingSys1: sys([7]) }, schedules: { 7: JOB }, scheduleDeleteFail: [7], rpcFail: { 'schedule.update': -114 } });
        assert.ok(sim.logs.some((line) => line.indexOf('Schedule 7 not disabled either') >= 0), sim.logs.join('\n'));
        assert.equal(sim.schedules.get(7).enable, true);
        assert.equal(sim.eval('_.isLp'), false);
    });

    it('reports the slots lost to the device schedule limit', () => {
        const foreign = {};
        for (let id = 100; id < 117; id++) foreign[id] = JOB;
        const sim = run({ kvs: { SmartHeatingConf1: JSON.stringify(QUARTER_CONF) }, schedules: foreign });
        assert.ok(sim.logs.some((line) => line.indexOf('schedule(s) not created') >= 0), sim.logs.join('\n'));
        assert.equal(sim.schedules.size, 20);
        assert.equal(sim.json('SmartHeatingSys1').ExistingSchedule.length, 3);
    });

    it('deletes eight old schedules one at a time within the RPC call limit', () => {
        const sim = run({ kvs: { SmartHeatingConf1: CONF, SmartHeatingSys1: sys(MANY_IDS) }, schedules: jobs(MANY_IDS) });
        assert.equal(sim.maxInFlightBy['Schedule.Delete'], 1, 'one delete at a time');
        for (const id of MANY_IDS) assert.equal(sim.schedules.has(id), false);
    });
});

describe('watchdog', () => {
    it('installs the code from files/watchdog-min.js', () => {
        const sim = run({});
        assert.equal(sim.scriptCode[2], WATCHDOG_MIN);
    });

    for (const [name, code] of [['minified', WATCHDOG_MIN], ['reference', WATCHDOG]]) {
        it(`deletes every listed schedule one at a time (${name})`, () => {
            const sim = createShelly({ kvs: { SmartHeatingSys1: sys(MANY_IDS) }, schedules: Object.assign(jobs(MANY_IDS), { 9: JOB }) });
            const watchdog = runWatchdog(sim, code, 1);
            assert.equal(watchdog.crashed, null, watchdog.logs.join('\n'));
            assert.deepEqual([...sim.schedules.keys()], [9]);
            assert.deepEqual(sim.json('SmartHeatingSys1').ExistingSchedule, []);
            assert.equal(watchdog.maxInFlightBy['Schedule.Delete'], 1, 'one delete at a time');
        });

        it(`keeps a schedule it could not delete in SystemData (${name})`, () => {
            const sim = createShelly({ kvs: { SmartHeatingSys1: sys([3, 4]) }, schedules: { 3: JOB, 4: JOB } });
            const watchdog = runWatchdog(sim, code, 1, { scheduleDeleteFail: [3] });
            assert.equal(watchdog.crashed, null, watchdog.logs.join('\n'));
            assert.deepEqual([...sim.schedules.keys()], [3]);
            assert.deepEqual(sim.json('SmartHeatingSys1').ExistingSchedule, [3]);
        });

        it(`drops a schedule that no longer exists (${name})`, () => {
            const sim = createShelly({ kvs: { SmartHeatingSys1: sys([3, 4]) }, schedules: { 4: JOB } });
            runWatchdog(sim, code, 1);
            assert.equal(sim.schedules.size, 0);
            assert.deepEqual(sim.json('SmartHeatingSys1').ExistingSchedule, []);
        });

        it(`writes nothing when the list is already empty (${name})`, () => {
            const sim = createShelly({ kvs: { SmartHeatingSys1: sys([]) } });
            const watchdog = runWatchdog(sim, code, 1);
            assert.equal(watchdog.calls.some((call) => call.method.toLowerCase() === 'kvs.set'), false);
        });

        it(`ignores a script status without the running field (${name})`, () => {
            const sim = createShelly({ kvs: { SmartHeatingSys1: sys([4]) }, schedules: { 4: JOB } });
            const watchdog = createShelly({ code, scriptId: 2 });
            watchdog.kvs = sim.kvs;
            watchdog.schedules = sim.schedules;
            watchdog.load();
            watchdog.emitStatus({ component: 'script:1', name: 'script', id: 1, delta: { id: 1, errors: ['x'] } });
            watchdog.runFor(10);
            assert.equal(sim.schedules.size, 1);
        });

        it(`writes the KVS key of the script that stopped (${name})`, () => {
            const sim = createShelly({ kvs: { SmartHeatingSys3: sys([5]) }, schedules: { 5: JOB } });
            runWatchdog(sim, code, 3);
            assert.equal(sim.schedules.size, 0);
            assert.deepEqual(sim.json('SmartHeatingSys3').ExistingSchedule, []);
            assert.equal('SmartHeatingSys1' in sim.kvs, false);
        });

        it(`deletes the single schedule ID of v4.9 (${name})`, () => {
            const sim = createShelly({ kvs: { SmartHeatingSys1: sys(7) }, schedules: { 7: JOB } });
            const watchdog = runWatchdog(sim, code, 1);
            assert.equal(watchdog.crashed, null, watchdog.logs.join('\n'));
            assert.equal(sim.schedules.size, 0);
        });

        it(`logs invalid system data instead of stopping (${name})`, () => {
            const sim = createShelly({ kvs: { SmartHeatingSys1: '{broken' }, schedules: { 7: JOB } });
            const watchdog = runWatchdog(sim, code, 1);
            assert.equal(watchdog.crashed, null);
            assert.ok(watchdog.logs.some((line) => line.indexOf('not valid JSON') >= 0));
        });
    }
});
