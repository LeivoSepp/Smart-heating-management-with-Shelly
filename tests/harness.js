'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const limits = require('./limits');
const {
    DEVICE_TIME_ZONE, NORMAL_DAY, GEN2_DEVICE, HEATING_SCRIPT_ID, WATCHDOG_SCRIPT_ID, HEATING_SCRIPT_ENTRY,
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
const LOCATION = { lat: 59.437, lon: 24.7536 };
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
    return [null, code, message];
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
    if (params.key.length > limits.KVS_KEY_LIMIT) return failed(limits.ERR_ASSUMED, 'Key too long');
    if (limits.kvsLength(String(params.value)) > limits.KVS_VALUE_LIMIT) return failed(limits.ERR_ASSUMED, 'Value too long');
    if (isNewKey && Object.keys(sim.kvs).length >= limits.KVS_KEY_COUNT_LIMIT) return failed(limits.ERR_ASSUMED, 'Too many keys');
    sim.kvs[params.key] = params.value;
    return ok({ etag: 'e', rev: 1 });
}

function lowestFreeScheduleId(sim) {
    let id = 1;
    while (sim.schedules.has(id)) id++;
    return id;
}

function scheduleCreate(sim, params) {
    if (sim.schedules.size >= limits.SCHEDULE_LIMIT) return failed(limits.ERR_ASSUMED, 'Too many schedules');
    if (params.calls.length > limits.SCHEDULE_CALL_LIMIT) return failed(limits.ERR_ASSUMED, 'Too many calls');
    const id = lowestFreeScheduleId(sim);
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
    if (!isIdInRange) return failed(limits.ERR_ASSUMED, 'Id out of range');
    if (sim.components.some((component) => component.key === key)) return failed(limits.ERR_ASSUMED, 'Id not available');
    if (sim.components.length >= limits.VIRTUAL_COMPONENT_LIMIT) return failed(limits.ERR_ASSUMED, 'Too many virtual components');
    sim.components.push({ key, status: { value: params.config.default_value }, config: clone(params.config) });
    return ok({ id: params.id });
}

function virtualDelete(sim, params) {
    const remaining = sim.components.filter((component) => component.key !== params.key);
    if (remaining.length === sim.components.length) return failed(limits.ERR_ASSUMED, 'Component not found');
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
    const hours = Number(new URL(url).searchParams.get('forecast_hours'));
    const temperatures = sim.temperatures.slice(0, hours);
    return { code: 200, body: JSON.stringify({ hourly: { apparent_temperature: temperatures } }) };
}

function httpGet(sim, params) {
    sim.httpRequests.push(params.url);
    if (sim.httpFail && sim.httpFail.test(params.url)) return failed(limits.ERR_ASSUMED, 'Deadline exceeded');
    if (params.url.indexOf('dashboard.elering.ee') >= 0) return ok(eleringAnswer(sim, params.url));
    if (params.url.indexOf('api.open-meteo.com') >= 0) return ok(forecastAnswer(sim, params.url));
    throw new Error('No simulated answer for ' + params.url);
}

function scriptList(sim) {
    return ok({ scripts: sim.scripts.map((script) => ({ id: script.id, name: script.name, running: script.running })) });
}

function scriptCreate(sim, params) {
    const id = Math.max(...sim.scripts.map((script) => script.id)) + 1;
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
    return handler(sim, params || {});
}

function shellyApi(sim) {
    return {
        call(method, params, callback, userdata) {
            if (sim.callsInFlight >= limits.RPC_CALL_LIMIT) {
                crash(sim, `more than ${limits.RPC_CALL_LIMIT} RPC calls in flight (${method})`);
                return;
            }
            sim.calls.push({ method, params: params ? clone(params) : params });
            const [result, code, message] = answerOf(sim, method, params);
            sim.callsInFlight++;
            addTask(sim, sim.nowMs, () => {
                sim.callsInFlight--;
                if (typeof callback === 'function') callback(result, code, message, userdata);
            });
        },
        getComponentStatus(type) {
            if (type === 'sys') return { unixtime: Math.floor(sim.nowMs / MILLISECONDS_PER_SECOND) };
            return { mem_used: 0, mem_peak: 0 };
        },
        getComponentConfig(type, id) {
            if (type === 'sys') return { location: Object.assign({}, LOCATION) };
            return { enable: scriptById(sim, id).enable };
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
            if (timer) timer.isCleared = true;
            return Boolean(timer);
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
        httpFail: deviceOptions.httpFail,
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
        httpFail: null,
        code: null,
        scripts: [HEATING_SCRIPT_ENTRY],
        scriptId: HEATING_SCRIPT_ID,
        deviceInfo: GEN2_DEVICE,
    }, options);
    const sim = initialState(deviceOptions);
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

module.exports = { createShelly, runWatchdog, eleringRows, ROOT };
