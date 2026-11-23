'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { measure, hasBinary, BINARY } = require('./engine');
const { createShelly } = require('../harness');
const {
    DEFAULT_CONF, STORAGE_TANK_CONF, HOT_WATER_CONF,
    NORMAL_DAY, HOT_WATER_DAY, NEGATIVE_DAY, SPRING_DST_DAY, AUTUMN_DST_DAY,
    CYCLE_SECONDS, MILLISECONDS_PER_SECOND,
} = require('../settings');

const DEVICE_BLOCK_BYTES = 14;
const DEFAULT_SETTINGS = { name: 'default settings', conf: DEFAULT_CONF };
const STORAGE_TANK = { name: 'storage tank with forecast', conf: STORAGE_TANK_CONF };
const HOT_WATER = { name: 'hot water in 6 h periods', conf: HOT_WATER_CONF };
const VERSION_4_9 = [
    { settings: DEFAULT_SETTINGS, day: NORMAL_DAY, peakBytes: 15638, retainedBytes: 3794 },
    { settings: DEFAULT_SETTINGS, day: HOT_WATER_DAY, peakBytes: 15974, retainedBytes: 3794 },
    { settings: DEFAULT_SETTINGS, day: NEGATIVE_DAY, peakBytes: 15554, retainedBytes: 3794 },
    { settings: DEFAULT_SETTINGS, day: SPRING_DST_DAY, peakBytes: 15834, retainedBytes: 3794 },
    { settings: DEFAULT_SETTINGS, day: AUTUMN_DST_DAY, peakBytes: 15792, retainedBytes: 3794 },
    { settings: STORAGE_TANK, day: NORMAL_DAY, peakBytes: 15624, retainedBytes: 3780 },
    { settings: STORAGE_TANK, day: HOT_WATER_DAY, peakBytes: 15960, retainedBytes: 3780 },
    { settings: STORAGE_TANK, day: NEGATIVE_DAY, peakBytes: 15540, retainedBytes: 3780 },
    { settings: STORAGE_TANK, day: SPRING_DST_DAY, peakBytes: 15820, retainedBytes: 3780 },
    { settings: STORAGE_TANK, day: AUTUMN_DST_DAY, peakBytes: 15778, retainedBytes: 3780 },
    { settings: HOT_WATER, day: NORMAL_DAY, peakBytes: 15610, retainedBytes: 3766 },
    { settings: HOT_WATER, day: HOT_WATER_DAY, peakBytes: 15946, retainedBytes: 3766 },
    { settings: HOT_WATER, day: NEGATIVE_DAY, peakBytes: 15526, retainedBytes: 3766 },
    { settings: HOT_WATER, day: SPRING_DST_DAY, peakBytes: 15806, retainedBytes: 3766 },
    { settings: HOT_WATER, day: AUTUMN_DST_DAY, peakBytes: 15764, retainedBytes: 3766 },
];

const EMPTY_SCRIPT = { code: '', peakBytes: 280, retainedBytes: 84 };
const EMPTY_FUNCTION = 'function tick() {}';
const ONE_TIMER = ' Timer.set(1000, false, tick);';
const ONE_PENDING_TIMER = ' Timer.set(3600000, false, tick);';
const ONE_RPC_ANSWER = " Shelly.call('KVS.Get', { key: 'missing' }, tick);";
const EMPTY_FUNCTION_RETAINED_BYTES = 112;
const SCRIPTS_THAT_KEEP_NO_MORE = [
    ['five timers that have fired', EMPTY_FUNCTION + ONE_TIMER.repeat(5)],
    ['three pending timers', EMPTY_FUNCTION + ONE_PENDING_TIMER.repeat(3)],
    ['three RPC answers', EMPTY_FUNCTION + ONE_RPC_ANSWER.repeat(3)],
];
const LARGEST_NUMBER_WITHOUT_A_BLOCK = 8191;
const FAST_TIMER_MS = 14;
const FAST_TIMER_FIRES = Math.floor(CYCLE_SECONDS * MILLISECONDS_PER_SECOND / FAST_TIMER_MS);
const FAST_TIMER = ` Timer.set(${FAST_TIMER_MS}, true, tick);`;
const FAST_TIMER_POOL_BLOCKS = 1000;
const OWN_SHARE = { code: EMPTY_FUNCTION + ONE_TIMER + ONE_RPC_ANSWER, peakBytes: 532, retainedBytes: 112 };

const NO_DEVICE_CALL = '';
const SET_TIMER = 'Timer.set(3600000, false, work);';
const READ_CONFIGURATION = "Shelly.getComponentConfig('sys');";
const AT_LOAD = ' work();';
const IN_TIMER_CALLBACK = ' Timer.set(1000, false, work);';
const IN_RPC_CALLBACK = " Shelly.call('KVS.Get', { key: 'missing' }, work);";
const WORK_RETAINED_BYTES = 140;
const SAME_WORK_BY_PLACE = [
    { place: 'while the script loads', code: workHeldDuring(NO_DEVICE_CALL) + AT_LOAD, peakBytes: 1848 },
    { place: 'in a timer callback', code: workHeldDuring(NO_DEVICE_CALL) + IN_TIMER_CALLBACK, peakBytes: 2156 },
    { place: 'in the callback of an RPC call', code: workHeldDuring(NO_DEVICE_CALL) + IN_RPC_CALLBACK, peakBytes: 2268 },
    { place: 'while the script loads, held during Timer.set', code: workHeldDuring(SET_TIMER) + AT_LOAD, peakBytes: 2324 },
    { place: 'in a timer callback, held during Timer.set', code: workHeldDuring(SET_TIMER) + IN_TIMER_CALLBACK, peakBytes: 2632 },
    { place: 'in the callback of an RPC call, held during Timer.set', code: workHeldDuring(SET_TIMER) + IN_RPC_CALLBACK, peakBytes: 2744 },
    { place: 'in the callback of an RPC call, held during a configuration read', code: workHeldDuring(READ_CONFIGURATION) + IN_RPC_CALLBACK, peakBytes: 2912 },
];

const KEPT_READS = [
    ['a number of a status read', "[Shelly.getComponentStatus('sys').unixtime]"],
    ['a status read', "Shelly.getComponentStatus('sys')"],
    ['a configuration read with numbers that are not whole', "Shelly.getComponentConfig('sys')"],
    ['a configuration read with a boolean', "Shelly.getComponentConfig('script', 1)"],
    ['the device information', 'Shelly.getDeviceInfo()'],
];
const KEPT_ANSWERS = [
    ['the answer of an RPC call', 'Script.List', null],
    ['an answer with the result null', 'Group.Set', { value: [] }],
    ['the answer of a failed RPC call', 'KVS.Get', { key: 'missing' }],
];

const FIRST_USE_AS_ON_A_GEN4 = [
    { name: 'a method of a string', code: "'ab'.indexOf('b');", bytes: 0 },
    { name: 'a method of a number', code: '(1.5).toFixed(1);', bytes: 0 },
    { name: 'a method of a boolean', code: 'true.toString();', bytes: 0 },
    { name: 'a method of an array', code: '[1].push(2);', bytes: 0 },
    { name: 'Date.now', code: 'Date.now();', bytes: 28 },
    { name: 'a Date object', code: 'new Date();', bytes: 98 },
    { name: 'JSON', code: "JSON.parse('1');", bytes: 28 },
    { name: 'console', code: "console.log('x');", bytes: 42 },
    { name: 'a caught Error', code: "try { throw new Error('x'); } catch (e) {}", bytes: 112 },
    { name: 'Float64Array', code: 'new Float64Array(1);', bytes: 112 },
    { name: 'Uint32Array', code: 'new Uint32Array(1);', bytes: 112 },
    { name: 'Uint16Array', code: 'new Uint16Array(1);', bytes: 112 },
    { name: 'a kept Float64Array of 24 numbers', code: 'var kept = new Float64Array(24);', bytes: 364 },
    { name: 'a kept Uint16Array of 24 numbers', code: 'var kept = new Uint16Array(24);', bytes: 224 },
];
const FIRST_USE_FREE_ONLY_HERE = [
    { name: 'Math', code: 'Math.floor(1.5);', gen4Bytes: 28 },
    { name: 'the function Number', code: "Number('1');", gen4Bytes: 42 },
    { name: 'the function String', code: 'String(1);', gen4Bytes: 42 },
    { name: 'Object.keys', code: 'Object.keys({ a: 1 });', gen4Bytes: 42 },
    { name: 'Array.isArray', code: 'Array.isArray([]);', gen4Bytes: 42 },
    { name: 'new Array', code: 'new Array(2);', gen4Bytes: 112 },
];

const IN_NODE = "typeof process === 'undefined'";
const ANOTHER_CALL = `Shelly.call(${IN_NODE} ? 'KVS.Get' : 'Script.List', { key: 'missing' }, function () {});`;
const ANOTHER_KEY = `Shelly.call('KVS.Get', { key: ${IN_NODE} ? 'in Node' : 'in Espruino' }, function () {});`;
const ANOTHER_READ = `Shelly.getComponentStatus(${IN_NODE} ? 'sys' : 'script', 1);`;
const ANOTHER_STORED_SCHEDULE = "Shelly.call('KVS.Set', { key: 'SmartHeatingSys1', value: JSON.stringify("
    + `{ LastCalculation: 'any', ExistingSchedule: ${IN_NODE} ? 3 : 4 }) }, function () {});`;
const CALLS_WITHOUT_PARAMETERS = "Shelly.call('Script.List'); Shelly.call('Script.List', undefined, function () {});";

function workHeldDuring(deviceCall) {
    return `function work() { var items = []; for (var i = 0; i < 60; i++) items.push('item ' + i); ${deviceCall} }`;
}

function asLiteral(value) {
    return value === undefined ? 'undefined' : JSON.stringify(value);
}

function keptRead([name, read]) {
    const value = createShelly().eval(read);
    return { name, keptCode: `var kept = ${read};`, literalCode: `var kept = ${asLiteral(value)};` };
}

function keptAnswer([name, method, params]) {
    const answer = createShelly().rpc(method, params);
    const call = `var kept; Shelly.call('${method}', ${asLiteral(params)}, function (result, code, message) { kept = `;
    const literals = [answer.result, answer.code, answer.message].map(asLiteral).join(', ');
    return { name, keptCode: call + '[result, code, message]; });', literalCode: call + `[${literals}]; });` };
}

function assertSameRunAsInNode(measured) {
    assert.equal(measured.crashed, null, measured.output);
    assert.deepEqual(measured.differencesFromNode, [], measured.output);
    assert.deepEqual(measured.engineErrors, [], measured.output);
    assert.equal(measured.isPoolFull, false, 'Espruino ran out of the memory the test gives it');
    assert.equal(measured.callCount, measured.callsInNode, 'another number of RPC calls than in Node');
    assert.equal(measured.readCount, measured.readsInNode, 'another number of status and configuration reads than in Node');
    assert.equal(measured.blockBytes, DEVICE_BLOCK_BYTES, 'this Espruino is not the 32-bit build of build-espruino.sh');
}

before(() => {
    assert.ok(hasBinary(), `No Espruino at ${BINARY}, build it with tests/espruino/build-espruino.sh`);
});

describe('memory of version 4.9 in Espruino', { concurrency: true }, () => {
    for (const { settings, day, peakBytes, retainedBytes } of VERSION_4_9) {
        it(`${settings.name}, prices of ${day.fixture}`, async (test) => {
            const measured = await measure({ now: day.now, elering: day.fixture, kvs: { SmartHeatingConf1: JSON.stringify(settings.conf) } });
            test.diagnostic(`peak ${measured.peakBytes} B, retained ${measured.retainedBytes} B`);
            assertSameRunAsInNode(measured);
            assert.equal(measured.peakBytes, peakBytes, 'peak');
            assert.equal(measured.retainedBytes, retainedBytes, 'retained');
        });
    }
});

describe('the simulated device in Espruino', { concurrency: true }, () => {
    it('measures an empty script', async () => {
        const measured = await measure({ code: EMPTY_SCRIPT.code });
        assertSameRunAsInNode(measured);
        assert.equal(measured.peakBytes, EMPTY_SCRIPT.peakBytes, 'peak');
        assert.equal(measured.retainedBytes, EMPTY_SCRIPT.retainedBytes, 'retained');
    });

    it('measures an empty function', async () => {
        const measured = await measure({ code: EMPTY_FUNCTION });
        assertSameRunAsInNode(measured);
        assert.equal(measured.retainedBytes, EMPTY_FUNCTION_RETAINED_BYTES);
    });

    for (const [name, code] of SCRIPTS_THAT_KEEP_NO_MORE) {
        it(`adds nothing to what an empty function retains for ${name}`, async () => {
            const measured = await measure({ code });
            assertSameRunAsInNode(measured);
            assert.equal(measured.retainedBytes, EMPTY_FUNCTION_RETAINED_BYTES);
        });
    }

    it(`adds nothing to what an empty function retains for a timer that fires ${FAST_TIMER_FIRES} times`, async () => {
        assert.ok(FAST_TIMER_FIRES > LARGEST_NUMBER_WITHOUT_A_BLOCK, 'the timer must fire more often than a number counts without a block of its own');
        const measured = await measure({ code: EMPTY_FUNCTION + FAST_TIMER }, FAST_TIMER_POOL_BLOCKS);
        assertSameRunAsInNode(measured);
        assert.equal(measured.retainedBytes, EMPTY_FUNCTION_RETAINED_BYTES);
    });

    it('adds its own share to a script with one timer and one RPC answer', async () => {
        const measured = await measure({ code: OWN_SHARE.code });
        assertSameRunAsInNode(measured);
        assert.equal(measured.peakBytes, OWN_SHARE.peakBytes, 'peak');
        assert.equal(measured.retainedBytes, OWN_SHARE.retainedBytes, 'retained');
    });

    for (const { place, code, peakBytes } of SAME_WORK_BY_PLACE) {
        it(`adds its own share to the peak of the same work ${place}`, async () => {
            const measured = await measure({ code });
            assertSameRunAsInNode(measured);
            assert.equal(measured.peakBytes, peakBytes, 'peak');
            assert.equal(measured.retainedBytes, WORK_RETAINED_BYTES, 'retained');
        });
    }

    for (const { name, keptCode, literalCode } of KEPT_READS.map(keptRead).concat(KEPT_ANSWERS.map(keptAnswer))) {
        it(`retains ${name} like the same value written in the script`, async () => {
            const [kept, literal] = await Promise.all([measure({ code: keptCode }), measure({ code: literalCode })]);
            assertSameRunAsInNode(kept);
            assertSameRunAsInNode(literal);
            assert.equal(kept.retainedBytes, literal.retainedBytes);
        });
    }

    for (const { name, code, bytes } of FIRST_USE_AS_ON_A_GEN4) {
        it(`charges the first use of ${name} ${bytes} bytes, as a Gen4 does`, async () => {
            const measured = await measure({ code });
            assertSameRunAsInNode(measured);
            assert.equal(measured.retainedBytes - EMPTY_SCRIPT.retainedBytes, bytes);
        });
    }

    for (const { name, code, gen4Bytes } of FIRST_USE_FREE_ONLY_HERE) {
        it(`charges the first use of ${name} nothing, where a Gen4 charges ${gen4Bytes} bytes`, async () => {
            const measured = await measure({ code });
            assertSameRunAsInNode(measured);
            assert.equal(measured.retainedBytes, EMPTY_SCRIPT.retainedBytes);
        });
    }

    it('takes a call without parameters for the same call as in Node', async () => {
        assertSameRunAsInNode(await measure({ code: CALLS_WITHOUT_PARAMETERS }));
    });

    it('reports an RPC call that is another one than in Node', async () => {
        const measured = await measure({ code: ANOTHER_CALL });
        assert.match(measured.differencesFromNode.join('\n'), /is Script\.List, in Node it was KVS\.Get/);
    });

    it('reports RPC parameters that differ from Node', async () => {
        const measured = await measure({ code: ANOTHER_KEY });
        assert.match(measured.differencesFromNode.join('\n'), /KVS\.Get with .*in Espruino.*in Node with .*in Node/);
    });

    it('reports a value of SmartHeatingSys that differs from Node in more than the date text', async () => {
        const measured = await measure({ code: ANOTHER_STORED_SCHEDULE });
        assert.match(measured.differencesFromNode.join('\n'), /KVS\.Set with .*"ExistingSchedule":4.*in Node with .*"ExistingSchedule":3/);
    });

    it('reports a read with other arguments than in Node', async () => {
        const measured = await measure({ code: ANOTHER_READ });
        assert.match(measured.differencesFromNode.join('\n'), /getComponentStatus of script 1, in Node of sys 1/);
    });
});
