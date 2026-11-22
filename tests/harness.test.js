'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createShelly } = require('./harness');
const limits = require('./limits');

const JOB = { enable: true, timespec: '0 0 23 * * *', calls: [{ method: 'Switch.Set', params: { id: 0, on: true } }] };
const MISSING_ID = 77;
const QUOTE_COUNT_OF_A_JSON_STRING = 2;

function emptyDevice() {
    return createShelly({ code: '' }).load();
}

function fillSchedules(sim, count) {
    for (let i = 0; i < count; i++) assert.equal(sim.rpc('Schedule.Create', JOB).code, 0);
}

function addComponent(sim, id) {
    return sim.rpc('Virtual.Add', { type: 'number', id, config: { default_value: 0 } });
}

describe('simulated device limits', () => {
    it(`holds at most ${limits.SCHEDULE_LIMIT} schedules`, () => {
        const sim = emptyDevice();
        fillSchedules(sim, limits.SCHEDULE_LIMIT);
        assert.equal(sim.rpc('Schedule.Create', JOB).code, limits.ERR_RESOURCE_EXHAUSTED);
        assert.equal(sim.schedules.size, limits.SCHEDULE_LIMIT);
    });

    it(`accepts at most ${limits.SCHEDULE_CALL_LIMIT} calls in a schedule`, () => {
        const sim = emptyDevice();
        const calls = new Array(limits.SCHEDULE_CALL_LIMIT + 1).fill(JOB.calls[0]);
        assert.equal(sim.rpc('Schedule.Create', Object.assign({}, JOB, { calls })).code, limits.ERR_INVALID_ARGUMENT);
    });

    it('gives a new schedule the highest existing ID plus one', () => {
        const sim = emptyDevice();
        fillSchedules(sim, 3);
        sim.rpc('Schedule.Delete', { id: 2 });
        assert.equal(sim.rpc('Schedule.Create', JOB).result.id, 4);
        sim.rpc('Schedule.Delete', { id: 4 });
        assert.equal(sim.rpc('Schedule.Create', JOB).result.id, 4);
    });

    it('gives a new script the lowest free ID and no autostart', () => {
        const scripts = [1, 3].map((id) => ({ id, name: 'script ' + id, running: true, enable: true }));
        const sim = createShelly({ code: '', scripts }).load();
        assert.equal(sim.rpc('Script.Create', { name: 'new' }).result.id, 2);
        assert.equal(sim.scripts.find((script) => script.id === 2).enable, false);
    });

    it('answers Schedule.Delete of a missing ID with invalid argument', () => {
        assert.equal(emptyDevice().rpc('Schedule.Delete', { id: MISSING_ID }).code, limits.ERR_INVALID_ARGUMENT);
    });

    it('answers Schedule.Update of a missing ID with not found', () => {
        assert.equal(emptyDevice().rpc('Schedule.Update', { id: MISSING_ID, enable: false }).code, limits.ERR_NOT_FOUND);
    });

    it('answers KVS.Get of a missing key with not found', () => {
        assert.equal(emptyDevice().rpc('KVS.Get', { key: 'missing' }).code, limits.ERR_NOT_FOUND);
    });

    it(`stores a KVS value of at most ${limits.KVS_VALUE_LIMIT} bytes, each quote counted twice`, () => {
        const sim = emptyDevice();
        const longest = JSON.stringify('x'.repeat(limits.KVS_VALUE_LIMIT - limits.KVS_BYTES_PER_QUOTE * QUOTE_COUNT_OF_A_JSON_STRING));
        assert.equal(limits.kvsLength(longest), limits.KVS_VALUE_LIMIT);
        assert.equal(sim.rpc('KVS.Set', { key: 'fits', value: longest }).code, 0);
        assert.equal(sim.rpc('KVS.Set', { key: 'too_long', value: JSON.stringify('x' + JSON.parse(longest)) }).code, limits.ERR_INVALID_ARGUMENT);
        assert.equal('too_long' in sim.kvs, false);
    });

    it('counts a KVS value in UTF-8 bytes', () => {
        const sim = emptyDevice();
        const twoByteCharacter = '\u00f5';
        const fittingCount = Math.floor(limits.KVS_VALUE_LIMIT / Buffer.byteLength(twoByteCharacter));
        assert.equal(sim.rpc('KVS.Set', { key: 'fits', value: twoByteCharacter.repeat(fittingCount) }).code, 0);
        assert.equal(sim.rpc('KVS.Set', { key: 'too_long', value: twoByteCharacter.repeat(fittingCount + 1) }).code, limits.ERR_INVALID_ARGUMENT);
    });

    it(`accepts a KVS key of at most ${limits.KVS_KEY_LIMIT} characters`, () => {
        const sim = emptyDevice();
        assert.equal(sim.rpc('KVS.Set', { key: 'k'.repeat(limits.KVS_KEY_LIMIT), value: '1' }).code, 0);
        assert.equal(sim.rpc('KVS.Set', { key: 'k'.repeat(limits.KVS_KEY_LIMIT + 1), value: '1' }).code, limits.ERR_INVALID_ARGUMENT);
    });

    it(`holds at most ${limits.KVS_KEY_COUNT_LIMIT} KVS keys and still updates an existing one`, () => {
        const sim = emptyDevice();
        for (let i = 0; i < limits.KVS_KEY_COUNT_LIMIT; i++) assert.equal(sim.rpc('KVS.Set', { key: 'key' + i, value: '1' }).code, 0);
        assert.equal(sim.rpc('KVS.Set', { key: 'one_more', value: '1' }).code, limits.ERR_RESOURCE_EXHAUSTED);
        assert.equal(sim.rpc('KVS.Set', { key: 'key0', value: '2' }).code, 0);
    });

    it(`holds at most ${limits.VIRTUAL_COMPONENT_LIMIT} virtual components`, () => {
        const sim = emptyDevice();
        for (let i = 0; i < limits.VIRTUAL_COMPONENT_LIMIT; i++) assert.equal(addComponent(sim, limits.VIRTUAL_ID_FIRST + i).code, 0);
        assert.equal(addComponent(sim, limits.VIRTUAL_ID_FIRST + limits.VIRTUAL_COMPONENT_LIMIT).code, limits.ERR_RESOURCE_EXHAUSTED);
        assert.equal(sim.components.length, limits.VIRTUAL_COMPONENT_LIMIT);
    });

    it('rejects a virtual component whose ID is taken by its type or out of range', () => {
        const sim = emptyDevice();
        assert.equal(addComponent(sim, limits.VIRTUAL_ID_FIRST).code, 0);
        assert.equal(addComponent(sim, limits.VIRTUAL_ID_FIRST).code, limits.ERR_ALREADY_EXISTS);
        assert.equal(addComponent(sim, limits.VIRTUAL_ID_LAST + 1).code, limits.ERR_INVALID_ARGUMENT);
        assert.equal(sim.components.length, 1);
    });

    it('lets another component type use the same ID', () => {
        const sim = emptyDevice();
        assert.equal(addComponent(sim, limits.VIRTUAL_ID_FIRST).code, 0);
        assert.equal(sim.rpc('Virtual.Add', { type: 'boolean', id: limits.VIRTUAL_ID_FIRST, config: {} }).code, 0);
    });

    it('answers Virtual.Delete of a missing component with not found', () => {
        assert.equal(emptyDevice().rpc('Virtual.Delete', { key: 'number:' + limits.VIRTUAL_ID_FIRST }).code, limits.ERR_NOT_FOUND);
    });

    it(`accepts ${limits.RPC_CALL_LIMIT} RPC calls in flight and stops the script at one more`, () => {
        const sim = emptyDevice();
        const oneCall = 'Shelly.call("KVS.Get", { key: "any" });';
        sim.eval(oneCall.repeat(limits.RPC_CALL_LIMIT));
        assert.equal(sim.crashed, null);
        sim.eval(oneCall);
        assert.match(String(sim.crashed), /RPC calls in flight/);
    });

    it(`stops the script at more than ${limits.TIMER_LIMIT} active timers`, () => {
        const sim = emptyDevice();
        for (let i = 0; i < limits.TIMER_LIMIT; i++) sim.setTimer(1000);
        assert.equal(sim.crashed, null);
        sim.setTimer(1000);
        assert.match(String(sim.crashed), /timers active/);
    });

    it('answers Timer.clear with true for a pending timer and with undefined after that', () => {
        const sim = emptyDevice();
        const clearTimer = `Timer.clear(${sim.setTimer(1000)})`;
        assert.equal(sim.eval(clearTimer), true);
        assert.equal(sim.eval(clearTimer), undefined);
    });

    it('gives the callback of a failed RPC call no result, a code and a message', () => {
        const answer = emptyDevice().rpc('KVS.Get', { key: 'missing' });
        assert.equal(answer.result, undefined);
        assert.equal(answer.code, limits.ERR_NOT_FOUND);
        assert.match(answer.message, /missing/);
    });

    it('gives the callback of a successful RPC call a result, the code 0 and an empty message', () => {
        const answer = emptyDevice().rpc('KVS.Set', { key: 'any', value: '1' });
        assert.notEqual(answer.result, undefined);
        assert.equal(answer.code, 0);
        assert.equal(answer.message, '');
    });

    it('stops a run that never comes to rest', () => {
        const sim = emptyDevice();
        sim.eval('Timer.set(0, true, function () {});');
        sim.runFor(1);
        assert.match(String(sim.crashed), /tasks in 1 s/);
    });

    it('refuses an RPC method it does not simulate', () => {
        assert.throws(() => emptyDevice().rpc('Sys.Reboot'), /is not simulated/);
    });
});
