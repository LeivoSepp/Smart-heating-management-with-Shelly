'use strict';

const { eleringRows } = require('./harness');
const { MILLISECONDS_PER_SECOND, HOURS_PER_DAY } = require('./settings');

const ELEKTRILEVI_RATES = {
    VORK2: { dayRate: 60.7, nightRate: 35.1, dayPeakRate: 60.7, holidayPeakRate: 35.1 },
    VORK4: { dayRate: 36.9, nightRate: 21, dayPeakRate: 36.9, holidayPeakRate: 21 },
    VORK5: { dayRate: 52.9, nightRate: 30.3, dayPeakRate: 81.8, holidayPeakRate: 47.4 },
};
const NOVEMBER_MONTH_INDEX = 10;
const MARCH_MONTH_INDEX = 2;
const SUNDAY = 0;
const SATURDAY = 6;
const DAY_RATE_HOURS = { from: 7, until: 22 };
const MORNING_PEAK_HOURS = { from: 9, until: 12 };
const EVENING_PEAK_HOURS = { from: 16, until: 20 };
const CENTS_PER_EURO = 100;

function isWithin(hour, hours) {
    return hour >= hours.from && hour < hours.until;
}

function elektrileviFee(timestamp, packageName) {
    const rates = ELEKTRILEVI_RATES[packageName];
    const date = new Date(timestamp * MILLISECONDS_PER_SECOND);
    const hour = date.getHours();
    const isWinter = date.getMonth() >= NOVEMBER_MONTH_INDEX || date.getMonth() <= MARCH_MONTH_INDEX;
    const isWeekend = date.getDay() === SATURDAY || date.getDay() === SUNDAY;
    const isEveningPeak = isWinter && isWithin(hour, EVENING_PEAK_HOURS);
    const isMorningPeak = isWinter && !isWeekend && isWithin(hour, MORNING_PEAK_HOURS);
    if (isEveningPeak && isWeekend) return rates.holidayPeakRate;
    if (isEveningPeak || isMorningPeak) return rates.dayPeakRate;
    if (isWeekend || !isWithin(hour, DAY_RATE_HOURS)) return rates.nightRate;
    return rates.dayRate;
}

function localMidnight(isoDate, dayOffset) {
    const [year, month, day] = isoDate.split('-').map(Number);
    return new Date(year, month - 1, day + dayOffset).getTime() / MILLISECONDS_PER_SECOND;
}

function hourlyPrices(fixture, isoDate, packageName) {
    const dayStart = localMidnight(isoDate, 0);
    const dayEnd = localMidnight(isoDate, 1);
    const quarters = eleringRows(fixture).rows.filter((row) => row.timestamp >= dayStart && row.timestamp < dayEnd);
    const hours = [];
    for (const quarter of quarters) {
        const hour = new Date(quarter.timestamp * MILLISECONDS_PER_SECOND).getHours();
        const last = hours[hours.length - 1];
        if (last && last.hour === hour) {
            last.sum += quarter.price;
            last.count++;
        } else {
            hours.push({ hour, timestamp: quarter.timestamp, sum: quarter.price, count: 1 });
        }
    }
    return hours.map((entry, index) => {
        const market = Math.round(entry.sum / entry.count * CENTS_PER_EURO) / CENTS_PER_EURO;
        return { index, hour: entry.hour, market, total: market + elektrileviFee(entry.timestamp, packageName) };
    });
}

function cheapest(hours, count) {
    return hours.slice().sort((a, b) => a.total - b.total || a.index - b.index).slice(0, count);
}

function plannedHours(fixture, isoDate, plan) {
    const hours = hourlyPrices(fixture, isoDate, plan.packageName);
    const chosen = new Set(hours.filter((entry) => entry.market < plan.alwaysOnPrice));
    const periodCount = plan.periodHours > 0 ? Math.ceil(HOURS_PER_DAY / plan.periodHours) : 0;
    for (let period = 0; period < periodCount; period++) {
        const inPeriod = hours.filter((entry) => Math.floor(entry.hour / plan.periodHours) === period);
        for (const entry of cheapest(inPeriod, plan.hoursPerPeriod)) chosen.add(entry);
    }
    return [...chosen].filter((entry) => !(entry.market > plan.alwaysOffPrice))
        .sort((a, b) => a.index - b.index).map((entry) => entry.hour);
}

module.exports = { elektrileviFee, plannedHours };
