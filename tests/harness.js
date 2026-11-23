'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const limits = require('./limits');
const {
    DEVICE_TIME_ZONE, DEVICE_LOCATION, NORMAL_DAY, GEN2_DEVICE, HEATING_SCRIPT_ID, WATCHDOG_SCRIPT_ID, HEATING_SCRIPT_ENTRY,
    MILLISECONDS_PER_SECOND, SECONDS_PER_MINUTE, MINUTES_PER_HOUR, HOURS_PER_DAY, RELAY_OVERLAP_SECONDS,
} = require('./settings');

process.env.TZ = DEVICE_TIME_ZONE;

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const HEATING_SCRIPT = path.join(ROOT, 'SmartHeatingWidthShelly.js');
const FORECAST_FIXTURE = 'open-meteo-24h.json';
const ELERING_ENCODING = 'latin1';
const STEP_LIMIT = 100000;
const WATCHDOG_RUN_SECONDS = 10;
const MINUTES_PER_DAY = HOURS_PER_DAY * MINUTES_PER_HOUR;
const FAKE_CLOCK = `
    (function () {
        const RealDate = Date;
        function FakeDate() {
            if (!new.target) return new RealDate(__now()).toString();
            return arguments.length ? new RealDate(...arguments) : new RealDate(__now());
        }
        FakeDate.prototype = RealDate.prototype;
        FakeDate.now = function () { return __now(); };
        FakeDate.UTC = RealDate.UTC;
        FakeDate.parse = RealDate.parse;
        globalThis.Date = FakeDate;
        Math.random = function () { return 0; };
    })();
`;

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function ok(result) {
    return [result, 0, ''];
}

function failed(code, message) {
    return [undefined, code, message];
}

function eleringRows(fixture) {
    const lines = fs.readFileSync(path.join(FIXTURES, fixture), ELERING_ENCODING).split('\n');
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        if (!lines[i]) continue;
        const fields = lines[i].split(';').map((field) => field.replace(/"/g, ''));
        rows.push({ timestamp: Number(fields[0]), price: Number(fields[2].replace(',', '.')), line: lines[i] });
    }
    return { header: lines[0], rows };
}

function forecastTemperatures() {
    const forecast = JSON.parse(fs.readFileSync(path.join(FIXTURES, FORECAST_FIXTURE), 'utf8'));
    return forecast.hourly.apparent_temperature;
}

function crash(sim, reason) {
    sim.crashed = sim.crashed || reason;
}

function addTask(sim, dueMs, run) {
    sim.tasks.push({ dueMs, sequence: sim.taskSequence++, run });
}

function nextDueTask(sim, untilMs) {
    let next = null;
    for (const task of sim.tasks) {
        const isBeforeNext = !next || task.dueMs < next.dueMs || (task.dueMs === next.dueMs && task.sequence < next.sequence);
        if (task.dueMs <= untilMs && isBeforeNext) next = task;
    }
    return next;
}

function runTask(sim, task) {
    sim.tasks.splice(sim.tasks.indexOf(task), 1);
    sim.nowMs = Math.max(sim.nowMs, task.dueMs);
    try {
        task.run();
    } catch (error) {
        sim.logs.push('Uncaught ' + error.stack);
        crash(sim, error);
    }
}

function runFor(sim, seconds) {
    const untilMs = sim.nowMs + seconds * MILLISECONDS_PER_SECOND;
    let steps = 0;
    for (let task = nextDueTask(sim, untilMs); task && !sim.crashed; task = nextDueTask(sim, untilMs)) {
        steps++;
        if (steps > STEP_LIMIT) {
            crash(sim, `more than ${STEP_LIMIT} tasks in ${seconds} s`);
            return;
        }
        runTask(sim, task);
    }
    if (!sim.crashed) sim.nowMs = untilMs;
}

function kvsGet(sim, params) {
    if (params.key in sim.kvs) return ok({ value: sim.kvs[params.key], etag: 'e' });
    return failed(limits.ERR_NOT_FOUND, 'Argument \'key\', value \'' + params.key + '\' not found!');
}

function kvsSet(sim, params) {
    const isNewKey = !(params.key in sim.kvs);
    if (params.key.length > limits.KVS_KEY_LIMIT) return failed(limits.ERR_INVALID_ARGUMENT, `Invalid argument 'key': length should be less than ${limits.KVS_KEY_LIMIT}!`);
    if (limits.kvsLength(String(params.value)) > limits.KVS_VALUE_LIMIT) return failed(limits.ERR_INVALID_ARGUMENT, 'Invalid argument \'value\': length should be less than 255!');
    if (isNewKey && Object.keys(sim.kvs).length >= limits.KVS_KEY_COUNT_LIMIT) return failed(limits.ERR_RESOURCE_EXHAUSTED, `Reached the maximum ${limits.KVS_KEY_COUNT_LIMIT} of keys`);
    sim.kvs[params.key] = params.value;
    return ok({ etag: 'e', rev: 1 });
}

function lowestFreeId(takenIds) {
    let id = 1;
    while (takenIds.indexOf(id) >= 0) id++;
    return id;
}

function scheduleCreate(sim, params) {
    if (sim.schedules.size >= limits.SCHEDULE_LIMIT) return failed(limits.ERR_RESOURCE_EXHAUSTED, `Reached the maximum ${limits.SCHEDULE_LIMIT} of jobs`);
    if (params.calls.length > limits.SCHEDULE_CALL_LIMIT) return failed(limits.ERR_INVALID_ARGUMENT, 'Invalid argument \'calls\': Failed validation!');
    const id = Math.max(0, ...sim.schedules.keys()) + 1;
    sim.schedules.set(id, clone(params));
    return ok({ id, rev: 1 });
}

function scheduleDelete(sim, params) {
    if (sim.schedules.delete(params.id)) return ok({ rev: 1 });
    return failed(limits.ERR_INVALID_ARGUMENT, 'Invalid argument \'id\': Not found!');
}

function scheduleUpdate(sim, params) {
    const job = sim.schedules.get(params.id);
    if (!job) return failed(limits.ERR_NOT_FOUND, 'Argument \'id\' not found!');
    Object.assign(job, clone(params));
    return ok({ rev: 1 });
}

function virtualAdd(sim, params) {
    const key = params.type + ':' + params.id;
    const isIdInRange = params.id >= limits.VIRTUAL_ID_FIRST && params.id <= limits.VIRTUAL_ID_LAST;
    if (!isIdInRange) return failed(limits.ERR_INVALID_ARGUMENT, `Invalid argument 'id': should be >= ${limits.VIRTUAL_ID_FIRST} and <= ${limits.VIRTUAL_ID_LAST}!`);
    if (sim.components.length >= limits.VIRTUAL_COMPONENT_LIMIT) return failed(limits.ERR_RESOURCE_EXHAUSTED, `Reached the maximum ${limits.VIRTUAL_COMPONENT_LIMIT} of virtual components`);
    if (sim.components.some((component) => component.key === key)) return failed(limits.ERR_ALREADY_EXISTS, 'Resource \'' + key + '\' already exists!');
    sim.components.push({ key, status: { value: params.config.default_value }, config: clone(params.config) });
    return ok({ id: params.id });
}

function virtualDelete(sim, params) {
    const remaining = sim.components.filter((component) => component.key !== params.key);
    if (remaining.length === sim.components.length) return failed(limits.ERR_NOT_FOUND, 'Argument \'key\', value \'' + params.key + '\' not found!');
    sim.components = remaining;
    return ok(null);
}

function getComponents(sim) {
    return ok({ components: clone(sim.components), offset: 0, total: sim.components.length });
}

function groupSet(sim, params) {
    sim.group = clone(params.value);
    return ok(null);
}

function switchSetConfig(sim, params) {
    Object.assign(sim.switchConfig, params.config);
    return ok({ restart_required: false });
}

function eleringAnswer(sim, url) {
    const query = new URL(url).searchParams;
    const start = Date.parse(query.get('start')) / MILLISECONDS_PER_SECOND;
    const end = Date.parse(query.get('end')) / MILLISECONDS_PER_SECOND;
    const lines = sim.prices.rows.filter((row) => row.timestamp >= start && row.timestamp <= end).map((row) => row.line);
    const body = [sim.prices.header].concat(lines).join('\n') + '\n';
    return { code: 200, body_b64: Buffer.from(body, ELERING_ENCODING).toString('base64') };
}

function forecastAnswer(sim, url) {
    if (sim.forecastBody !== null) return { code: 200, body: sim.forecastBody };
    const hours = Number(new URL(url).searchParams.get('forecast_hours'));
    const temperatures = sim.temperatures.slice(0, hours);
    return { code: 200, body: JSON.stringify({ hourly: { apparent_temperature: temperatures } }) };
}

function httpAnswer(sim, url) {
    if (sim.httpFail && sim.httpFail.test(url)) return failed(limits.ERR_HTTP_FAILURE_ASSUMED, 'Deadline exceeded');
    if (url.indexOf('dashboard.elering.ee') >= 0) return ok(eleringAnswer(sim, url));
    if (url.indexOf('api.open-meteo.com') >= 0) return ok(forecastAnswer(sim, url));
    throw new Error('No simulated answer for ' + url);
}

function httpGet(sim, params) {
    sim.httpRequests.push(params.url);
    return httpAnswer(sim, params.url);
}

function scriptList(sim) {
    return ok({ scripts: sim.scripts.map((script) => ({ id: script.id, name: script.name, running: script.running })) });
}

function scriptCreate(sim, params) {
    if (sim.scripts.length >= limits.SCRIPT_LIMIT) return failed(limits.ERR_RESOURCE_EXHAUSTED, `Reached the maximum ${limits.SCRIPT_LIMIT} of stored scripts`);
    const id = lowestFreeId(sim.scripts.map((script) => script.id));
    sim.scripts.push({ id, name: params.name, running: false, enable: false });
    return ok({ id });
}

function scriptPutCode(sim, params) {
    sim.scriptCode[params.id] = params.code;
    return ok({ len: params.code.length });
}

function scriptById(sim, id) {
    return sim.scripts.find((script) => script.id === id);
}

function scriptSetConfig(sim, params) {
    Object.assign(scriptById(sim, params.id), params.config);
    return ok({ restart_required: false });
}

function setScriptRunning(sim, params, isRunning) {
    const script = scriptById(sim, params.id);
    const wasRunning = script.running;
    script.running = isRunning;
    return ok({ was_running: wasRunning });
}

const RPC_HANDLERS = {
    'kvs.get': kvsGet,
    'kvs.set': kvsSet,
    'schedule.create': scheduleCreate,
    'schedule.delete': scheduleDelete,
    'schedule.update': scheduleUpdate,
    'virtual.add': virtualAdd,
    'virtual.delete': virtualDelete,
    'shelly.getcomponents': getComponents,
    'group.set': groupSet,
    'switch.setconfig': switchSetConfig,
    'http.get': httpGet,
    'script.list': scriptList,
    'script.create': scriptCreate,
    'script.putcode': scriptPutCode,
    'script.setconfig': scriptSetConfig,
    'script.start': (sim, params) => setScriptRunning(sim, params, true),
    'script.stop': (sim, params) => setScriptRunning(sim, params, false),
};

function answerOf(sim, method, params) {
    const handler = RPC_HANDLERS[method.toLowerCase()];
    if (!handler) throw new Error('Method ' + method + ' is not simulated');
    if (sim.rpcFail && sim.rpcFail.test(method)) return failed(limits.ERR_RPC_FAILURE_ASSUMED, method + ' failed');
    return handler(sim, params || {});
}

function recordRead(sim, read, answer) {
    sim.reads.push(Object.assign({}, read, { answer: clone(answer) }));
}

function shellyApi(sim) {
    return {
        call(method, params, callback, userdata) {
            if (sim.callsInFlight >= limits.RPC_CALL_LIMIT) {
                crash(sim, `more than ${limits.RPC_CALL_LIMIT} RPC calls in flight (${method})`);
                return;
            }
            const [result, code, message] = answerOf(sim, method, params);
            sim.calls.push({ method, params: params ? clone(params) : params, answer: clone([result, code, message]) });
            sim.callsInFlight++;
            addTask(sim, sim.nowMs, () => {
                sim.callsInFlight--;
                if (typeof callback === 'function') callback(result, code, message, userdata);
            });
        },
        getComponentStatus(type, id) {
            const answer = type === 'sys' ? { unixtime: Math.floor(sim.nowMs / MILLISECONDS_PER_SECOND) } : { mem_used: 0, mem_peak: 0 };
            recordRead(sim, { name: 'getComponentStatus', type, id }, answer);
            return answer;
        },
        getComponentConfig(type, id) {
            const answer = type === 'sys' ? { location: Object.assign({}, DEVICE_LOCATION) } : { enable: scriptById(sim, id).enable };
            recordRead(sim, { name: 'getComponentConfig', type, id }, answer);
            return answer;
        },
        getDeviceInfo: () => Object.assign({}, sim.deviceInfo),
        getCurrentScriptId: () => sim.scriptId,
        addStatusHandler(handler) {
            sim.statusHandlers.push(handler);
        },
    };
}

function timerApi(sim) {
    return {
        set(delayMs, isRepeating, callback, userdata) {
            const timer = { handle: ++sim.lastTimerHandle, isCleared: false };
            const fire = () => {
                if (timer.isCleared) return;
                if (isRepeating) addTask(sim, sim.nowMs + delayMs, fire);
                else timer.isCleared = true;
                callback(userdata);
            };
            addTask(sim, sim.nowMs + delayMs, fire);
            sim.timers.push(timer);
            const activeCount = sim.timers.filter((entry) => !entry.isCleared).length;
            if (activeCount > limits.TIMER_LIMIT) crash(sim, `more than ${limits.TIMER_LIMIT} timers active`);
            return timer.handle;
        },
        clear(handle) {
            const timer = sim.timers.find((entry) => entry.handle === handle);
            if (!timer || timer.isCleared) return undefined;
            timer.isCleared = true;
            return true;
        },
    };
}

function heatingMinutes(sim) {
    const minutesPerStart = (sim.switchConfig.auto_off_delay - RELAY_OVERLAP_SECONDS) / SECONDS_PER_MINUTE;
    const minutesOn = new Set();
    for (const job of sim.schedules.values()) {
        const fields = job.timespec.split(' ');
        const startMinute = Number(fields[1]);
        for (const hour of fields[2].split(',').map(Number)) {
            for (let i = 0; i < minutesPerStart; i++) minutesOn.add((hour * MINUTES_PER_HOUR + startMinute + i) % MINUTES_PER_DAY);
        }
    }
    return minutesOn.size;
}

function initialState(deviceOptions) {
    const schedules = new Map();
    for (const id of Object.keys(deviceOptions.schedules)) {
        schedules.set(Number(id), Object.assign({ enable: true }, clone(deviceOptions.schedules[id])));
    }
    return {
        nowMs: Date.parse(deviceOptions.now),
        kvs: Object.assign({}, deviceOptions.kvs),
        schedules,
        components: clone(deviceOptions.components),
        scripts: clone(deviceOptions.scripts),
        scriptId: deviceOptions.scriptId,
        deviceInfo: deviceOptions.deviceInfo,
        prices: eleringRows(deviceOptions.elering),
        temperatures: deviceOptions.temperatures || forecastTemperatures(),
        forecastBody: deviceOptions.forecastBody,
        httpFail: deviceOptions.httpFail,
        rpcFail: deviceOptions.rpcFail,
        scriptCode: {},
        switchConfig: {},
        group: null,
        calls: [],
        logs: [],
        httpRequests: [],
        statusHandlers: [],
        timers: [],
        lastTimerHandle: 0,
        tasks: [],
        taskSequence: 0,
        reads: [],
        callsInFlight: 0,
        crashed: null,
    };
}

function createShelly(options) {
    const deviceOptions = Object.assign({
        now: NORMAL_DAY.now,
        kvs: {},
        schedules: {},
        components: [],
        elering: NORMAL_DAY.fixture,
        temperatures: null,
        forecastBody: null,
        httpFail: null,
        rpcFail: null,
        code: null,
        scripts: [HEATING_SCRIPT_ENTRY],
        scriptId: HEATING_SCRIPT_ID,
        deviceInfo: GEN2_DEVICE,
    }, options);
    const sim = initialState(deviceOptions);
    sim.options = deviceOptions;
    const shelly = shellyApi(sim);
    const timer = timerApi(sim);
    const log = (...parts) => sim.logs.push(parts.map(String).join(' '));
    const context = vm.createContext({
        Shelly: shelly,
        Timer: timer,
        print: log,
        console: { log },
        atob: (text) => Buffer.from(text, 'base64').toString(ELERING_ENCODING),
        __now: () => sim.nowMs,
    });
    vm.runInContext(FAKE_CLOCK, context);

    sim.eval = (code) => vm.runInContext(code, context);
    sim.load = () => {
        sim.eval(deviceOptions.code === null ? fs.readFileSync(HEATING_SCRIPT, 'utf8') : deviceOptions.code);
        return sim;
    };
    sim.runFor = (seconds) => {
        runFor(sim, seconds);
        return sim;
    };
    sim.rpc = (method, params) => {
        let answer = null;
        shelly.call(method, params, (result, code, message) => { answer = { result, code, message }; });
        runFor(sim, 0);
        return answer;
    };
    sim.setTimer = (delayMs) => timer.set(delayMs, false, () => {});
    sim.emitStatus = (status) => sim.statusHandlers.forEach((handler) => handler(status));
    sim.heatingMinutes = () => heatingMinutes(sim);
    sim.timespecs = () => [...sim.schedules.values()].map((job) => job.timespec).sort();
    sim.storedJson = (key) => JSON.parse(sim.kvs[key]);
    return sim;
}

function runWatchdog(sim, code, stoppedScriptId) {
    const watchdog = createShelly({ code, now: new Date(sim.nowMs).toISOString(), scriptId: WATCHDOG_SCRIPT_ID });
    watchdog.kvs = sim.kvs;
    watchdog.schedules = sim.schedules;
    watchdog.load();
    watchdog.emitStatus({ component: 'script:' + stoppedScriptId, name: 'script', id: stoppedScriptId, delta: { id: stoppedScriptId, running: false } });
    watchdog.runFor(WATCHDOG_RUN_SECONDS);
    return watchdog;
}

module.exports = { createShelly, runWatchdog, eleringRows, ROOT, HEATING_SCRIPT };
