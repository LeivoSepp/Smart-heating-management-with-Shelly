'use strict';
/*
Configurations, fixtures, limits and paths shared by the test files.
*/
const path = require('node:path');

const LEGACY_SCRIPT = path.join(__dirname, 'legacy', 'SmartHeatingWidthShelly-v4.9.js');
// KVS stores a value with every quote escaped, so a JSON value may hold 253 bytes including one backslash per quote
const KVS_VALUE_LIMIT = 253;
function kvsLength(value) {
    return value.length + (value.match(/"/g) || []).length;
}
// The configuration as the current script stores it: keys at their default value are left out
const STORED_DEFAULTS = { InvertedRelay: false, RelayId: 0, HeatingCurve: 0, ManualKVS: false, MaxFullPrice: 0, SlotMinutes: 60 };
function storedForm(conf) {
    const stored = {};
    for (const key of Object.keys(conf)) {
        if (!(key in STORED_DEFAULTS) || conf[key] !== STORED_DEFAULTS[key]) stored[key] = conf[key];
    }
    return stored;
}
const RPC_CALL_LIMIT = 5;
const TIMER_LIMIT = 5;
const MAX_QUARTER_SCHEDULES = 4;
const DAY_SECONDS = 24 * 60 * 60;
// v4.9 logs "# Internet error", the current script "# Planning error" when the fallback schedule is used
const FALLBACK_LOG = /Internet error|Planning error/;

const DEFAULT_CONF = {
    TimePeriod: 24, HeatingTime: 10, IsForecastUsed: false, EnergyProvider: 'VORK2', AlwaysOnPrice: 1,
    AlwaysOffPrice: 300, InvertedRelay: false, RelayId: 0, Country: 'ee', HeatingCurve: 0, ManualKVS: false,
};
const QUARTER_CONF = Object.assign({}, DEFAULT_CONF, { SlotMinutes: 15 });
// The owner's storage tank: 24 h period, forecast decides the heating time, VORK4
const OWNER_CONF = Object.assign({}, DEFAULT_CONF, {
    HeatingTime: 24, IsForecastUsed: true, EnergyProvider: 'VORK4', AlwaysOnPrice: -200, AlwaysOffPrice: 40,
});
// The owner's second device (hot water): 6 h periods, 2 h each, always on below 40 EUR/MWh
const HOT_WATER_CONF = Object.assign({}, DEFAULT_CONF, {
    TimePeriod: 6, HeatingTime: 2, EnergyProvider: 'VORK4', AlwaysOnPrice: 40, AlwaysOffPrice: 300,
});
const QUARTER_OWNER_CONF = Object.assign({}, OWNER_CONF, { SlotMinutes: 15 });
const QUARTER_HOT_WATER_CONF = Object.assign({}, HOT_WATER_CONF, { SlotMinutes: 15 });

// Recorded Elering days: the fixture, the planned day and a clock just before its daily calculation
const NORMAL_DAY = { fixture: 'elering-2026-10-07.csv', isoDate: '2026-10-07', now: '2026-10-06T23:50:00+03:00' };
const HOT_WATER_DAY = { fixture: 'elering-2026-10-08.csv', isoDate: '2026-10-08', now: '2026-10-07T23:50:00+03:00' };
const SPRING_DAY = { fixture: 'elering-2026-03-29-dst-spring.csv', isoDate: '2026-03-29', now: '2026-03-28T23:50:00+02:00' };
const AUTUMN_DAY = { fixture: 'elering-2025-10-26-dst-autumn.csv', isoDate: '2025-10-26', now: '2025-10-25T23:50:00+03:00' };
const NEGATIVE_DAY = { fixture: 'elering-2026-05-24-negative.csv', isoDate: '2026-05-24', now: '2026-05-23T23:50:00+03:00' };

module.exports = {
    LEGACY_SCRIPT, KVS_VALUE_LIMIT, kvsLength, storedForm, RPC_CALL_LIMIT, TIMER_LIMIT, MAX_QUARTER_SCHEDULES, DAY_SECONDS, FALLBACK_LOG,
    DEFAULT_CONF, QUARTER_CONF, OWNER_CONF, HOT_WATER_CONF, QUARTER_OWNER_CONF, QUARTER_HOT_WATER_CONF,
    NORMAL_DAY, HOT_WATER_DAY, SPRING_DAY, AUTUMN_DAY, NEGATIVE_DAY,
};
