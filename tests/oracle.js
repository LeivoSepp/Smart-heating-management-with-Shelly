'use strict';
/*
Independent reference calculations for the tests: Elektrilevi network fees, the
cheapest hours (v4.9) and the cheapest price slots of any length, computed straight from
the fixture CSV without the script's code.
*/
const { eleringRows } = require('./harness');

const PACKAGES = {
    NONE: { dRt: 0, nRt: 0, dMRt: 0, hMRt: 0 },
    VORK2: { dRt: 60.7, nRt: 35.1, dMRt: 60.7, hMRt: 35.1 },
    VORK4: { dRt: 36.9, nRt: 21, dMRt: 36.9, hMRt: 21 },
    VORK5: { dRt: 52.9, nRt: 30.3, dMRt: 81.8, hMRt: 47.4 },
};
const QUARTER_SECONDS = 900;
// Estonia: charges on top of market price and network fee (EUR/MWh, no VAT) and VAT
const TAX_EE = { fix: 21.81, vat: 0.24 };

// Elektrilevi rules: winter (Nov-Mar) peaks MO-FR 9-12 and 16-20, SA-SU 16-20; night 22-7 and weekends.
function elektrileviFee(ts, packName) {
    const fees = PACKAGES[packName];
    const date = new Date(ts * 1000);
    const hour = date.getHours();
    const day = date.getDay();
    const isWinter = date.getMonth() >= 10 || date.getMonth() <= 2;
    const isWeekend = day === 0 || day === 6;
    const isEveningPeak = hour >= 16 && hour < 20;
    const isMorningPeak = hour >= 9 && hour < 12;
    if (isWinter && isWeekend && isEveningPeak) return fees.hMRt;
    if (isWinter && !isWeekend && (isMorningPeak || isEveningPeak)) return fees.dMRt;
    if (hour < 7 || hour >= 22 || isWeekend) return fees.nRt;
    return fees.dRt;
}

// Local midnight of the day containing the given ISO date, as epoch seconds.
function dayStart(isoDate) {
    const [year, month, day] = isoDate.split('-').map(Number);
    return new Date(year, month - 1, day).getTime() / 1000;
}

// Price slots of the day: groups of slotMinutes / 15 consecutive Elering rows, the average spot
// price and the average network fee each rounded like the script; a DST day's incomplete last
// group is not a slot.
function slotsOfDay(fixture, isoDate, packName, slotMinutes = 15) {
    const start = dayStart(isoDate);
    const [year, month, day] = isoDate.split('-').map(Number);
    const end = new Date(year, month - 1, day + 1).getTime() / 1000;
    const rows = eleringRows(fixture).rows.filter((row) => row.ts >= start && row.ts < end);
    const perSlot = slotMinutes * 60 / QUARTER_SECONDS;
    const slots = [];
    for (let from = 0; from + perSlot <= rows.length; from += perSlot) {
        const group = rows.slice(from, from + perSlot);
        const first = group[0];
        const date = new Date(first.ts * 1000);
        const net = Math.round(group.reduce((sum, row) => sum + row.price, 0) * 100 / perSlot);
        const fee = Math.round(group.reduce((sum, row) => sum + elektrileviFee(row.ts, packName), 0) * 100 / perSlot);
        slots.push({ index: slots.length, ts: first.ts, hour: date.getHours(), minute: date.getMinutes(), net, total: net + fee });
    }
    return slots;
}

function cheapest(slots, count) {
    return slots.slice().sort((a, b) => a.total - b.total || a.index - b.index).slice(0, count);
}

/*
Slots to heat: per period (by local hour) the `slotsPerPeriod` cheapest, plus every slot
cheaper than lowR, minus every slot dearer than higR and every slot whose full price
(total + charges, VAT included) is above fulR (when fulR > 0). Without a period only the
slots below lowR, with the same two upper limits.
config.sltM: slot length in minutes (default 15); config.periods: period numbers to plan (default all).
*/
function slotPlan(fixture, isoDate, config) {
    const slots = slotsOfDay(fixture, isoDate, config.pack, config.sltM || 15);
    const isDear = (slot) => slot.net > config.higR * 100 || isAboveFullPrice(slot, config.fulR);
    const chosen = new Set();
    if (config.tPer > 0) {
        const periodCount = Math.ceil(24 / config.tPer);
        for (let period = 0; period < periodCount; period++) {
            if (config.periods && config.periods.indexOf(period) < 0) continue;
            const inPeriod = slots.filter((s) => Math.floor(s.hour / config.tPer) === period);
            const picked = new Set(cheapest(inPeriod, config.slotsPerPeriod));
            for (const slot of inPeriod) {
                const isCheap = picked.has(slot) || slot.net < config.lowR * 100;
                if (isCheap && !isDear(slot)) chosen.add(slot);
            }
        }
    } else {
        for (const slot of slots) {
            if (slot.net < config.lowR * 100 && !isDear(slot)) chosen.add(slot);
        }
    }
    return [...chosen].sort((a, b) => a.index - b.index);
}

function isAboveFullPrice(slot, fulR) {
    if (!fulR) return false;
    return Math.round((slot.total + TAX_EE.fix * 100) * (1 + TAX_EE.vat)) > fulR * 100;
}

// Expected Schedule timespecs ("0 MM h1,h2 * * *") for a set of slots.
function slotTimespecs(slots) {
    const hoursByMinute = new Map();
    for (const slot of slots) {
        if (!hoursByMinute.has(slot.minute)) hoursByMinute.set(slot.minute, new Set());
        hoursByMinute.get(slot.minute).add(slot.hour);
    }
    return [...hoursByMinute.keys()].sort((a, b) => a - b)
        .map((minute) => '0 ' + minute + ' ' + [...hoursByMinute.get(minute)].sort((a, b) => a - b).join(',') + ' * * *')
        .sort();
}

// v4.9: hourly averages rounded to cents plus the fee of the first quarter.
function hourlyPrices(fixture, isoDate, packName) {
    const slots = slotsOfDay(fixture, isoDate, packName);
    const hours = [];
    for (const slot of slots) {
        const last = hours[hours.length - 1];
        if (last && last.hour === slot.hour) {
            last.sum += slot.net / 100;
            last.count++;
        } else {
            hours.push({ hour: slot.hour, ts: slot.ts, sum: slot.net / 100, count: 1 });
        }
    }
    return hours.map((h, index) => ({
        index,
        hour: h.hour,
        net: Math.round((h.sum / h.count) * 100) / 100,
        total: Math.round((h.sum / h.count) * 100) / 100 + elektrileviFee(h.ts, packName),
    }));
}

function cheapestHours(fixture, isoDate, packName, count) {
    return cheapest(hourlyPrices(fixture, isoDate, packName), count).map((h) => h.hour).sort((a, b) => a - b);
}

// Minutes of the day with the relay on, from the schedules and the auto-off delay; overlapping
// schedules and a run past midnight count once per minute of the clock.
function heatingMinutes(sim) {
    const slotMinutes = (sim.switchConfig.auto_off_delay - 10) / 60;
    const on = new Set();
    for (const timespec of sim.timespecs()) {
        const fields = timespec.split(' ');
        for (const minute of fields[1].split(',').map(Number)) {
            for (const hour of fields[2].split(',').map(Number)) {
                for (let m = 0; m < slotMinutes; m++) on.add((hour * 60 + minute + m) % (24 * 60));
            }
        }
    }
    return on.size;
}

module.exports = { elektrileviFee, slotsOfDay, slotPlan, slotTimespecs, hourlyPrices, cheapestHours, heatingMinutes };
