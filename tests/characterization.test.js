'use strict';
/*
Characterization tests of hourly planning. "Invariants" describe behaviour every version
must keep (user settings, heating duration, fallback, watchdog) and "hourly planning" pins
the hour-based schedules; both run against the copy of v4.9 in tests/legacy/ (v4.9 plus the
three bug fixes of this branch) and the current script in its default hourly mode.
*/
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createShelly, runWatchdog, SCRIPT } = require('./harness');
const oracle = require('./oracle');
const { LEGACY_SCRIPT, DEFAULT_CONF, OWNER_CONF, HOT_WATER_CONF, FALLBACK_LOG, storedForm, NORMAL_DAY, HOT_WATER_DAY, NEGATIVE_DAY } = require('./settings');

// v4.9 stores every key, the current script leaves the defaults out
const stored = (variant, conf) => (variant.name === 'v4.9' ? conf : storedForm(conf));

// v4.9 compares the provider with the misspelt "Elektlevi", the current script with "Elektrilevi"
const setFees = (sim, pack, variant) => sim.eval(`_.prov = "${variant.name === 'v4.9' ? 'Elektlevi' : 'Elektrilevi'}"; _.fee = pack().${pack};`);
const VARIANTS = [
    { name: 'v4.9', file: LEGACY_SCRIPT },
    { name: 'current', file: SCRIPT },
];

const COLD_TEMPS = new Array(24).fill(-4); // fcTm = 20 * -0.5 + 18 = 8 h

function kvsWith(conf) {
    return { SmartHeatingConf1: JSON.stringify(Object.assign({}, DEFAULT_CONF, conf)) };
}

function run(file, options) {
    const sim = createShelly(Object.assign({ scriptFile: file }, options)).load().runFor(120);
    assert.equal(sim.crashed, null, sim.logs.join('\n'));
    return sim;
}

for (const variant of VARIANTS) {
    describe(`invariants (${variant.name})`, () => {
        it('keeps the user configuration in KVS unchanged', () => {
            const sim = run(variant.file, { kvs: { SmartHeatingConf1: JSON.stringify(OWNER_CONF) } });
            assert.deepEqual(sim.json('SmartHeatingConf1'), stored(variant, OWNER_CONF));
        });

        it('keeps the network package name after planning', () => {
            const sim = run(variant.file, { kvs: kvsWith({}) });
            assert.equal(sim.eval('c.pack'), 'VORK2');
        });

        it('writes the default configuration on first install', () => {
            const sim = run(variant.file, {});
            assert.deepEqual(sim.json('SmartHeatingConf1'), stored(variant, DEFAULT_CONF));
        });

        it('heats HeatingTime hours a day', () => {
            const sim = run(variant.file, { kvs: kvsWith({}) });
            assert.equal(oracle.heatingMinutes(sim), 10 * 60);
        });

        for (const [period, hours] of [[12, 3], [6, 2]]) {
            it(`heats HeatingTime hours in each ${period} h period`, () => {
                const sim = run(variant.file, { kvs: kvsWith({ TimePeriod: period, HeatingTime: hours }) });
                assert.equal(oracle.heatingMinutes(sim), (24 / period) * hours * 60);
            });
        }

        it('derives the heating hours from the weather forecast', () => {
            const sim = run(variant.file, { kvs: kvsWith({ IsForecastUsed: true }), temps: COLD_TEMPS });
            assert.equal(oracle.heatingMinutes(sim), 8 * 60);
            assert.ok(sim.httpRequests[0].indexOf('forecast_hours=24') > 0);
        });

        it('falls back to HeatingTime hours when Elering is unreachable', () => {
            const sim = run(variant.file, { kvs: kvsWith({}), httpFail: /elering/ });
            assert.equal(oracle.heatingMinutes(sim), 10 * 60);
            assert.ok(sim.logs.some((line) => FALLBACK_LOG.test(line)));
        });

        it('falls back to HeatingTime hours when the forecast is unreachable', () => {
            const sim = run(variant.file, { kvs: kvsWith({ IsForecastUsed: true }), httpFail: /open-meteo/ });
            assert.equal(oracle.heatingMinutes(sim), 10 * 60);
        });

        it('logs and uses defaults when the KVS configuration is not JSON', () => {
            const broken = '{"TimePeriod":24,';
            const sim = run(variant.file, { kvs: { SmartHeatingConf1: broken } });
            assert.ok(sim.logs.some((line) => line.indexOf('ConfigurationData in KVS is not valid JSON') >= 0));
            if (variant.name === 'v4.9') assert.deepEqual(sim.json('SmartHeatingConf1'), DEFAULT_CONF);
            else assert.equal(sim.kvs.SmartHeatingConf1, broken, 'the broken value stays for the user to fix');
            assert.equal(oracle.heatingMinutes(sim), 10 * 60);
        });

        it('logs and keeps running when the KVS system data is not JSON', () => {
            const sim = run(variant.file, { kvs: Object.assign(kvsWith({}), { SmartHeatingSys1: 'garbage' }) });
            assert.ok(sim.logs.some((line) => line.indexOf('SystemData in KVS is not valid JSON') >= 0));
            assert.equal(oracle.heatingMinutes(sim), 10 * 60);
        });

        it('falls back to HeatingTime hours when the forecast is not JSON', () => {
            const sim = run(variant.file, { kvs: kvsWith({ IsForecastUsed: true }), forecastText: '<html>busy</html>' });
            assert.ok(sim.logs.some((line) => /Forecast response is not valid JSON|Forecast answer has no/.test(line)));
            assert.equal(oracle.heatingMinutes(sim), 10 * 60);
        });

        it('does not heat above AlwaysOffPrice', () => {
            const sim = run(variant.file, { kvs: kvsWith({ AlwaysOnPrice: -20, AlwaysOffPrice: -10 }) });
            assert.equal(sim.schedules.size, 0);
        });

        it('deletes the previous schedule before creating a new one', () => {
            const sim = run(variant.file, {
                kvs: Object.assign(kvsWith({}), { SmartHeatingSys1: JSON.stringify({ LastCalculation: 'x', ExistingSchedule: 7, Version: 4.9 }) }),
                schedules: { 7: { timespec: '0 0 23 * * *', calls: [{ method: 'Switch.Set', params: { id: 0, on: true } }] } },
            });
            assert.equal(sim.schedules.has(7), false);
            assert.ok(sim.schedules.size > 0);
        });

        it('installs and starts a watchdog script', () => {
            const sim = run(variant.file, { kvs: kvsWith({}) });
            assert.ok(sim.calls.some((call) => call.method === 'Script.Create' && call.params.name === 'watchdog'));
            assert.ok(sim.scriptCode[2].length > 0);
            assert.ok(sim.calls.some((call) => call.method === 'Script.Start' && call.params.id === 2));
        });

        it('lets the watchdog delete the schedules when the script stops', () => {
            const sim = run(variant.file, { kvs: kvsWith({}) });
            assert.ok(sim.schedules.size > 0);
            const watchdog = runWatchdog(sim, sim.scriptCode[2], 1);
            assert.equal(watchdog.crashed, null, watchdog.logs.join('\n'));
            assert.equal(sim.schedules.size, 0);
            const remaining = [].concat(sim.json('SmartHeatingSys1').ExistingSchedule).filter(Boolean);
            assert.deepEqual(remaining, []);
        });


        describe('Elektrilevi network fee', () => {
            const cases = [
                ['winter weekday morning peak', '2026-01-14T10:00:00+02:00', 'VORK5', 81.8],
                ['winter weekday evening peak', '2026-01-14T17:00:00+02:00', 'VORK5', 81.8],
                ['winter weekend evening peak', '2026-01-17T17:00:00+02:00', 'VORK5', 47.4],
                ['winter weekend morning is night rate', '2026-01-17T10:00:00+02:00', 'VORK5', 30.3],
                ['winter weekday day', '2026-01-14T13:00:00+02:00', 'VORK5', 52.9],
                ['winter weekday night', '2026-01-14T23:00:00+02:00', 'VORK5', 30.3],
                ['summer weekday day', '2026-06-10T10:00:00+03:00', 'VORK2', 60.7],
                ['summer weekday early morning', '2026-06-10T06:45:00+03:00', 'VORK2', 35.1],
                ['summer weekend day', '2026-06-13T12:00:00+03:00', 'VORK4', 21],
            ];
            for (const [name, at, pack, fee] of cases) {
                it(name, () => {
                    const sim = createShelly({ scriptFile: variant.file }).load();
                    setFees(sim, pack, variant);
                    const ts = Date.parse(at) / 1000;
                    assert.equal(sim.eval(`fFee(${ts})`), fee);
                    assert.equal(oracle.elektrileviFee(ts, pack), fee);
                });
            }
        });

        describe('Imatra and Latvia network fee (current script, _.smr is the summer time flag)', { skip: variant.name === 'v4.9' }, () => {
            const cases = [
                ['summer weekday before 8 is night', '2026-06-10T07:30:00+03:00', true, 42],
                ['summer weekday day', '2026-06-10T08:30:00+03:00', true, 72.4],
                ['summer weekend is night', '2026-06-13T12:00:00+03:00', true, 42],
                ['winter weekday evening is day until 23', '2026-01-14T22:30:00+02:00', false, 72.4],
                ['winter weekday night', '2026-01-14T23:30:00+02:00', false, 42],
            ];
            for (const [name, at, summer, fee] of cases) {
                it(name, () => {
                    const sim = createShelly({ scriptFile: variant.file }).load();
                    sim.eval(`_.prov = "Imatra"; _.fee = pack().PARTN12; _.smr = ${summer};`);
                    assert.equal(sim.eval(`fFee(${Date.parse(at) / 1000})`), fee);
                });
            }

            it('Latvia has one rate', () => {
                const sim = createShelly({ scriptFile: variant.file }).load();
                sim.eval('_.prov = "Lv"; _.fee = pack().PAMATA1;');
                assert.equal(sim.eval(`fFee(${Date.parse('2026-01-14T23:30:00+02:00') / 1000})`), 39.62);
            });
        });
    });
}

for (const variant of VARIANTS) {
    describe(`hourly planning (${variant.name})`, () => {
        it('schedules the cheapest hours with one hourly schedule', () => {
            const sim = run(variant.file, { kvs: kvsWith({}) });
            const hours = oracle.cheapestHours(NORMAL_DAY.fixture, NORMAL_DAY.isoDate, 'VORK2', 10);
            assert.deepEqual(sim.timespecs(), ['0 0 ' + hours.join(',') + ' * * *']);
        });

        it('turns the relay off one hour and ten seconds after each start', () => {
            const sim = run(variant.file, { kvs: kvsWith({}) });
            assert.deepEqual(sim.switchConfig, { auto_on: false, auto_on_delay: 3610, auto_off: true, auto_off_delay: 3610 });
            const job = [...sim.schedules.values()][0];
            assert.deepEqual(job.calls, [{ method: 'Switch.Set', params: { id: 0, on: true } }]);
        });

        it('stores one schedule ID and the version in SmartHeatingSys', () => {
            const sim = run(variant.file, { kvs: kvsWith({}) });
            const sys = sim.json('SmartHeatingSys1');
            const id = [...sim.schedules.keys()][0];
            assert.deepEqual(sys.ExistingSchedule, variant.name === 'v4.9' ? id : [id]);
            assert.equal(sys.Version, sim.eval('_.newV'));
        });

        it('picks the cheapest hours per 12 h period', () => {
            const sim = run(variant.file, { kvs: kvsWith({ TimePeriod: 12, HeatingTime: 3 }) });
            const hours = oracle.slotPlan(NORMAL_DAY.fixture, NORMAL_DAY.isoDate, { tPer: 12, slotsPerPeriod: 3, lowR: 1, higR: 300, pack: 'VORK2', sltM: 60 }).map((slot) => slot.hour);
            assert.deepEqual(sim.timespecs(), ['0 0 ' + hours.join(',') + ' * * *']);
        });

        it('heats every hour below AlwaysOnPrice without a period', () => {
            const sim = run(variant.file, { kvs: kvsWith({ TimePeriod: 0, AlwaysOnPrice: 1 }), elering: NEGATIVE_DAY.fixture, now: NEGATIVE_DAY.now });
            const hours = oracle.hourlyPrices(NEGATIVE_DAY.fixture, NEGATIVE_DAY.isoDate, 'VORK2').filter((h) => h.net < 1).map((h) => h.hour);
            assert.ok(hours.length > 0);
            assert.deepEqual(sim.timespecs(), ['0 0 ' + hours.join(',') + ' * * *']);
        });

        it('reproduces the hot water device schedule seen on 2026-10-08', () => {
            const sim = run(variant.file, { kvs: { SmartHeatingConf1: JSON.stringify(HOT_WATER_CONF) }, elering: HOT_WATER_DAY.fixture, now: HOT_WATER_DAY.now });
            assert.deepEqual(sim.timespecs(), ['0 0 3,4,6,7,14,15,22,23 * * *']);
        });

        it('uses the historically cheap hours as the manual schedule', () => {
            const sim = run(variant.file, { kvs: kvsWith({}), httpFail: /elering/ });
            assert.deepEqual(sim.timespecs(), ['0 0 0,1,2,3,4,5,6,7,8,9 * * *']);
        });

        it('rounds the forecast heating time down to whole hours', () => {
            const temps = new Array(24).fill(-3); // fcTm = 19 * -0.5 + 17 = 7.5 h
            const sim = run(variant.file, { kvs: kvsWith({ IsForecastUsed: true }), temps });
            assert.equal(oracle.heatingMinutes(sim), 7 * 60);
        });
    });
}

describe('hourly planning (v4.9 only)', () => {
    it("asks Elering for tomorrow's prices in one request after 23:00", () => {
        const sim = run(LEGACY_SCRIPT, { kvs: kvsWith({}) });
        assert.deepEqual(sim.httpRequests, ['https://dashboard.elering.ee/api/nps/price/csv?fields=ee&start=2026-10-06T21:00Z&end=2026-10-07T21:00Z']);
    });
});
