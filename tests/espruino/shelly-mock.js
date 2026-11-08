/*
Shelly Gen2 scripting mocks for the Espruino Linux build (tests/espruino/build-espruino.sh),
the counterpart of tests/harness.js for measuring the engine's memory. Loaded after a generated
scenario file that defines __scenario and before the script under test:

    espruino scenario.js shelly-mock.js SmartHeatingWidthShelly.js run.js

Mock state lives in the same variable pool as the script, so this file keeps as little as
possible (no call log, schedules only by ID) and the memory baseline is taken at its end.
HTTP answers come precomputed from a Node harness run of the same scenario; a fresh copy of
the body is made for each answer because the firmware allocates the answer for the script.
*/
var __MAX_SCHEDULES = 20;
var __MAX_CALLS_PER_SCHEDULE = 5;
var __ERR_NOT_FOUND = -105;
var __ERR_HTTP = -104;
var __ERR_INVALID = -103;
var __ERR_NOT_MOCKED = -114;

var __sim = {
    nowMs: __scenario.now,
    kvs: __scenario.kvs,
    scheduleIds: [],
    nextScheduleId: 1,
    tasks: [],
    seq: 0,
    timerSeq: 0,
    cleared: {},
    crashed: null,
    retainedPeak: 0,
    baseline: 0,
};

function __setClock(ms) {
    __sim.nowMs = ms;
    setTime(ms / 1000);
}

function __enqueue(atMs, fn, args) {
    __sim.tasks.push({ at: atMs, seq: __sim.seq++, fn: fn, args: args });
}

function __copyAnswer(answer) {
    var result = answer[0];
    if (!result) return [null, answer[1], answer[2]];
    var copy = { code: result.code };
    if (result.body_b64 !== undefined) copy.body_b64 = result.body_b64.slice(0);
    if (result.body !== undefined) copy.body = result.body.slice(0);
    return [copy, answer[1], answer[2]];
}

function __httpGet(params) {
    var answer = __scenario.http[params.url];
    if (!answer) {
        print("MOCKERR unmocked URL " + params.url);
        return [null, __ERR_HTTP, 'Unknown host'];
    }
    return __copyAnswer(answer);
}

function __scheduleCreate(params) {
    if (__sim.scheduleIds.length >= __MAX_SCHEDULES) return [null, __ERR_INVALID, 'Too many schedules'];
    if (!params.calls || params.calls.length > __MAX_CALLS_PER_SCHEDULE) return [null, __ERR_INVALID, 'Too many calls'];
    if (String(params.timespec).split(' ').length !== 6) return [null, __ERR_INVALID, 'Invalid timespec'];
    var id = __sim.nextScheduleId++;
    __sim.scheduleIds.push(id);
    print("MOCK schedule.create " + JSON.stringify({ id: id, timespec: params.timespec }));
    return [{ id: id, rev: id }, 0, ''];
}

function __scheduleDelete(params) {
    var index = __sim.scheduleIds.indexOf(params.id);
    if (index < 0) return [null, __ERR_NOT_FOUND, 'Job id ' + params.id + ' not found!'];
    __sim.scheduleIds.splice(index, 1);
    print("MOCK schedule.delete " + params.id);
    return [{ rev: 1 }, 0, ''];
}

function __kvsGet(params) {
    if (__sim.kvs[params.key] === undefined) {
        return [null, __ERR_NOT_FOUND, 'Argument \'key\', value \'' + params.key + '\' not found!'];
    }
    return [{ value: __sim.kvs[params.key], etag: 'e' }, 0, ''];
}

// Keys given in the scenario take the new value, new keys are only printed: the device keeps KVS outside the script's memory
function __kvsSet(params) {
    if (__sim.kvs[params.key] !== undefined) __sim.kvs[params.key] = params.value;
    print("MOCK kvs.set " + JSON.stringify({ key: params.key, value: params.value }));
    return [{ etag: 'e', rev: 1 }, 0, ''];
}

function __scriptList() {
    var scripts = [];
    __scenario.scripts.forEach(function (s) { scripts.push({ id: s.id, name: s.name, running: s.running }); });
    return [{ scripts: scripts }, 0, ''];
}

function __rpc(method, params) {
    var p = params || {};
    switch (method.toLowerCase()) {
        case 'kvs.get': return __kvsGet(p);
        case 'kvs.set': return __kvsSet(p);
        case 'schedule.create': return __scheduleCreate(p);
        case 'schedule.delete': return __scheduleDelete(p);
        case 'switch.set': return [{ was_on: false }, 0, ''];
        case 'switch.setconfig': return [{ restart_required: false }, 0, ''];
        case 'http.get': return __httpGet(p);
        case 'shelly.getdeviceinfo': return [__scenario.deviceInfo, 0, ''];
        case 'sys.getstatus': return [{ unixtime: Math.floor(__sim.nowMs / 1000) }, 0, ''];
        case 'script.list': return __scriptList();
        case 'script.create': return [{ id: __scenario.scripts.length + 1 }, 0, ''];
        case 'script.putcode': return [{ len: p.code.length }, 0, ''];
        case 'script.start':
        case 'script.stop':
        case 'script.setconfig':
            return [{}, 0, ''];
        default:
            return [null, __ERR_NOT_MOCKED, 'Method ' + method + ' not mocked'];
    }
}

var Shelly = {
    call: function (method, params, callback, userdata) {
        var answer = __rpc(method, params);
        if (typeof callback === 'function') __enqueue(__sim.nowMs, callback, [answer[0], answer[1], answer[2], userdata]);
    },
    getComponentStatus: function (type, id) {
        if (type === 'sys') return { unixtime: Math.floor(__sim.nowMs / 1000) };
        if (String(type).indexOf('script') === 0) return { id: id, running: true, mem_used: 0, mem_peak: 0 };
        return {};
    },
    getComponentConfig: function (type) {
        if (type === 'sys') return { location: { lat: __scenario.location.lat, lon: __scenario.location.lon } };
        if (String(type).indexOf('script') === 0) return { enable: true };
        return {};
    },
    getDeviceInfo: function () { return __scenario.deviceInfo; },
    getCurrentScriptId: function () { return __scenario.scriptId; },
    addStatusHandler: function () { return 1; },
    addEventHandler: function () { return 1; },
};

var Timer = {
    set: function (ms, repeat, fn, userdata) {
        var handle = ++__sim.timerSeq;
        var fire = function (data) {
            if (__sim.cleared[handle]) return;
            if (repeat) __enqueue(__sim.nowMs + ms, fire, [data]);
            fn(data);
        };
        __enqueue(__sim.nowMs + ms, fire, [userdata]);
        return handle;
    },
    clear: function (handle) {
        __sim.cleared[handle] = true;
        return true;
    },
};

var Virtual = { getHandle: function () { return null; } };

function __nextTaskIndex(untilMs) {
    var next = -1;
    for (var i = 0; i < __sim.tasks.length; i++) {
        var task = __sim.tasks[i];
        if (task.at > untilMs) continue;
        if (next < 0) { next = i; continue; }
        var best = __sim.tasks[next];
        if (task.at < best.at || (task.at === best.at && task.seq < best.seq)) next = i;
    }
    return next;
}

// Collects garbage (as the idle loop would) and records what stays allocated between callbacks
function __collectGarbage() {
    var usage = process.memory(true).usage;
    if (usage > __sim.retainedPeak) __sim.retainedPeak = usage;
}

function __runTask(task) {
    if (task.at > __sim.nowMs) __setClock(task.at);
    __collectGarbage();
    try {
        task.fn.apply(undefined, task.args);
    } catch (error) {
        __sim.crashed = String(error) + (error && error.stack ? '\n' + error.stack : '');
        print("MOCKERR uncaught " + __sim.crashed);
    }
}

// Advances the clock, running due RPC callbacks and timers in order, like sim.runFor in harness.js
function __runFor(seconds) {
    var untilMs = __sim.nowMs + seconds * 1000;
    while (!__sim.crashed) {
        var index = __nextTaskIndex(untilMs);
        if (index < 0) break;
        __runTask(__sim.tasks.splice(index, 1)[0]);
    }
    __setClock(Math.max(__sim.nowMs, untilMs));
}

function __report() {
    __collectGarbage();
    var memory = process.memory(false);
    print("MEMRESULT " + JSON.stringify({
        baseline: __sim.baseline,
        peak: memory.peak,
        retainedPeak: __sim.retainedPeak,
        retainedEnd: memory.usage,
        total: memory.total,
        blocksize: memory.blocksize,
        errors: E.getErrorFlags(),
        crashed: __sim.crashed,
        version: process.version,
    }));
}

Math.random = function () { return 0; };
// Europe/Tallinn: EET, EEST from the last Sunday of March 03:00 to the last Sunday of October 04:00
E.setTimeZone(2);
E.setDST(60, 120, 4, 0, 2, 0, 180, 4, 0, 9, 0, 240);
__setClock(__scenario.now);

__sim.baseline = process.memory(true).usage;
__sim.retainedPeak = __sim.baseline;
process.resetPeakMemory();
