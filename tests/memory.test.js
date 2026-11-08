'use strict';
/*
A rough memory comparison of v4.9 and the current script while prices are fetched and
planned: the largest base64 answer plus its decoded text (both live during atob), the
longest substring copy and the largest array the script builds. It counts data, not the
engine's per-variable overhead, so it does not replace measuring mem_peak on a device.
*/
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createShelly, SCRIPT } = require('./harness');

const { LEGACY_SCRIPT, QUARTER_OWNER_CONF, NORMAL_DAY, AUTUMN_DAY } = require('./settings');

const DAYS = [NORMAL_DAY, AUTUMN_DAY].map((day) => [day.isoDate, day.fixture, day.now]);

function measure(scriptFile, elering, now) {
    const sim = createShelly({ scriptFile, elering, now, kvs: { SmartHeatingConf1: JSON.stringify(QUARTER_OWNER_CONF) } }).load(true).runFor(120);
    assert.equal(sim.crashed, null, sim.logs.join('\n'));
    const m = sim.metrics;
    return Object.assign({ transientUpperBound: m.atobBytes + m.maxSubstring + m.maxArrayJson }, m);
}

describe('memory while fetching and planning prices', () => {
    for (const [name, fixture, now] of DAYS) {
        it(`uses less transient data than v4.9 on the ${name}`, (t) => {
            const legacy = measure(LEGACY_SCRIPT, fixture, now);
            const current = measure(SCRIPT, fixture, now);
            t.diagnostic(`v4.9    ${JSON.stringify(legacy)}`);
            t.diagnostic(`current ${JSON.stringify(current)}`);
            assert.ok(current.atobBytes < legacy.atobBytes);
            assert.ok(current.maxSubstring < legacy.maxSubstring);
            assert.ok(current.transientUpperBound < legacy.transientUpperBound);
        });
    }
});
