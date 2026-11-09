'use strict';
/*
The calculation cycle of the current script around failures: RPC errors in the watchdog
chain, a device clock that arrives late, slow RPC answers, Elering recovering, the forecast
without a period, and Virtual Component mode. Every case must leave the loop able to run
the next calculation.
*/
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createShelly } = require('./harness');
const { expectedTimespecs } = require('./expect');
const { QUARTER_CONF, DEFAULT_CONF, DAY_SECONDS, FALLBACK_LOG, NORMAL_DAY, HOT_WATER_DAY } = require('./settings');

const TWO_DAYS = [NORMAL_DAY.fixture, HOT_WATER_DAY.fixture];
const AFTERNOON = '2026-10-07T14:10:00+03:00';
const WATCHDOG_SCRIPT = { id: 2, name: 'watchdog', running: true };
const GEN3 = { gen: 3, app: 'S3SW-001P16EU', ver: '1.7.5', id: 'shelly1pmg3-test' };

function start(conf, options) {
    const kvs = Object.assign({ SmartHeatingConf1: JSON.stringify(conf) }, options.kvs || {});
    return createShelly(Object.assign({ elering: TWO_DAYS, now: AFTERNOON }, options, { kvs })).load();
}

function elering(sim) {
    return sim.httpRequests.filter((url) => url.indexOf('elering') >= 0).length;
}

describe('the cycle ends after every watchdog failure', () => {
    for (const method of ['script.list', 'script.create', 'script.putcode']) {
        it(`${method} fails on day 1 and the next day's calculation still runs`, () => {
            const sim = start(QUARTER_CONF, { rpcFail: { [method]: -108 } }).runFor(120);
            assert.equal(sim.crashed, null, sim.logs.join('\n'));
            const before = elering(sim);
            assert.ok(before > 0);
            sim.runFor(DAY_SECONDS);
            assert.equal(sim.eval('_.isLp'), false);
            assert.ok(elering(sim) > before, 'the 23:46 calculation ran');
            assert.deepEqual(sim.timespecs(), expectedTimespecs(HOT_WATER_DAY, QUARTER_CONF));
        });
    }

    it('stops and rewrites an existing watchdog instead of creating a second one', () => {
        const sim = start(QUARTER_CONF, { scripts: [{ id: 1, name: 'Smart Heating', running: true }, WATCHDOG_SCRIPT] }).runFor(120);
        const methods = sim.calls.map((call) => call.method);
        assert.equal(methods.indexOf('Script.Create'), -1);
        assert.ok(sim.calls.some((call) => call.method === 'Script.Stop' && call.params.id === 2));
        assert.ok(sim.calls.some((call) => call.method === 'Script.PutCode' && call.params.id === 2));
        assert.equal(sim.eval('_.isLp'), false);
    });
});

describe('device clock and slow answers', () => {
    it('waits for the clock and plans with prices as soon as it is set', () => {
        const sim = start(QUARTER_CONF, { timeAfterS: 60 }).runFor(45);
        assert.equal(sim.httpRequests.length, 0, 'nothing is planned without a clock');
        assert.equal(sim.schedules.size, 0);
        assert.ok(sim.logs.some((line) => line.indexOf('Shelly has no time after 30 seconds') >= 0), sim.logs.join('\n'));
        sim.runFor(120);
        assert.equal(sim.crashed, null, sim.logs.join('\n'));
        assert.deepEqual(sim.timespecs(), expectedTimespecs(NORMAL_DAY, QUARTER_CONF));
        assert.equal(sim.eval('_.isLp'), false);
    });

    it('keeps one consistent plan when the clock arrives while the fallback chain is still running', () => {
        const delays = { 'http.get': 100, 'kvs.set': 20, 'schedule.create': 300, 'schedule.delete': 300 };
        const sim = start(QUARTER_CONF, { timeAfterS: 33, rpcDelayMs: delays }).runFor(600);
        assert.equal(sim.crashed, null, sim.logs.join('\n'));
        assert.equal(sim.eval('cntr'), 0);
        assert.equal(sim.eval('_.isLp'), false);
        assert.deepEqual(sim.timespecs(), expectedTimespecs(NORMAL_DAY, QUARTER_CONF));
        assert.deepEqual(sim.json('SmartHeatingSys1').ExistingSchedule.slice().sort(), [...sim.schedules.keys()].sort());
    });

    it('replans with prices at the next tick after Elering recovers and drops the fallback schedules', () => {
        const sim = start(QUARTER_CONF, { now: NORMAL_DAY.now, httpFail: /elering/ }).runFor(30);
        assert.ok(sim.logs.some((line) => FALLBACK_LOG.test(line)));
        sim.setHttpFail(null).runFor(6 * 60);
        assert.deepEqual(sim.timespecs(), expectedTimespecs(NORMAL_DAY, QUARTER_CONF));
        assert.equal(sim.eval('_.manu'), false);
        assert.equal(sim.eval('_.isLp'), false);
    });
});

describe('KVS read errors', () => {
    it('keeps the stored configuration when it cannot be read', () => {
        const stored = JSON.stringify(Object.assign({}, DEFAULT_CONF, { HeatingTime: 3, EnergyProvider: 'VORK4' }));
        const sim = createShelly({ kvs: { SmartHeatingConf1: stored }, kvsGetFail: ['SmartHeatingConf1'], elering: NORMAL_DAY.fixture, now: NORMAL_DAY.now }).load().runFor(120);
        assert.equal(sim.crashed, null, sim.logs.join('\n'));
        assert.equal(sim.kvs.SmartHeatingConf1, stored, 'byte-identical');
        assert.equal(sim.kvsSets('SmartHeatingConf1'), 0);
    });

    it('keeps the old schedules and retries in KVS mode when SystemData cannot be read', () => {
        const sys = JSON.stringify({ LastCalculation: 'x', ExistingSchedule: [7], Version: 5.0 });
        const job = { timespec: '0 0 23 * * *', calls: [{ method: 'Switch.Set', params: { id: 0, on: true } }] };
        const sim = start(QUARTER_CONF, { now: NORMAL_DAY.now, elering: NORMAL_DAY.fixture, kvs: { SmartHeatingSys1: sys }, schedules: { 7: job }, kvsGetFail: ['SmartHeatingSys1'] }).runFor(120);
        assert.ok(sim.schedules.has(7));
        assert.equal(sim.httpRequests.length, 0);
        sim.setKvsGetFail([]).runFor(6 * 60);
        assert.equal(sim.schedules.has(7), false);
        assert.deepEqual(sim.timespecs(), expectedTimespecs(NORMAL_DAY, QUARTER_CONF));
    });

    it('writes the configuration to KVS only when it changed', () => {
        const stored = JSON.stringify(QUARTER_CONF);
        const sim = createShelly({ kvs: { SmartHeatingConf1: stored }, elering: TWO_DAYS, now: AFTERNOON }).load().runFor(DAY_SECONDS + 3600);
        assert.equal(sim.crashed, null, sim.logs.join('\n'));
        assert.ok(sim.httpRequests.length >= 8, 'two calculations ran');
        assert.equal(sim.kvsSets('SmartHeatingConf1'), 1, 'the key order of the script differs from the stored text once, then no rewrite');
    });
});

describe('forecast without a period', () => {
    it('calculates once an hour at most, not every five minutes', () => {
        const conf = Object.assign({}, DEFAULT_CONF, { TimePeriod: 0, IsForecastUsed: true, AlwaysOnPrice: 100 });
        const sim = start(conf, { now: '2026-10-07T10:00:00+03:00' }).runFor(3600);
        assert.equal(sim.crashed, null, sim.logs.join('\n'));
        assert.equal(elering(sim), 4, 'one calculation in four parts');
        assert.equal(sim.httpRequests.some((url) => url.indexOf('open-meteo') >= 0), false);
    });
});

describe('Virtual Component mode', () => {
    const SYS = JSON.stringify({ LastCalculation: 'x', ExistingSchedule: [], Version: 5.0 });
    const vc = (values) => Object.keys(values).map((key) => ({ key, status: { value: values[key] }, config: {} }));
    const PERIOD_12 = { 'enum:200': '12', 'number:200': 3, 'boolean:200': false, 'enum:201': 'VORK2', 'number:201': 1, 'number:202': 300, 'boolean:201': false, 'enum:202': 'ee', 'number:203': 0 };

    it('installs its components and the group on a fresh Gen3 device', () => {
        const sim = createShelly({ deviceInfo: GEN3, now: NORMAL_DAY.now }).load().runFor(120);
        assert.equal(sim.crashed, null, sim.logs.join('\n'));
        assert.equal(sim.components.length, sim.eval('dtVc().length'));
        assert.ok(Array.isArray(sim.group) && sim.group.length === 9);
        assert.ok(sim.schedules.size > 0);
        assert.equal(sim.eval('_.isLp'), false);
    });

    it('plans from the component values of an existing installation', () => {
        const sim = createShelly({ deviceInfo: GEN3, now: NORMAL_DAY.now, kvs: { SmartHeatingSys1: SYS }, components: vc(PERIOD_12) }).load().runFor(120);
        assert.equal(sim.crashed, null, sim.logs.join('\n'));
        const conf = Object.assign({}, DEFAULT_CONF, { TimePeriod: 12, HeatingTime: 3 });
        assert.deepEqual(sim.timespecs(), expectedTimespecs(NORMAL_DAY, conf));
        assert.equal(sim.calls.some((call) => call.method === 'Virtual.Delete'), false);
    });

    it('takes the optional keys from a KVS configuration that holds only them', () => {
        const kvs = { SmartHeatingSys1: SYS, SmartHeatingConf1: JSON.stringify({ SlotMinutes: 15 }) };
        const sim = createShelly({ deviceInfo: GEN3, now: NORMAL_DAY.now, kvs, components: vc(PERIOD_12) }).load().runFor(120);
        assert.equal(sim.crashed, null, sim.logs.join('\n'));
        const conf = Object.assign({}, DEFAULT_CONF, { TimePeriod: 12, HeatingTime: 3, SlotMinutes: 15 });
        assert.deepEqual(sim.timespecs(), expectedTimespecs(NORMAL_DAY, conf));
        assert.equal(sim.switchConfig.auto_off_delay, 910);
    });

    it('keeps the components and repairs SystemData that is not valid JSON', () => {
        const foreign = { key: 'boolean:210', status: { value: true }, config: {} };
        const sim = createShelly({ deviceInfo: GEN3, now: NORMAL_DAY.now, kvs: { SmartHeatingSys1: '{broken' }, components: vc(PERIOD_12).concat([foreign]) }).load().runFor(120);
        assert.equal(sim.crashed, null, sim.logs.join('\n'));
        assert.equal(sim.calls.some((call) => call.method === 'Virtual.Delete'), false);
        assert.ok(sim.components.some((c) => c.key === 'boolean:210'));
        assert.deepEqual(sim.timespecs(), expectedTimespecs(NORMAL_DAY, Object.assign({}, DEFAULT_CONF, { TimePeriod: 12, HeatingTime: 3 })));
        assert.equal(sim.json('SmartHeatingSys1').Version, sim.eval('_.newV'));
        assert.equal(sim.eval('_.isLp'), false);
    });

    it('keeps the schedules and retries when SystemData cannot be read', () => {
        const sys = JSON.stringify({ LastCalculation: 'x', ExistingSchedule: [7], Version: 5.0 });
        const job = { timespec: '0 0 23 * * *', calls: [{ method: 'Switch.Set', params: { id: 0, on: true } }] };
        const sim = createShelly({ deviceInfo: GEN3, now: NORMAL_DAY.now, kvs: { SmartHeatingSys1: sys }, schedules: { 7: job }, components: vc(PERIOD_12), kvsGetFail: ['SmartHeatingSys1'] }).load().runFor(120);
        assert.ok(sim.schedules.has(7), 'nothing is deleted while SystemData is unknown');
        assert.equal(sim.httpRequests.length, 0);
        assert.equal(sim.eval('_.isLp'), false);
        sim.setKvsGetFail([]).runFor(6 * 60);
        assert.equal(sim.schedules.has(7), false, 'the old schedule is deleted once SystemData is known');
        assert.deepEqual(sim.timespecs(), expectedTimespecs(NORMAL_DAY, Object.assign({}, DEFAULT_CONF, { TimePeriod: 12, HeatingTime: 3 })));
    });

    it('reinstalls only its own components on a first install next to a foreign one', () => {
        const foreign = { key: 'boolean:210', status: { value: true }, config: {} };
        const sim = createShelly({ deviceInfo: GEN3, now: NORMAL_DAY.now, components: vc(PERIOD_12).concat([foreign]) }).load().runFor(120);
        assert.equal(sim.crashed, null, sim.logs.join('\n'));
        assert.ok(sim.components.some((c) => c.key === 'boolean:210'));
        assert.equal(sim.components.length, sim.eval('dtVc().length') + 1);
    });

    it('keeps the schedules and retries when the components cannot be read', () => {
        const sys = JSON.stringify({ LastCalculation: 'x', ExistingSchedule: [7], Version: 5.0 });
        const job = { timespec: '0 0 23 * * *', calls: [{ method: 'Switch.Set', params: { id: 0, on: true } }] };
        const sim = createShelly({ deviceInfo: GEN3, now: NORMAL_DAY.now, kvs: { SmartHeatingSys1: sys }, schedules: { 7: job }, components: vc(PERIOD_12), rpcFail: { 'shelly.getcomponents': -108 } }).load().runFor(120);
        assert.equal(sim.crashed, null, sim.logs.join('\n'));
        assert.ok(sim.logs.some((line) => line.indexOf('Virtual components not read, the schedules are kept') >= 0), sim.logs.join('\n'));
        assert.ok(sim.schedules.has(7));
        assert.equal(sim.httpRequests.length, 0);
        assert.equal(sim.eval('_.isLp'), false);
        sim.setRpcFail({}).runFor(6 * 60);
        assert.equal(sim.schedules.has(7), false);
        assert.deepEqual(sim.timespecs(), expectedTimespecs(NORMAL_DAY, Object.assign({}, DEFAULT_CONF, { TimePeriod: 12, HeatingTime: 3 })));
    });
});
