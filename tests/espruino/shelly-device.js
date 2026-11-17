// The device must cost the script no memory, so everything below is made before the baseline is taken and nothing may be allocated
// for it afterwards. Espruino gives a new number a block of its own unless it is an integer up to 8191, and a null as well, so the
// clock, the counters and the times of the slots live in typed arrays and an empty field is undefined. The calibration cases of
// script-memory.js fail when this stops being true.
var __device = {
    nowMs: new Float64Array(1),
    callCount: new Uint32Array(1),
    readCount: new Uint32Array(1),
    taskSequence: new Uint32Array(1),
    lastTimerHandle: new Uint32Array(1),
    slots: [],
    crashed: null,
    baselineBlocks: 0,
};

function __setClock(ms) {
    __device.nowMs[0] = ms;
    setTime(ms / __scenario.millisecondsPerSecond);
}

function __reportError(text) {
    print(__scenario.marks.error + ' ' + text);
}

// The firmware allocates every answer anew in the script's memory, so the script must not be handed any value of the scenario
// itself. '' + value copies a string and value + 0 a number, +value returns the same one.
function __freshCopy(value) {
    if (typeof value === 'string') return '' + value;
    if (typeof value === 'number') return value + 0;
    if (typeof value === 'boolean') return !!value;
    if (value === null) return null;
    if (typeof value !== 'object') return value;
    var copy = value instanceof Array ? [] : {};
    for (var key in value) copy[key] = __freshCopy(value[key]);
    return copy;
}

function __makeSlots(count) {
    for (var i = 0; i < count; i++) {
        __device.slots.push({
            isUsed: false, dueMs: new Float64Array(1), intervalMs: new Float64Array(1),
            sequence: new Uint32Array(1), handle: new Uint32Array(1),
            callback: undefined, userdata: undefined, answer: undefined,
        });
    }
}

function __addTask(delayMs, callback, userdata, answer, handle, intervalMs) {
    for (var i = 0; i < __device.slots.length; i++) {
        var slot = __device.slots[i];
        if (slot.isUsed) continue;
        slot.isUsed = true;
        slot.dueMs[0] = __device.nowMs[0] + delayMs;
        slot.intervalMs[0] = intervalMs;
        slot.sequence[0] = __device.taskSequence[0]++;
        slot.handle[0] = handle;
        slot.callback = callback;
        slot.userdata = userdata;
        slot.answer = answer;
        return;
    }
    __reportError('more than ' + __device.slots.length + ' timers and RPC answers pending');
}

function __free(slot) {
    slot.isUsed = false;
    slot.callback = undefined;
    slot.userdata = undefined;
    slot.answer = undefined;
}

function __comparedParams(recorded, params) {
    if (!recorded.hasDateText) return params === undefined ? null : params;
    var value = JSON.parse(params.value);
    delete value[__scenario.dateTextField];
    return { key: params.key, value: value };
}

function __compareWithNode(recorded, params) {
    var paramsText = JSON.stringify(__comparedParams(recorded, params));
    if (paramsText !== recorded.paramsText) {
        __reportError(recorded.method + ' with ' + paramsText + ', in Node with ' + recorded.paramsText);
    }
}

function __compareReadWithNode(recorded, type, id) {
    var argumentsText = type + ' ' + id;
    if (argumentsText !== recorded.argumentsText) {
        __reportError(recorded.name + ' of ' + argumentsText + ', in Node of ' + recorded.argumentsText);
    }
}

function __replayedRead(name, type, id) {
    var recorded = __scenario.reads[__device.readCount[0]];
    __device.readCount[0]++;
    if (!recorded || recorded.name !== name) {
        __reportError('read ' + __device.readCount[0] + ' is ' + name + ', in Node it was ' + (recorded ? recorded.name : 'not made'));
        return undefined;
    }
    if (__scenario.isComparing) __compareReadWithNode(recorded, type, id);
    return __freshCopy(recorded.answer);
}

var Shelly = {
    call: function (method, params, callback, userdata) {
        var recorded = __scenario.calls[__device.callCount[0]];
        __device.callCount[0]++;
        if (!recorded || recorded.method !== method) {
            __reportError('call ' + __device.callCount[0] + ' is ' + method + ', in Node it was ' + (recorded ? recorded.method : 'not made'));
            return;
        }
        if (__scenario.isComparing) __compareWithNode(recorded, params);
        if (typeof callback === 'function') __addTask(0, callback, userdata, recorded.answer, 0, 0);
    },
    getComponentStatus: function (type, id) { return __replayedRead('getComponentStatus', type, id); },
    getComponentConfig: function (type, id) { return __replayedRead('getComponentConfig', type, id); },
    getDeviceInfo: function () { return __freshCopy(__scenario.deviceInfo); },
    getCurrentScriptId: function () { return __scenario.scriptId; },
};

var Timer = {
    set: function (delayMs, isRepeating, callback, userdata) {
        var handle = ++__device.lastTimerHandle[0];
        __addTask(delayMs, callback, userdata, undefined, handle, isRepeating ? delayMs : 0);
        return handle;
    },
    clear: function (handle) {
        for (var i = 0; i < __device.slots.length; i++) {
            var slot = __device.slots[i];
            if (slot.isUsed && slot.handle[0] > 0 && slot.handle[0] === handle) {
                __free(slot);
                return true;
            }
        }
        return undefined;
    },
};

function __nextDueSlot(untilMs) {
    var next = null;
    for (var i = 0; i < __device.slots.length; i++) {
        var slot = __device.slots[i];
        if (!slot.isUsed || slot.dueMs[0] > untilMs) continue;
        if (!next || slot.dueMs[0] < next.dueMs[0] || (slot.dueMs[0] === next.dueMs[0] && slot.sequence[0] < next.sequence[0])) next = slot;
    }
    return next;
}

function __runSlot(slot) {
    var callback = slot.callback;
    var userdata = slot.userdata;
    var answer = slot.answer;
    if (slot.dueMs[0] > __device.nowMs[0]) __setClock(slot.dueMs[0]);
    if (slot.intervalMs[0] > 0) {
        slot.dueMs[0] = __device.nowMs[0] + slot.intervalMs[0];
        slot.sequence[0] = __device.taskSequence[0]++;
    } else {
        __free(slot);
    }
    try {
        if (answer) callback(answer[1] === 0 ? __freshCopy(answer[0]) : undefined, answer[1], __freshCopy(answer[2]), userdata);
        else callback(userdata);
    } catch (error) {
        __device.crashed = String(error) + (error && error.stack ? '\n' + error.stack : '');
        __reportError('uncaught ' + __device.crashed);
    }
}

function __runFor(seconds) {
    var untilMs = __device.nowMs[0] + seconds * __scenario.millisecondsPerSecond;
    for (var slot = __nextDueSlot(untilMs); slot && !__device.crashed; slot = __nextDueSlot(untilMs)) {
        __runSlot(slot);
    }
    __setClock(untilMs);
}

function __report() {
    var memory = process.memory(true);
    print(__scenario.marks.result + ' ' + JSON.stringify({
        baselineBlocks: __device.baselineBlocks,
        peakBlocks: memory.peak,
        retainedBlocks: memory.usage,
        blockBytes: memory.blocksize,
        callCount: __device.callCount[0],
        readCount: __device.readCount[0],
        errors: E.getErrorFlags(),
        crashed: __device.crashed,
    }));
}

Math.random = function () { return 0; };
E.setDST(
    __scenario.daylightSaving.shiftMinutes, __scenario.daylightSaving.standardOffsetMinutes,
    __scenario.daylightSaving.lastWeekOfMonth, __scenario.daylightSaving.sunday, __scenario.daylightSaving.marchIndex,
    __scenario.daylightSaving.dayOffset, __scenario.daylightSaving.startMinuteOfDay,
    __scenario.daylightSaving.lastWeekOfMonth, __scenario.daylightSaving.sunday, __scenario.daylightSaving.octoberIndex,
    __scenario.daylightSaving.dayOffset, __scenario.daylightSaving.endMinuteOfDay
);
__setClock(__scenario.now);
__makeSlots(__scenario.pendingTaskLimit);

// Espruino makes the object of a built-in at its first use, in the measured memory. On a device a script pays for it in the same
// way, except for the methods of a string, a number and a boolean (Shelly 1PM Mini Gen4, firmware 2.2.1). So a method of a string
// and one of a number are used here first, the methods of a boolean come with those of a number. The two typed arrays this file
// has used are removed again for a script to pay for its own. Math stays, because the Math.random of the test lives in it.
'a'.length;
(1).toFixed(0);
delete global.Float64Array;
delete global.Uint32Array;

__device.baselineBlocks = process.memory(true).usage;
process.resetPeakMemory();
