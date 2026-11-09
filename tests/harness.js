'use strict';
/*
Minimal Shelly Gen2 scripting runtime for tests: loads a script file into a node:vm
context with mocked Shelly globals, a fake clock and a deterministic event loop.
Run with TZ=Europe/Tallinn (package.json sets it).
Fixtures are real answers downloaded on 2026-10-08: Elering NPS CSV (fields=ee, 15 min,
cover the planned day with a margin of a few hours (a second day needs a second fixture)) and Open-Meteo apparent temperature.
*/
const fs = require('node:fs');
const path = require('node:path');
const { RPC_CALL_LIMIT, TIMER_LIMIT } = require('./settings');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const SCRIPT = path.join(ROOT, 'SmartHeatingWidthShelly.js');
const MAX_SCHEDULES = 20;
const MAX_CALLS_PER_SCHEDULE = 5;
const MAX_STEPS = 100000;
const ERR_NOT_FOUND = -105;
const ERR_HTTP = -104;
const DEFAULT_SCRIPTS = [{ id: 1, name: 'Smart Heating', running: true }];
const DEFAULT_DEVICE_INFO = { gen: 2, app: 'Plus1PM', ver: '1.7.5', id: 'shellyplus1pm-test' };
const LOCATION = { lat: 59.437, lon: 24.7536 };

function readFixture(name) {
    return fs.readFileSync(path.join(FIXTURES, name), 'latin1');
}

// Rows of several fixtures as one answer source (consecutive days, overlapping rows once)
function mergeRows(parts) {
    const seen = new Set();
    const rows = parts.flatMap((part) => part.rows).filter((row) => !seen.has(row.ts) && seen.add(row.ts));
    return { header: parts[0].header, rows: rows.sort((a, b) => a.ts - b.ts) };
}

// Elering CSV rows of a fixture as {ts, price, line}
function eleringRows(fixture) {
    const lines = readFixture(fixture).split('\n');
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        if (!lines[i]) continue;
        const fields = lines[i].split(';').map((f) => f.replace(/"/g, ''));
        rows.push({ ts: Number(fields[0]), price: Number(fields[2].replace(',', '.')), line: lines[i] });
    }
    return { header: lines[0], rows };
}

// Values and nested arrays in an array, a rough count of engine variables it holds
function countValues(array) {
    let count = 0;
    for (const value of array) count += Array.isArray(value) ? 1 + countValues(value) : 1;
    return count;
}

function forecastBody(temps, hours) {
    const values = temps.slice(0, hours);
    return JSON.stringify({ hourly: { time: values.map((v, i) => 'T' + i), apparent_temperature: values } });
}

function defaultTemps() {
    return JSON.parse(readFixture('open-meteo-24h.json')).hourly.apparent_temperature;
}

/*
options:
  now          ISO string, the fake wall clock at start
  kvs          initial KVS { key: stringValue }
  schedules    initial schedules { id: {timespec, calls} }
  elering      fixture file name, or null for header-only answers
  eleringDrop  epochs of rows left out of the Elering answers
  temps        forecast temperatures (default: open-meteo fixture)
  forecastText raw Open-Meteo body instead of temps
  httpFail     RegExp of URLs whose HTTP.GET fails
  scriptFile   script to load (default: SmartHeatingWidthShelly.js)
  code         script source instead of scriptFile
  scripts      initial Script.List entries
  deviceInfo   Shelly.getDeviceInfo() result
  scheduleDeleteFail  schedule IDs whose Schedule.Delete fails with -114
  rpcFail      { 'lower.case.method': errorCode } answered instead of the mock
  rpcDelayMs   RPC callback latency in ms, a number or { 'lower.case.method': ms }
  timeAfterS   the device clock is unsynced for this many seconds after start: unixtime null, Date from 1970
  kvsGetFail   KVS keys whose KVS.Get fails with -1
  components   initial virtual components [{ key, status: { value }, config }]
*/
function createShelly(options) {
    const opts = Object.assign({
        now: '2026-10-06T23:20:00+03:00',
        kvs: {},
        schedules: {},
        elering: 'elering-2026-10-07.csv',
        temps: null,
        httpFail: null,
        scriptFile: SCRIPT,
        code: null,
        scripts: DEFAULT_SCRIPTS.map((s) => Object.assign({}, s)),
        deviceInfo: DEFAULT_DEVICE_INFO,
        scheduleDeleteFail: [],
        rpcFail: {},
        kvsGetFail: [],
        rpcDelayMs: 0,
        timeAfterS: 0,
        components: [],
        scriptId: 1,
    }, options);
    const startMs = Date.parse(opts.now);

    const sim = {
        nowMs: Date.parse(opts.now),
        kvs: Object.assign({}, opts.kvs),
        schedules: new Map(),
        nextScheduleId: 1,
        calls: [],
        logs: [],
        httpRequests: [],
        httpAnswers: [],
        switchConfig: {},
        switchSets: [],
        scripts: opts.scripts.map((s) => Object.assign({}, s)),
        scriptCode: {},
        crashed: null,
        inFlight: 0,
        maxInFlight: 0,
        inFlightBy: {},
        maxInFlightBy: {},
        components: opts.components.map((c) => JSON.parse(JSON.stringify(c))),
        group: null,
        metrics: { atobBytes: 0, maxSubstring: 0, maxArrayJson: 0, maxArrayValues: 0 },
        statusHandlers: [],
        tasks: [],
        seq: 0,
    };
    for (const id of Object.keys(opts.schedules)) {
        sim.schedules.set(Number(id), Object.assign({ enable: true }, opts.schedules[id]));
        sim.nextScheduleId = Math.max(sim.nextScheduleId, Number(id) + 1);
    }

    const eleringData = opts.elering ? mergeRows([].concat(opts.elering).map(eleringRows)) : null;
    const temps = opts.temps || defaultTemps();

    function enqueue(atMs, fn) {
        const task = { at: atMs, seq: sim.seq++, fn };
        sim.tasks.push(task);
        return task;
    }

    function log() {
        sim.logs.push(Array.prototype.map.call(arguments, String).join(' '));
    }

    function eleringResponse(url) {
        const query = new URL(url).searchParams;
        const start = Date.parse(query.get('start')) / 1000;
        const end = Date.parse(query.get('end')) / 1000;
        let body = (eleringData ? eleringData.header : '"Ajatempel (UTC)";"Kuup\xe4ev (Eesti aeg)";"NPS Eesti"') + '\n';
        if (eleringData) {
            for (const row of eleringData.rows) {
                const isDropped = opts.eleringDrop && opts.eleringDrop.indexOf(row.ts) >= 0;
                if (row.ts >= start && row.ts <= end && !isDropped) body += row.line + '\n';
            }
        }
        return { code: 200, body_b64: Buffer.from(body, 'latin1').toString('base64') };
    }

    function httpGet(params) {
        sim.httpRequests.push(params.url);
        const answer = httpAnswer(params);
        sim.httpAnswers.push({ url: params.url, answer: JSON.parse(JSON.stringify(answer)) });
        return answer;
    }

    function httpAnswer(params) {
        if (opts.httpFail && opts.httpFail.test(params.url)) {
            return [null, ERR_HTTP, 'Deadline exceeded'];
        }
        if (params.url.indexOf('dashboard.elering.ee') >= 0) {
            return [eleringResponse(params.url), 0, ''];
        }
        if (params.url.indexOf('api.open-meteo.com') >= 0) {
            const hours = Number(new URL(params.url).searchParams.get('forecast_hours'));
            return [{ code: 200, body: opts.forecastText || forecastBody(temps, hours) }, 0, ''];
        }
        return [null, ERR_HTTP, 'Unknown host'];
    }

    function scheduleCreate(params) {
        if (sim.schedules.size >= MAX_SCHEDULES) return [null, -103, 'Too many schedules'];
        if (!params.calls || params.calls.length > MAX_CALLS_PER_SCHEDULE) return [null, -103, 'Too many calls'];
        if (String(params.timespec).split(' ').length !== 6) return [null, -103, 'Invalid timespec'];
        const id = sim.nextScheduleId++;
        sim.schedules.set(id, JSON.parse(JSON.stringify(params)));
        return [{ id, rev: id }, 0, ''];
    }

    function isUnsynced() {
        return sim.nowMs < startMs + opts.timeAfterS * 1000;
    }

    function unixtime() {
        return isUnsynced() ? null : Math.floor(sim.nowMs / 1000);
    }

    function rpc(method, params) {
        const forced = opts.rpcFail[method.toLowerCase()];
        if (forced) return [null, forced, 'rpcFail ' + method];
        const p = params || {};
        switch (method.toLowerCase()) {
            case 'kvs.get':
                if (opts.kvsGetFail.indexOf(p.key) >= 0) return [null, -1, 'KVS.Get failed in the test'];
                return p.key in sim.kvs ? [{ value: sim.kvs[p.key], etag: 'e' }, 0, '']
                    : [null, ERR_NOT_FOUND, 'Argument \'key\', value \'' + p.key + '\' not found!'];
            case 'kvs.set':
                sim.kvs[p.key] = p.value;
                return [{ etag: 'e', rev: 1 }, 0, ''];
            case 'schedule.create':
                return scheduleCreate(p);
            case 'schedule.delete':
                if (opts.scheduleDeleteFail.indexOf(p.id) >= 0) return [null, -114, 'Schedule.Delete failed in the test'];
                return sim.schedules.delete(p.id) ? [{ rev: 1 }, 0, '']
                    : [null, ERR_NOT_FOUND, 'Job id ' + p.id + ' not found!'];
            case 'switch.set':
                sim.switchSets.push(p);
                return [{ was_on: false }, 0, ''];
            case 'switch.setconfig':
                Object.assign(sim.switchConfig, p.config);
                return [{ restart_required: false }, 0, ''];
            case 'http.get':
                return httpGet(p);
            case 'shelly.getdeviceinfo':
                return [opts.deviceInfo, 0, ''];
            case 'sys.getstatus':
                return [{ unixtime: unixtime() }, 0, ''];
            case 'schedule.update': {
                const job = sim.schedules.get(p.id);
                if (!job) return [null, ERR_NOT_FOUND, 'Job id ' + p.id + ' not found!'];
                Object.assign(job, p);
                return [{ rev: 1 }, 0, ''];
            }
            case 'shelly.getcomponents':
                return [{ components: JSON.parse(JSON.stringify(sim.components)), offset: 0, total: sim.components.length }, 0, ''];
            case 'virtual.add':
                sim.components.push({ key: p.type + ':' + p.id, status: { value: p.config.default_value }, config: p.config });
                return [{ id: p.id }, 0, ''];
            case 'virtual.delete':
                sim.components = sim.components.filter((c) => c.key !== p.key);
                return [{}, 0, ''];
            case 'group.set':
                sim.group = p.value;
                return [{}, 0, ''];
            case 'script.list':
                return [{ scripts: sim.scripts.map((s) => Object.assign({}, s)) }, 0, ''];
            case 'script.create': {
                const id = Math.max(0, ...sim.scripts.map((s) => s.id)) + 1;
                sim.scripts.push({ id, name: p.name, running: false });
                return [{ id }, 0, ''];
            }
            case 'script.putcode':
                sim.scriptCode[p.id] = p.code;
                return [{ len: p.code.length }, 0, ''];
            case 'script.start':
            case 'script.stop':
            case 'script.setconfig':
                return [{}, 0, ''];
            default:
                return [null, -114, 'Method ' + method + ' not mocked'];
        }
    }

    const Shelly = {
        call(method, params, callback, userdata) {
            sim.calls.push({ method, params: params ? JSON.parse(JSON.stringify(params)) : params });
            const answer = rpc(method, params);
            if (sim.inFlight >= RPC_CALL_LIMIT) sim.crashed = sim.crashed || `more than ${RPC_CALL_LIMIT} RPC calls in flight (${method})`;
            sim.inFlight++;
            sim.maxInFlight = Math.max(sim.maxInFlight, sim.inFlight);
            sim.inFlightBy[method] = (sim.inFlightBy[method] || 0) + 1;
            sim.maxInFlightBy[method] = Math.max(sim.maxInFlightBy[method] || 0, sim.inFlightBy[method]);
            const delay = typeof opts.rpcDelayMs === 'number' ? opts.rpcDelayMs : (opts.rpcDelayMs[method.toLowerCase()] || 0);
            enqueue(sim.nowMs + delay, () => {
                sim.inFlight--;
                sim.inFlightBy[method]--;
                if (typeof callback === 'function') callback(answer[0], answer[1], answer[2], userdata);
            });
        },
        getComponentStatus(type, id) {
            if (type === 'sys') return { unixtime: unixtime() };
            if (type === 'script' || String(type).indexOf('script') === 0) return { id, running: true, mem_used: 0, mem_peak: 0 };
            return {};
        },
        getComponentConfig(type) {
            if (type === 'sys') return { location: LOCATION };
            if (String(type).indexOf('script') === 0) return { enable: true };
            return {};
        },
        getDeviceInfo() { return opts.deviceInfo; },
        getCurrentScriptId() { return opts.scriptId; },
        addStatusHandler(fn) { sim.statusHandlers.push(fn); return sim.statusHandlers.length; },
    };

    const Timer = {
        set(ms, repeat, fn, userdata) {
            const timer = { handle: ++sim.timerSeq, cleared: false };
            const fire = () => {
                if (timer.cleared) return;
                if (repeat) enqueue(sim.nowMs + ms, fire);
                else timer.cleared = true;
                fn(userdata);
            };
            enqueue(sim.nowMs + ms, fire);
            sim.timers.set(timer.handle, timer);
            const active = [...sim.timers.values()].filter((t) => !t.cleared).length;
            if (active > TIMER_LIMIT) sim.crashed = sim.crashed || `more than ${TIMER_LIMIT} timers active`;
            return timer.handle;
        },
        clear(handle) {
            const timer = sim.timers.get(handle);
            if (timer) timer.cleared = true;
            return !!timer;
        },
    };
    sim.timers = new Map();
    sim.timerSeq = 0;

    const context = vm.createContext({
        Shelly,
        Timer,
        print: log,
        console: { log },
        atob(b64) {
            const text = Buffer.from(b64, 'base64').toString('latin1');
            sim.metrics.atobBytes = Math.max(sim.metrics.atobBytes, b64.length + text.length);
            return text;
        },
        __now: () => (isUnsynced() ? sim.nowMs - startMs : sim.nowMs),
    });
    vm.runInContext(`
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
    `, context);

    function instrumentMemory() {
        const proto = vm.runInContext('String.prototype', context);
        const arrayProto = vm.runInContext('Array.prototype', context);
        const substring = proto.substring;
        const slice = proto.slice;
        const push = arrayProto.push;
        const json = vm.runInContext('JSON', context);
        const track = (value) => {
            sim.metrics.maxSubstring = Math.max(sim.metrics.maxSubstring, value.length);
            return value;
        };
        proto.substring = function () { return track(substring.apply(this, arguments)); };
        proto.slice = function () { return track(slice.apply(this, arguments)); };
        arrayProto.push = function () {
            const length = push.apply(this, arguments);
            sim.metrics.maxArrayJson = Math.max(sim.metrics.maxArrayJson, json.stringify(this).length);
            sim.metrics.maxArrayValues = Math.max(sim.metrics.maxArrayValues, countValues(this));
            return length;
        };
    }

    sim.context = context;
    sim.eval = (code) => vm.runInContext(code, context);
    sim.load = (memory) => {
        if (memory) instrumentMemory();
        const file = opts.scriptFile || SCRIPT;
        const code = opts.code || fs.readFileSync(file, 'utf8');
        vm.runInContext(code, context, { filename: path.basename(file) });
        return sim;
    };
    // Advance the fake clock, running due RPC callbacks and timers in order.
    sim.runFor = (seconds) => {
        const until = sim.nowMs + seconds * 1000;
        for (let steps = 0; steps < MAX_STEPS; steps++) {
            if (sim.crashed) return sim;
            let next = null;
            for (const task of sim.tasks) {
                if (task.at <= until && (!next || task.at < next.at || (task.at === next.at && task.seq < next.seq))) next = task;
            }
            if (!next) break;
            sim.tasks.splice(sim.tasks.indexOf(next), 1);
            sim.nowMs = Math.max(sim.nowMs, next.at);
            try {
                next.fn();
            } catch (error) {
                sim.crashed = error;
                sim.logs.push('Uncaught ' + error.stack);
            }
        }
        sim.nowMs = Math.max(sim.nowMs, until);
        return sim;
    };
    sim.emitStatus = (status) => {
        for (const handler of sim.statusHandlers) handler(status);
        return sim;
    };
    sim.timespecs = () => [...sim.schedules.values()].map((job) => job.timespec).sort();
    sim.setHttpFail = (pattern) => { opts.httpFail = pattern; return sim; };
    sim.setRpcFail = (map) => { opts.rpcFail = map; return sim; };
    sim.setKvsGetFail = (keys) => { opts.kvsGetFail = keys; return sim; };
    sim.kvsSets = (key) => sim.calls.filter((call) => call.method.toLowerCase() === 'kvs.set' && call.params.key === key).length;
    sim.json = (key) => JSON.parse(sim.kvs[key]);
    return sim;
}

// Runs the installed watchdog code on its own runtime sharing KVS and schedules with sim.
function runWatchdog(sim, code, stoppedScriptId, options = {}) {
    const watchdog = createShelly(Object.assign({ code, now: new Date(sim.nowMs).toISOString(), scriptId: 2 }, options));
    watchdog.kvs = sim.kvs;
    watchdog.schedules = sim.schedules;
    watchdog.load();
    watchdog.emitStatus({ component: 'script:' + stoppedScriptId, name: 'script', id: stoppedScriptId, delta: { id: stoppedScriptId, running: false } });
    watchdog.runFor(10);
    return watchdog;
}

module.exports = { createShelly, runWatchdog, eleringRows, readFixture, ROOT, SCRIPT, DEFAULT_SCRIPTS, DEFAULT_DEVICE_INFO, LOCATION };
