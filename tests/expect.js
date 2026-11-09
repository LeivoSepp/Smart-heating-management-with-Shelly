'use strict';
/*
The oracle's plan for a KVS configuration: the mapping from the configuration keys to the
oracle's parameters, shared by the test files.
*/
const oracle = require('./oracle');

// extra: oracle parameters that override the mapping (slotsPerPeriod, periods)
function expectedPlan(day, conf, extra) {
    const slotMinutes = conf.SlotMinutes || 60;
    return oracle.slotPlan(day.fixture, day.isoDate, Object.assign({
        tPer: conf.TimePeriod,
        slotsPerPeriod: Math.floor(Math.min(conf.HeatingTime, conf.TimePeriod) * 60 / slotMinutes),
        lowR: conf.AlwaysOnPrice,
        higR: conf.AlwaysOffPrice,
        fulR: conf.MaxFullPrice || 0,
        pack: conf.EnergyProvider,
        sltM: slotMinutes,
    }, extra));
}

function expectedTimespecs(day, conf, extra) {
    return oracle.slotTimespecs(expectedPlan(day, conf, extra));
}

module.exports = { expectedPlan, expectedTimespecs };
