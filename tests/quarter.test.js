'use strict';
/*
Slot planning of the current script: the cheapest slots per period for every SlotMinutes
value, one Schedule per quarter of the hour, auto-off after one slot, the optional keys
MaxFullPrice and SlotMinutes, the manual schedule and the time of the daily calculation.
Expected slots come from tests/oracle.js.
*/
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createShelly } = require('./harness');
const oracle = require('./oracle');
const { expectedPlan } = require('./expect');
const {
    KVS_VALUE_LIMIT, kvsLength, storedForm, MAX_QUARTER_SCHEDULES, DAY_SECONDS, FALLBACK_LOG, QUARTER_CONF, QUARTER_OWNER_CONF, QUARTER_HOT_WATER_CONF,
    NORMAL_DAY, HOT_WATER_DAY, SPRING_DAY, AUTUMN_DAY, NEGATIVE_DAY,
} = require('./settings');

const TWO_DAYS = [NORMAL_DAY.fixture, HOT_WATER_DAY.fixture];

const ALL_SLOT_MINUTES = [15, 30, 60, 120, 180, 240];
// Full price limit (EUR/MWh with VAT) near the median of the normal day, so both sides have slots
const HALF_DAY_FULL_PRICE = 83;

function run(conf, options = {}, day = NORMAL_DAY) {
    const kvs = { SmartHeatingConf1: JSON.stringify(Object.assign({}, QUARTER_CONF, conf)) };
    const sim = createShelly(Object.assign({ kvs, elering: day.fixture, now: day.now }, options)).load().runFor(120);
    assert.equal(sim.crashed, null, sim.logs.join('\n'));
    return sim;
}

function expected(day, conf, extra) {
    return expectedPlan(day, Object.assign({}, QUARTER_CONF, conf), extra);
}

function assertPlan(sim, slots, slotMinutes = 15) {
    assert.ok(slots.length > 0, 'the case must heat something');
    assert.deepEqual(sim.timespecs(), oracle.slotTimespecs(slots));
    assert.ok(sim.schedules.size <= MAX_QUARTER_SCHEDULES);
    assert.equal(sim.switchConfig.auto_off_delay, slotMinutes * 60 + 10);
    assert.equal(oracle.heatingMinutes(sim), distinctStarts(slots) * slotMinutes);
}

// A schedule fires once per clock time, so the repeated hour of the autumn DST day counts once
function distinctStarts(slots) {
    return new Set(slots.map((slot) => slot.hour + ':' + slot.minute)).size;
}

function assertNoFallback(sim) {
    assert.equal(sim.logs.some((line) => FALLBACK_LOG.test(line)), false, sim.logs.join('\n'));
}

function storedConf(sim) {
    return sim.json('SmartHeatingConf1');
}

describe('15 minute planning', () => {
    it('schedules the cheapest quarter-hours of a normal day', () => {
        const sim = run({});
        assertNoFallback(sim);
        const slots = expected(NORMAL_DAY, {});
        assert.equal(slots.length, 40);
        assertPlan(sim, slots);
    });

    it('turns the relay on at each slot and off after 15 min and ten seconds', () => {
        const sim = run({});
        assert.deepEqual(sim.switchConfig, { auto_on: false, auto_on_delay: 910, auto_off: true, auto_off_delay: 910 });
        for (const job of sim.schedules.values()) {
            assert.deepEqual(job.calls, [{ method: 'Switch.Set', params: { id: 0, on: true } }]);
            assert.match(job.timespec, /^0 (0|15|30|45) \d+(,\d+)* \* \* \*$/);
        }
    });

    it('turns an inverted relay off at each slot', () => {
        const sim = run({ InvertedRelay: true });
        assert.equal(sim.switchConfig.auto_on, true);
        for (const job of sim.schedules.values()) assert.equal(job.calls[0].params.on, false);
    });

    it("asks Elering for tomorrow's prices in 6 h parts once today's last quarter has started", () => {
        const sim = run({});
        const base = 'https://dashboard.elering.ee/api/nps/price/csv?fields=ee&start=';
        assert.deepEqual(sim.httpRequests, [
            base + '2026-10-06T21:00:00.000Z&end=2026-10-07T03:00:00.000Z',
            base + '2026-10-07T03:00:00.000Z&end=2026-10-07T09:00:00.000Z',
            base + '2026-10-07T09:00:00.000Z&end=2026-10-07T15:00:00.000Z',
            base + '2026-10-07T15:00:00.000Z&end=2026-10-07T21:00:00.000Z',
        ]);
    });

    for (const now of ['2026-10-07T14:10:00+03:00', '2026-10-07T23:20:00+03:00']) {
        it(`asks Elering for today's prices at ${now.slice(11, 16)}, before the last quarter`, () => {
            const sim = run({}, { now });
            assert.ok(sim.httpRequests[0].indexOf('start=2026-10-06T21:00:00.000Z') > 0);
            assertPlan(sim, expected(NORMAL_DAY, {}));
        });
    }

    it('plans the 92 quarter-hours of the spring DST day', () => {
        const sim = run({}, {}, SPRING_DAY);
        assertNoFallback(sim);
        assert.equal(sim.eval('_.nRw'), 92);
        assert.ok(sim.httpRequests[sim.httpRequests.length - 1].endsWith('end=2026-03-29T21:00:00.000Z'));
        assertPlan(sim, expected(SPRING_DAY, {}));
    });

    it('plans the 100 quarter-hours of the autumn DST day, the repeated hour once', () => {
        const conf = { HeatingTime: 24, AlwaysOffPrice: 60 };
        const sim = run(conf, {}, AUTUMN_DAY);
        assertNoFallback(sim);
        assert.equal(sim.eval('_.nRw'), 100);
        assert.ok(sim.httpRequests[sim.httpRequests.length - 1].endsWith('end=2025-10-26T22:00:00.000Z'));
        const slots = expected(AUTUMN_DAY, conf);
        assert.ok(slots.length > distinctStarts(slots), 'both 03:xx hours are cheap enough on this day');
        assertPlan(sim, slots);
    });

    it('heats every quarter below AlwaysOnPrice on top of the cheapest ones', () => {
        const conf = { HeatingTime: 2 };
        const sim = run(conf, {}, NEGATIVE_DAY);
        const slots = expected(NEGATIVE_DAY, conf);
        assert.ok(slots.length > 8);
        assertPlan(sim, slots);
    });

    it('heats only the quarters below AlwaysOnPrice without a period', () => {
        const conf = { TimePeriod: 0, AlwaysOnPrice: 1 };
        const sim = run(conf, {}, NEGATIVE_DAY);
        const slots = expected(NEGATIVE_DAY, conf);
        assert.ok(slots.length > 0 && slots.length < 96);
        assertPlan(sim, slots);
    });

    for (const [period, hours] of [[24, 10], [12, 3], [6, 2]]) {
        it(`picks the cheapest quarter-hours per ${period} h period`, () => {
            const conf = { TimePeriod: period, HeatingTime: hours };
            const slots = expected(NORMAL_DAY, conf);
            assert.equal(slots.length, (24 / period) * hours * 4);
            assertPlan(run(conf), slots);
        });
    }

    it('picks 92 of 96 quarter-hours from the expensive end when HeatingTime is 23', () => {
        const conf = { HeatingTime: 23 };
        const slots = expected(NORMAL_DAY, conf);
        assert.equal(slots.length, 92);
        assertPlan(run(conf), slots);
    });

    for (const slotMinutes of [15, 60]) {
        for (const period of [24, 12, 6]) {
            it(`heats the whole spring DST day with ${slotMinutes} min slots when HeatingTime fills the ${period} h period`, () => {
                const conf = { TimePeriod: period, HeatingTime: period, AlwaysOnPrice: -500, SlotMinutes: slotMinutes };
                const sim = run(conf, {}, SPRING_DAY);
                assertNoFallback(sim);
                const slots = expected(SPRING_DAY, conf);
                assert.equal(slots.length, 23 * 60 / slotMinutes);
                assertPlan(sim, slots, slotMinutes);
            });
        }
    }

    for (const [name, body] of [
        ['23 of 24 temperatures', JSON.stringify({ hourly: { apparent_temperature: new Array(23).fill(-4) } })],
        ['a null temperature', JSON.stringify({ hourly: { apparent_temperature: new Array(23).fill(-4).concat([null]) } })],
    ]) {
        it(`uses the fallback schedule when the forecast has ${name}`, () => {
            const sim = run({ IsForecastUsed: true }, { forecastText: body });
            assert.ok(sim.logs.some((line) => line.indexOf('Forecast answer has no 24 temperatures') >= 0), sim.logs.join('\n'));
            assert.ok(sim.logs.some((line) => FALLBACK_LOG.test(line)));
            assert.equal(oracle.heatingMinutes(sim), 10 * 60);
        });
    }

    it('plans with no network fee and a log line for an unknown EnergyProvider', () => {
        const sim = run({ EnergyProvider: 'VORK3' });
        assert.ok(sim.logs.some((line) => line.indexOf('EnergyProvider VORK3 is unknown') >= 0), sim.logs.join('\n'));
        assertPlan(sim, expected(NORMAL_DAY, { EnergyProvider: 'NONE' }));
    });

    for (const day of [NORMAL_DAY, HOT_WATER_DAY]) {
        it(`plans the hot water settings for ${day.isoDate} in at most 4 schedules`, () => {
            const sim = run(QUARTER_HOT_WATER_CONF, {}, day);
            assertNoFallback(sim);
            const slots = expected(day, QUARTER_HOT_WATER_CONF);
            assert.ok(slots.length >= 4 * 8);
            assertPlan(sim, slots);
        });
    }

    it('never heats above AlwaysOffPrice', () => {
        const conf = { HeatingTime: 24, AlwaysOffPrice: 50 };
        const slots = expected(NORMAL_DAY, conf);
        assert.ok(slots.length < 96);
        assertPlan(run(conf), slots);
    });

    it('uses the forecast heating time in quarter-hours', () => {
        const temps = new Array(24).fill(-3); // fcTm = 7.5 h = 30 slots
        const sim = run({ IsForecastUsed: true }, { temps });
        assertPlan(sim, expected(NORMAL_DAY, { IsForecastUsed: true }, { slotsPerPeriod: 30 }));
    });

    it('adds one hour of heating a day per HeatingCurve step', () => {
        const temps = new Array(24).fill(0); // (16 - 0) * 0.5 - 2 = 6 h, plus the curve
        for (const [curve, hours] of [[0, 6], [2, 8], [-4, 2]]) {
            const sim = run({ IsForecastUsed: true, HeatingCurve: curve }, { temps });
            assert.equal(oracle.heatingMinutes(sim), hours * 60, `HeatingCurve ${curve}`);
        }
    });

    it("plans the owner's settings with the forecast fixture", () => {
        // fixture "feels like" average rounds up to 10 C: fcTm = 6 * -0.5 + 4 = 1 h = 4 slots
        const sim = run(QUARTER_OWNER_CONF);
        assertNoFallback(sim);
        assertPlan(sim, expected(NORMAL_DAY, QUARTER_OWNER_CONF, { slotsPerPeriod: 4 }));
    });

    it('plans only the current period with the forecast', () => {
        const conf = { TimePeriod: 12, HeatingTime: 3, IsForecastUsed: true };
        const temps = new Array(24).fill(-4); // fcTm = 8 h a day, 4 h = 16 slots per period
        const sim = run(conf, { temps, now: '2026-10-07T11:50:00+03:00' });
        assert.ok(sim.httpRequests[0].indexOf('forecast_hours=12') > 0);
        assertPlan(sim, expected(NORMAL_DAY, conf, { slotsPerPeriod: 16, periods: [1] }));
    });
});

describe('MaxFullPrice', () => {
    const CAP_CONF = { HeatingTime: 24, EnergyProvider: 'VORK4', AlwaysOnPrice: -200, AlwaysOffPrice: 300, MaxFullPrice: 110 };

    it('drops the quarter-hours whose full price is above the limit', () => {
        const sim = run(CAP_CONF);
        assertNoFallback(sim);
        const slots = expected(NORMAL_DAY, CAP_CONF);
        const withoutCap = expected(NORMAL_DAY, Object.assign({}, CAP_CONF, { MaxFullPrice: 0 }));
        assert.ok(slots.length > 0 && slots.length < withoutCap.length, slots.length + ' of ' + withoutCap.length);
        assertPlan(sim, slots);
    });

    it('applies the limit to hourly slots too', () => {
        const conf = Object.assign({}, CAP_CONF, { SlotMinutes: 60 });
        const slots = expected(NORMAL_DAY, conf);
        assert.ok(slots.length > 0 && slots.length < 24);
        assertPlan(run(conf), slots, 60);
    });

    it('applies the limit without a period as well', () => {
        const conf = { TimePeriod: 0, AlwaysOnPrice: 200, MaxFullPrice: HALF_DAY_FULL_PRICE };
        const sim = run(conf);
        const slots = expected(NORMAL_DAY, conf);
        assert.ok(slots.length > 0 && slots.length < 96);
        assertPlan(sim, slots);
    });

    it('is switched off for a country whose charges are not known', () => {
        const conf = Object.assign({}, CAP_CONF, { Country: 'lv' });
        const sim = run(conf);
        assert.ok(sim.logs.some((line) => line.indexOf('MaxFullPrice is ignored') >= 0), sim.logs.join('\n'));
        assertPlan(sim, expected(NORMAL_DAY, Object.assign({}, conf, { MaxFullPrice: 0 })));
    });

    it('is switched off again when the key is removed from KVS', () => {
        const sim = run(CAP_CONF, { now: '2026-10-07T14:10:00+03:00', elering: TWO_DAYS });
        assert.equal(sim.eval('c.fulR'), 110);
        const withoutKey = Object.assign({}, QUARTER_CONF, CAP_CONF);
        delete withoutKey.MaxFullPrice;
        sim.kvs.SmartHeatingConf1 = JSON.stringify(withoutKey);
        sim.runFor(DAY_SECONDS);
        assertNoFallback(sim);
        assert.equal(sim.eval('c.fulR'), 0);
        assert.equal('MaxFullPrice' in storedConf(sim), false);
        assert.deepEqual(sim.timespecs(), oracle.slotTimespecs(expected(HOT_WATER_DAY, Object.assign({}, CAP_CONF, { MaxFullPrice: 0 }))));
    });

    it('is stored only when set and the configuration stays within the KVS value limit', () => {
        const conf = Object.assign({}, QUARTER_OWNER_CONF, { MaxFullPrice: 110 });
        const sim = run(conf, { now: '2026-10-07T14:10:00+03:00' });
        assert.deepEqual(storedConf(sim), storedForm(conf));
        assert.ok(kvsLength(sim.kvs.SmartHeatingConf1) <= KVS_VALUE_LIMIT, sim.kvs.SmartHeatingConf1);
        assert.ok(kvsLength(JSON.stringify(conf)) > KVS_VALUE_LIMIT, 'the full configuration would not fit, the defaults must be left out');
        const without = run(QUARTER_OWNER_CONF, { now: '2026-10-07T14:10:00+03:00' });
        assert.equal('MaxFullPrice' in storedConf(without), false);
    });

    it('logs and ignores a value that is not a number', () => {
        const sim = run({ MaxFullPrice: '110' });
        assert.ok(sim.logs.some((line) => line.indexOf('is not a number') >= 0));
        assert.equal(sim.eval('c.fulR'), 0);
        assert.equal('MaxFullPrice' in storedConf(sim), false);
    });
});

describe('SlotMinutes', () => {
    it('is not stored when the key is missing', () => {
        const sim = run({ SlotMinutes: undefined });
        assert.equal(sim.switchConfig.auto_off_delay, 3610);
        assert.equal('SlotMinutes' in storedConf(sim), false);
    });

    for (const slotMinutes of ALL_SLOT_MINUTES) {
        it(`plans ${slotMinutes} minute slots against the oracle`, () => {
            const conf = { HeatingTime: 10, SlotMinutes: slotMinutes };
            const slots = expected(NORMAL_DAY, conf);
            assert.equal(slots.length, Math.floor(10 * 60 / slotMinutes));
            const sim = run(conf);
            assertPlan(sim, slots, slotMinutes);
            assert.deepEqual(storedConf(sim).SlotMinutes, slotMinutes === 60 ? undefined : slotMinutes);
        });
    }

    for (const day of [SPRING_DAY, AUTUMN_DAY]) {
        for (const period of [24, 12, 6]) {
            it(`plans hourly slots of the ${day.isoDate} DST day per ${period} h period`, () => {
                const conf = { TimePeriod: period, HeatingTime: 2, SlotMinutes: 60 };
                const sim = run(conf, {}, day);
                assertNoFallback(sim);
                assertPlan(sim, expected(day, conf), 60);
            });
        }
    }

    it('leaves out the incomplete last slot of a DST day, so the relay is off by midnight', () => {
        const conf = { HeatingTime: 24, AlwaysOnPrice: 1000, SlotMinutes: 240 };
        const sim = run(conf, {}, AUTUMN_DAY);
        const slots = expected(AUTUMN_DAY, conf);
        assert.equal(slots.length, 6, 'six four-hour slots, the 25th hour is not planned');
        assert.deepEqual(sim.timespecs(), oracle.slotTimespecs(slots));
        assert.deepEqual(sim.timespecs(), ['0 0 0,3,7,11,15,19 * * *']);
        assert.equal(sim.switchConfig.auto_off_delay, 240 * 60 + 10);
        assert.equal(oracle.heatingMinutes(sim), 23 * 60, 'the repeated 03:00 hour counts once and 23:00 is not heated');
    });

    it('logs when HeatingTime is rounded down to whole slots', () => {
        const sim = run({ HeatingTime: 3, SlotMinutes: 240 });
        assert.ok(sim.logs.some((line) => line.indexOf('Heating time 3 h is rounded down to 0 slots of 240 min') >= 0), sim.logs.join('\n'));
        assert.equal(sim.schedules.size, 0);
    });

    it('survives the script writing the configuration back to KVS', () => {
        const sim = run(QUARTER_OWNER_CONF, { now: '2026-10-07T14:10:00+03:00', elering: TWO_DAYS });
        sim.runFor(DAY_SECONDS);
        assertNoFallback(sim);
        assert.deepEqual(storedConf(sim), storedForm(QUARTER_OWNER_CONF));
        assert.equal(sim.switchConfig.auto_off_delay, 910);
        assert.ok(sim.timespecs().length > 0 && sim.timespecs().length <= MAX_QUARTER_SCHEDULES);
    });

    for (const [when, summer] of [['2026-07-15T23:50:00+03:00', true], ['2026-01-15T23:50:00+02:00', false]]) {
        it(`reads the summer time flag from the device clock (${when.slice(0, 7)})`, () => {
            const sim = run({ EnergyProvider: 'PARTN12' }, { now: when, elering: null });
            assert.equal(sim.eval('_.smr'), summer);
        });
    }

    for (const [conf, reason] of [
        [{ SlotMinutes: 90 }, 'a value outside the supported list'],
        [{ SlotMinutes: 240, TimePeriod: 6 }, 'a slot that does not divide the period'],
        [{ SlotMinutes: '15' }, 'a value that is not a number'],
    ]) {
        it(`falls back to hourly slots with a log line for ${reason}`, () => {
            const sim = run(conf);
            assert.ok(sim.logs.some((line) => line.indexOf('SlotMinutes') >= 0 && line.indexOf('must be 15, 30, 60, 120, 180 or 240') >= 0), sim.logs.join('\n'));
            assert.equal(sim.switchConfig.auto_off_delay, 3610);
            assert.equal(sim.timespecs().length, 1);
            assert.equal('SlotMinutes' in storedConf(sim), false);
        });
    }
});

describe('manual schedule', () => {
    it('heats the historically cheap hours in all quarters when Elering fails', () => {
        const sim = run({}, { httpFail: /elering/ });
        const hours = '0,1,2,3,4,5,6,7,8,9';
        assert.deepEqual(sim.timespecs(), ['0 0 ' + hours + ' * * *', '0 15 ' + hours + ' * * *', '0 30 ' + hours + ' * * *', '0 45 ' + hours + ' * * *']);
        assert.equal(sim.switchConfig.auto_off_delay, 910);
    });

    it('heats a part of an hour from the first quarters', () => {
        const sim = run({ HeatingTime: 2.5 }, { httpFail: /elering/ });
        assert.deepEqual(sim.timespecs(), ['0 0 0,1,2 * * *', '0 15 0,1,2 * * *', '0 30 0,1 * * *', '0 45 0,1 * * *']);
    });

    it('heats each period from its own historically cheap hours', () => {
        const sim = run({ TimePeriod: 12, HeatingTime: 3 }, { httpFail: /elering/ });
        const hours = '0,1,2,12,13,14';
        assert.deepEqual(sim.timespecs(), ['0 0 ' + hours + ' * * *', '0 15 ' + hours + ' * * *', '0 30 ' + hours + ' * * *', '0 45 ' + hours + ' * * *']);
    });

    it('heats whole half-hours with 30 minute slots', () => {
        const sim = run({ HeatingTime: 2, SlotMinutes: 30 }, { httpFail: /elering/ });
        assert.deepEqual(sim.timespecs(), ['0 0 0,1 * * *', '0 30 0,1 * * *']);
        assert.equal(oracle.heatingMinutes(sim), 2 * 60);
    });

    it('heats whole hours with two hour slots', () => {
        const sim = run({ HeatingTime: 6, SlotMinutes: 120 }, { httpFail: /elering/ });
        assert.deepEqual(sim.timespecs(), ['0 0 0,2,4 * * *']);
        assert.equal(sim.switchConfig.auto_off_delay, 7210);
    });

    for (const slotMinutes of [120, 240]) {
        it(`fills the whole day with ${slotMinutes} minute slots without a gap or an overrun`, () => {
            const sim = run({ HeatingTime: 24, SlotMinutes: slotMinutes }, { httpFail: /elering/ });
            assert.equal(oracle.heatingMinutes(sim), 24 * 60);
            const starts = sim.timespecs()[0].split(' ')[2].split(',').map(Number);
            assert.ok(Math.max(...starts) <= 24 - slotMinutes / 60);
        });
    }

    it('is used when Elering has not published the prices', () => {
        const sim = run({}, { elering: null });
        assert.ok(sim.logs.some((line) => line.indexOf("Elering API didn't return prices") >= 0));
        assert.equal(oracle.heatingMinutes(sim), 10 * 60);
        assert.equal(sim.httpRequests.length, 1, 'stops at the first empty part');
    });

    it('is used when a quarter is missing from the prices', () => {
        const missing = Date.parse('2026-10-07T13:15:00+03:00') / 1000;
        const sim = run({}, { eleringDrop: [missing] });
        assert.ok(sim.logs.some((line) => line.indexOf("Elering API didn't return prices") >= 0));
        assert.equal(oracle.heatingMinutes(sim), 10 * 60);
    });
});

describe('forecast periods', () => {
    // -25 C with HeatingCurve 10 asks for more heating than a 6 h period holds, so every slot of the period is planned
    const CONF = { TimePeriod: 6, HeatingTime: 6, IsForecastUsed: true, HeatingCurve: 10 };
    const COLD = new Array(24).fill(-25);
    const quarters = (hours) => ['0 0 ', '0 15 ', '0 30 ', '0 45 '].map((minute) => minute + hours + ' * * *');

    it('keeps the current period after a restart before its last slot', () => {
        const sim = run(CONF, { temps: COLD, now: '2026-10-07T05:20:00+03:00' });
        assert.deepEqual(sim.timespecs(), quarters('0,1,2,3,4,5'));
    });

    it('plans the next period at the calculation time', () => {
        const sim = run(CONF, { temps: COLD, now: '2026-10-07T05:50:00+03:00' });
        assert.deepEqual(sim.timespecs(), quarters('6,7,8,9,10,11'));
    });

    it("keeps today's last period after a restart at 23:20", () => {
        const sim = run(CONF, { temps: COLD, now: '2026-10-07T23:20:00+03:00' });
        assert.ok(sim.httpRequests.some((url) => url.indexOf('start=2026-10-06T21:00:00.000Z') > 0));
        assert.deepEqual(sim.timespecs(), quarters('18,19,20,21,22,23'));
    });
});

describe('daily calculation', () => {
    it("replans for tomorrow only after today's last quarter has started", () => {
        const sim = createShelly({ kvs: { SmartHeatingConf1: JSON.stringify(QUARTER_CONF) }, elering: NORMAL_DAY.fixture, now: '2026-10-07T14:10:00+03:00' }).load();
        sim.runFor(120);
        const firstRequests = sim.httpRequests.length;
        sim.runFor((Date.parse('2026-10-07T23:45:30+03:00') - sim.nowMs) / 1000);
        assert.equal(sim.httpRequests.length, firstRequests, 'no new calculation before 23:46');
        sim.runFor(10 * 60);
        assert.ok(sim.httpRequests.length > firstRequests, 'calculated between 23:46 and 23:56');
        assert.ok(sim.httpRequests[firstRequests].indexOf('start=2026-10-07T21:00:00.000Z') > 0);
        assert.equal(sim.crashed, null);
    });

    it('calculates once on the autumn DST night', () => {
        const sim = run({}, {}, AUTUMN_DAY);
        sim.runFor(10 * 60 * 60);
        assert.equal(sim.crashed, null, sim.logs.join('\n'));
        assert.equal(sim.httpRequests.length, 5, 'one calculation in five 6 h parts');
    });

    it('plans tomorrow when the cycle starts seconds before the last quarter and the answers are slow', () => {
        const sim = createShelly({ kvs: { SmartHeatingConf1: JSON.stringify(QUARTER_CONF) }, elering: TWO_DAYS, now: '2026-10-07T23:44:50+03:00', rpcDelayMs: { 'http.get': 3000 } }).load();
        sim.runFor(12 * 60);
        assert.ok(sim.httpRequests.some((url) => url.indexOf('start=2026-10-07T21:00:00.000Z') > 0), sim.httpRequests.join('\n'));
        assert.deepEqual(sim.timespecs(), oracle.slotTimespecs(expected(HOT_WATER_DAY, {})));
    });

    it('replans at 23:46 for tomorrow after a restart at 23:20 planned today', () => {
        const sim = createShelly({ kvs: { SmartHeatingConf1: JSON.stringify(QUARTER_CONF) }, elering: NORMAL_DAY.fixture, now: '2026-10-07T23:20:00+03:00' }).load();
        sim.runFor(10);
        const firstRequests = sim.httpRequests.length;
        assert.ok(sim.httpRequests[0].indexOf('start=2026-10-06T21:00:00.000Z') > 0, 'today first');
        sim.runFor(40 * 60);
        assert.ok(sim.httpRequests.length > firstRequests, 'replanned for tomorrow');
        assert.ok(sim.httpRequests[firstRequests].indexOf('start=2026-10-07T21:00:00.000Z') > 0);
    });
});
