// This script divides day into heating windows, finds cheapest hour(s) from each window, and turns on your (water)heating for that time.

// It's scheduled to run daily after 23:00 to set the heating windows for next day.
// by Leivo Sepp, 31.01.2023
// Energy Market price is downloaded from Elering API https://dashboard.elering.ee/assets/api-doc.html#/nps-controller/getPriceUsingGET. 

// Estonia-ee, Finland-fi, Lithuania-lt, Latvia-lv
let country = "ee";
let heatingWindow = 6;  //one window size in hours, if zero then only alwaysOnMaxPrice and alwaysOffMinPrice used
let heatingTime = 1;    //heating time in hours

let alwaysOnMaxPrice = 1;
let alwaysOffMinPrice = 300;

let is_reverse = false;

let timezoneSeconds;

let eleringUrl = "https://dashboard.elering.ee/api/nps/price";
let dateStart;
let dateEnd;
let shellyUnixtimeUTC = Shelly.getComponentStatus("sys").unixtime;

let totalHours;
let heatingTimes = [];
let data_indx;
let countWindows = heatingWindow <= 0 ? 0 : 24 / heatingWindow;
let script_number = Shelly.getCurrentScriptId();

function addLeadingZero(number) {
    return number < 10 ? "0" + JSON.stringify(number) : JSON.stringify(number);
}
function max12(month) {
    return month > 12 ? 1 : month;
}

function find_cheapest() {
    //find Shelly timezone
    let shellyLocaltime = new Date(shellyUnixtimeUTC * 1000);
    let shellyLocalHour = shellyLocaltime.getHours();
    let shellyUTCHour = shellyLocaltime.toISOString().slice(11, 13);
    let timezone = shellyLocalHour - shellyUTCHour;
    if (timezone > 12) { timezone -= 24; }
    if (timezone < -12) { timezone += 24; }
    timezoneSeconds = timezone * 60 * 60;

    // After 23:00 this script will use tomorrow's prices
    // Running this script before 23:00, today energy prices are used.
    let addDays = shellyLocalHour >= 23 ? 0 : -1;
    let secondsInDay = 60 * 60 * 24;

    print("Shelly local date and time ", shellyLocaltime);

    // proper date-time format for Elering query
    let isoTime = new Date((shellyUnixtimeUTC + timezoneSeconds + secondsInDay * addDays) * 1000).toISOString().slice(0, 10);
    let isoTimePlusDay = new Date((shellyUnixtimeUTC + timezoneSeconds + (secondsInDay * (addDays + 1))) * 1000).toISOString().slice(0, 10);
    let hourStart = JSON.stringify(24 - timezone);
    let hourEnd = JSON.stringify(24 - timezone - 1);
    dateStart = isoTime + "T" + hourStart + ":00Z";
    dateEnd = isoTimePlusDay + "T" + hourEnd + ":00Z";

    // Let's get the electricity market price from Elering
    print("Starting to fetch market prices from Elering from ", dateStart, " to ", dateEnd, ".");
    Shelly.call("HTTP.GET", { url: eleringUrl + "?start=" + dateStart + "&end=" + dateEnd }, function (result) {
        if (result === null) {
            // If there is no result, then heating windows are starting exactly at midnight 00:00
            print("Fetching market prices failed. Adding default heating windows.");
            setTimer(is_reverse, heatingTime);
            for (let i = 0; i < countWindows; i++) {
                // filling up array with the hours
                heatingTimes.push({ hour: i * heatingWindow, price: "price unknown" });
            }
        }
        else {
            // let json = "{success: true,data: {ee: [{timestamp: 1673301600,price: 80.5900},"+
            // "{timestamp: 1673305200,price: 76.0500},{timestamp: 1673308800,price: 79.9500}]}}";
            print("We got market prices from Elering, going to do the heating window logic ...");
            let json = JSON.parse(result.body);
            result = null;
            let pricesArray = json["data"][country];
            json = null;

            if (heatingWindow <= 0) {
                for (let a = 0; a < pricesArray.length; a++) {
                    if ((pricesArray[a].price < alwaysOnMaxPrice) && !(pricesArray[a].price > alwaysOffMinPrice)) {
                        heatingTimes.push({ hour: new Date((pricesArray[a].timestamp) * 1000).getHours(), price: pricesArray[a].price });
                    }
                }
            }

            let arrayWindow = [];
            // Creating array for each heating window, sorting array, and then pushing smallest prices to waterHeatingTimes[] 
            for (let i = 0; i < countWindows; i++) {
                let k = 0;
                let hoursInWindow = (i + 1) * heatingWindow > 24 ? 24 : (i + 1) * heatingWindow;
                for (let j = i * heatingWindow; j < hoursInWindow; j++) {
                    arrayWindow[k] = pricesArray[j];
                    k++;
                }
                // Sort prices from smallest to largest
                let sorted = sort(arrayWindow, "price");
                let heatingHours = sorted.length < heatingTime ? sorted.length : heatingTime;
                for (let a = 0; a < sorted.length; a++) {
                    if ((a < heatingHours || sorted[a].price < alwaysOnMaxPrice) && !(sorted[a].price > alwaysOffMinPrice)) {
                        heatingTimes.push({ hour: new Date((sorted[a].timestamp) * 1000).getHours(), price: sorted[a].price });
                    }
                }
            }
            pricesArray = null;
            sorted = null;
            arrayWindow = null;
        }
        // // The fact is that Shelly RPC calls are limited to 5, one is used already for HTTP.GET and we have only 4 left.
        // // These 4 RPC calls are used here. 
        totalHours = heatingTimes.length;
        if (totalHours > 0) {
            data_indx = (totalHours - 4) < 1 ? totalHours : 4;
            print("Starting to add hours 0-3");
            addSchedules(heatingTimes, 0, data_indx);
        }
        if (totalHours - 4 > 0) {
            Timer.set(5 * 1000, false, function () {
                data_indx = (totalHours - 9) < 1 ? totalHours : 9;
                print("Starting to add hours 4-8");
                addSchedules(heatingTimes, 4, data_indx);
            });
        }
        if (totalHours - 9 > 0) {
            Timer.set(12 * 1000, false, function () {
                data_indx = (totalHours - 14) < 1 ? totalHours : 14;
                print("Starting to add hours 9-13");
                addSchedules(heatingTimes, 9, data_indx);
            });
        }
        if (totalHours - 14 > 0) {
            Timer.set(19 * 1000, false, function () {
                data_indx = (totalHours - 19) < 1 ? totalHours : 19;
                print("Starting to add hours 14-19");
                addSchedules(heatingTimes, 14, data_indx);
            });
        }
        if (totalHours - 19 > 0) {
            Timer.set(26 * 1000, false, function () {
                data_indx = (totalHours - 24) < 1 ? totalHours : 24;
                print("Starting to add hours 19-23");
                addSchedules(heatingTimes, 19, data_indx);
            });
        }
    });
}

// Add schedulers, switching them on or off is depends on the "is_reverse" parameter
function addSchedules(sorted_prices, start_indx, data_indx) {
    for (let i = start_indx; i < data_indx; i++) {
        let price = sorted_prices[i].price;
        let hour = sorted_prices[i].hour;
        print("Scheduled start at: ", hour, " price: ", price);
        // Set the start time crontab
        let timer_start = "0 0 " + hour + " * * SUN,MON,TUE,WED,THU,FRI,SAT";
        // Creating one hour schedulers 
        Shelly.call("Schedule.Create", {
            "id": 0, "enable": true, "timespec": timer_start,
            "calls": [{
                "method": "Switch.Set",
                "params": {
                    id: 0,
                    "on": !is_reverse
                }
            }]
        }
        )
    }
    sorted_prices = null;
}

// Shelly doesnt support Javascript sort function so this basic math algorithm will do the sorting job
function sort(array, sortby) {
    // Sorting array from smallest to larger
    let i, j, k, min, max, min_indx, max_indx, tmp;
    j = array.length - 1;
    for (i = 0; i < j; i++) {
        min = max = array[i][sortby];
        min_indx = max_indx = i;
        for (k = i; k <= j; k++) {
            if (array[k][sortby] > max) {
                max = array[k][sortby];
                max_indx = k;
            }
            else if (array[k][sortby] < min) {
                min = array[k][sortby];
                min_indx = k;
            }
        }
        tmp = array[i];
        array.splice(i, 1, array[min_indx]);
        array.splice(min_indx, 1, tmp);

        if (array[min_indx][sortby] === max) {
            tmp = array[j];
            array.splice(j, 1, array[min_indx]);
            array.splice(min_indx, 1, tmp);
        }
        else {
            tmp = array[j];
            array.splice(j, 1, array[max_indx]);
            array.splice(max_indx, 1, tmp);
        }
        j--;
    }
    return array;
    // Huhh, array is finally sorted
}

// Delete all the schedulers before adding new ones
function deleteSchedulers() {
    print("Deleting all existing schedules ...");
    Shelly.call("Schedule.DeleteAll");
}

// Set countdown timer to flip the Shelly status
// Auto_on or auto_off is depends on the "is_reverse" parameter
// Delay_hour is the time period in hour. Shelly needs this in seconds.
function setTimer(is_reverse, delay_hour) {
    let is_on = is_reverse ? "on" : "off";
    print("Setting ", delay_hour, " hour auto_", is_on, "_delay.");
    Shelly.call("Switch.SetConfig", {
        "id": 0,
        config: {
            "name": "Switch0",
            "auto_on": is_reverse,
            "auto_on_delay": delay_hour * 60 * 60,
            "auto_off": !is_reverse,
            "auto_off_delay": delay_hour * 60 * 60
        }
    }
    )
}

function scheduleScript() {
    let minrand = JSON.stringify(Math.floor(Math.random() * 15));
    let secrand = JSON.stringify(Math.floor(Math.random() * 59));
    let script_schedule = secrand + " " + minrand + " " + "23 * * SUN,MON,TUE,WED,THU,FRI,SAT";
    print("Creating schedule for this script with the following CRON", script_schedule);
    Shelly.call("Schedule.create", {
        "id": 3, "enable": true, "timespec": script_schedule,
        "calls": [{
            "method": "Script.start",
            "params": {
                "id": script_number
            }
        }]
    })
}

function stopScript() {
    // Stop this script in 1.5 minute from now
    Timer.set(100 * 1000, false, function () {
        print("Stopping the script ...");
        Shelly.call("Script.stop", { "id": script_number });
    });
}

deleteSchedulers();
find_cheapest();
setTimer(is_reverse, 1);
scheduleScript();
stopScript();