'use strict';

const DEVICE_TIME_ZONE = 'Europe/Tallinn';
const DEVICE_DAYLIGHT_SAVING = {
    shiftMinutes: 60, standardOffsetMinutes: 120, lastWeekOfMonth: 4, sunday: 0,
    marchIndex: 2, startMinuteOfDay: 180, octoberIndex: 9, endMinuteOfDay: 240, dayOffset: 0,
};
const SCRIPT_VERSION = 4.9;
const CYCLE_SECONDS = 120;

const MILLISECONDS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const RELAY_OVERLAP_SECONDS = 10;

const DEFAULT_CONF = {
    TimePeriod: 24, HeatingTime: 10, IsForecastUsed: false, EnergyProvider: 'VORK2', AlwaysOnPrice: 1,
    AlwaysOffPrice: 300, InvertedRelay: false, RelayId: 0, Country: 'ee', HeatingCurve: 0, ManualKVS: false,
};
const STORAGE_TANK_CONF = Object.assign({}, DEFAULT_CONF, {
    HeatingTime: 24, IsForecastUsed: true, EnergyProvider: 'VORK4', AlwaysOnPrice: -200, AlwaysOffPrice: 40,
});
const HOT_WATER_CONF = Object.assign({}, DEFAULT_CONF, {
    TimePeriod: 6, HeatingTime: 2, EnergyProvider: 'VORK4', AlwaysOnPrice: 40, AlwaysOffPrice: 300,
});

const NORMAL_DAY = { fixture: 'elering-2026-10-07.csv', isoDate: '2026-10-07', now: '2026-10-06T23:20:00+03:00' };
const HOT_WATER_DAY = { fixture: 'elering-2026-10-08.csv', isoDate: '2026-10-08', now: '2026-10-07T23:50:00+03:00' };
const NEGATIVE_DAY = { fixture: 'elering-2026-05-24-negative.csv', isoDate: '2026-05-24', now: '2026-05-23T23:50:00+03:00' };
const SPRING_DST_DAY = { fixture: 'elering-2026-03-29-dst-spring.csv', now: '2026-03-28T23:20:00+02:00' };
const AUTUMN_DST_DAY = { fixture: 'elering-2025-10-26-dst-autumn.csv', now: '2025-10-25T23:20:00+03:00' };

const DEVICE_LOCATION = { lat: 59.437, lon: 24.7536 };
const HEATING_SCRIPT_ID = 1;
const WATCHDOG_SCRIPT_ID = 2;
const HEATING_SCRIPT_ENTRY = { id: HEATING_SCRIPT_ID, name: 'Smart Heating', running: true, enable: true };

const GEN2_DEVICE = { gen: 2, app: 'Plus1PM', ver: '1.7.6', id: 'shellyplus1pm-test' };
const GEN2_PRO_DEVICE = { gen: 2, app: 'Pro1PM', ver: '1.7.6', id: 'shellypro1pm-test' };
const GEN3_DEVICE = { gen: 3, app: 'S3SW-001P16EU', ver: '1.7.6', id: 'shelly1pmg3-test' };
const GEN4_DEVICE = { gen: 4, app: 'Mini1PMG4', ver: '2.2.1', id: 'shelly1pmminig4-test' };

module.exports = {
    DEVICE_TIME_ZONE, DEVICE_DAYLIGHT_SAVING, SCRIPT_VERSION, CYCLE_SECONDS,
    MILLISECONDS_PER_SECOND, SECONDS_PER_MINUTE, MINUTES_PER_HOUR, HOURS_PER_DAY, RELAY_OVERLAP_SECONDS,
    DEFAULT_CONF, STORAGE_TANK_CONF, HOT_WATER_CONF,
    NORMAL_DAY, HOT_WATER_DAY, NEGATIVE_DAY, SPRING_DST_DAY, AUTUMN_DST_DAY,
    DEVICE_LOCATION, HEATING_SCRIPT_ID, WATCHDOG_SCRIPT_ID, HEATING_SCRIPT_ENTRY, GEN2_DEVICE, GEN2_PRO_DEVICE, GEN3_DEVICE, GEN4_DEVICE,
};
