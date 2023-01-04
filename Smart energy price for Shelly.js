// This script will turn on Shelly for number of cheapest hours during a day.
// It's scheduled to run daily after 23:00 to set proper timeslots for next day.
// by Leivo Sepp, 03.01.2023
// Original app made by https://elspotcontrol.netlify.app/

// Origin of energy prices https://transparency.entsoe.eu/transmission-domain/r2/dayAheadPrices/show 
// Simplified energy prices used by this script https://elspotcontrol.netlify.app/spotprices-v01-EE.json 

// To use tomorrow prices, put this parameter 1. To use today prices, put this parameter to 0.
// Do not change this as you will get unexpected results.
let period_day = 1;

// How many cheap hours you need during a day? Number 1-20. 
// For example if this number is set to 5 then Shelly will be turned on for 5 most cheapest hours during a day. 
// If the cheapest hours are 02:00, 04:00, 07:00, 15:00 and 16:00, then the Shelly is turned on 02-03, 04-05, 07-08 and 15-17 (two hours in a row).
let needed_length = 10;

// Some heating systems requires reversed relay. Put it true if the heating management requires so.
// My personal heating system is requires the reversed management.
let is_reverse = true;

// If fetching prices fails, use this time as a start time, 2 means 02:00. 
// if needed_length is 5, then the Shelly is turned on from 02:00 to 07:00
let default_start_time = 1;

// Crontab for running this script. 
// This script is run at random moment during the first 15 minutes after 23:00
// Random timing is used so that all clients wouldn't be polling the server exactly at same time
let minrand = JSON.stringify(Math.floor(Math.random() * 15));
let secrand = JSON.stringify(Math.floor(Math.random() * 59));
let script_schedule = secrand + " " + minrand + " " + "23 * * SUN,MON,TUE,WED,THU,FRI,SAT";
print("This is the script cron ", script_schedule);

// Number for this script. If this doesn't work (as in earlier versions), get it from this url (use your own ip) http://192.168.33.1/rpc/Script.List
let script_number = Shelly.getCurrentScriptId();
// You can check the schedules here (use your own ip) http://192.168.33.1/rpc/Schedule.List

// Inside of Timer function only global variables can be used.
let sorted_prices = [];
let data_indx;

function find_cheapest(result) {
    if (result === null) {
        // If there is no result, then use the default_start_time and needed_length
        print("Fetching market prices failed. Adding one big timeslot.");
        setTimer(is_reverse, needed_length);
        addSchedules(default_start_time, default_start_time + 1);
    }
    else {
        // Let's hope we got good JSON result and we can proceed normally
        print("We got market prices, going to sort them from cheapest to most expensive ...");

        let prices = JSON.parse(result.body);
        let hourly_prices = prices["hourly_prices"];

        // Creating an array depending on parameter "period_day" (today or tomorrow)
        for (let period in hourly_prices) {
            if (period.slice(0, 1) === JSON.stringify(period_day)) {
                sorted_prices.push([period, hourly_prices[period]]);
            }
        }

        // Sorting array from cheapest to most expensive
        let i, j, k, min, max, min_indx, max_indx, tmp;
        j = sorted_prices.length - 1;
        for (i = 0; i < j; i++) {
            min = max = sorted_prices[i][1].price;
            min_indx = max_indx = i;
            for (k = i; k <= j; k++) {
                if (sorted_prices[k][1].price > max) {
                    max = sorted_prices[k][1].price;
                    max_indx = k;
                }
                else if (sorted_prices[k][1].price < min) {
                    min = sorted_prices[k][1].price;
                    min_indx = k;
                }
            }
            tmp = sorted_prices[i];
            sorted_prices.splice(i, 1, sorted_prices[min_indx]);
            sorted_prices.splice(min_indx, 1, tmp);

            if (sorted_prices[min_indx][1].price === max) {
                tmp = sorted_prices[j];
                sorted_prices.splice(j, 1, sorted_prices[min_indx]);
                sorted_prices.splice(min_indx, 1, tmp);
            }
            else {
                tmp = sorted_prices[j];
                sorted_prices.splice(j, 1, sorted_prices[max_indx]);
                sorted_prices.splice(max_indx, 1, tmp);

            }
            j--;
        }
        // Huhh, array is finally sorted

        print("Cheapest daily price:", sorted_prices[0][1].price, " ", sorted_prices[0][1].time);
        print("Most expensive daily price", sorted_prices[sorted_prices.length - 1][1].price, " ", sorted_prices[sorted_prices.length - 1][1].time);

        // This one looks weird. The fact is that Shelly RPC calls are limited to 5, one is used already for HTTP.GET, so only 4 is left.
        // We will use timer to add more than 4 slots. We need 2 second delays between each 4 item Timer set. 
        print("Starting to add hours 0-3");
        if (needed_length - 4 < 1) { data_indx = needed_length; }
        else { data_indx = 4; }
        addSchedules(0, data_indx);

        if (needed_length - 5 >= 0) {
            print("Starting to add hours 4-7");
            Timer.set(2 * 1000, false, function () {
                if (needed_length - 8 < 1) { data_indx = needed_length; }
                else { data_indx = 8; }
                addSchedules(4, data_indx);
            });
        }
        if (needed_length - 9 >= 0) {
            print("Starting to add hours 8-11");
            Timer.set(4 * 1000, false, function () {
                if (needed_length - 12 < 1) { data_indx = needed_length; }
                else { data_indx = 12; }
                addSchedules(8, data_indx);
            });
        }
        if (needed_length - 13 >= 0) {
            print("Starting to add hours 12-15");
            Timer.set(6 * 1000, false, function () {
                if (needed_length - 16 < 1) { data_indx = needed_length; }
                else { data_indx = 16; }
                addSchedules(12, data_indx);
            });
        }
        if (needed_length - 17 >= 0) {
            print("Starting to add hours 16-19");
            Timer.set(8 * 1000, false, function () {
                if (needed_length - 20 < 1) { data_indx = needed_length; }
                else { data_indx = 20; }
                addSchedules(16, data_indx);
            });
        }
    }
}

// Delete all the schedulers before adding new ones
function deleteSchedulers() {
    print("Deleting all existing schedules ...");
    Shelly.call("Schedule.DeleteAll");
}

// Set automatic one hour countdown timer to flip the Shelly status
// Auto_on or auto_off is depends on the "is_reverse" parameter
// Delay_hour is the time period in hour. Shelly will translate this to seconds.
function setTimer(is_reverse, delay_hour) {
    let is_on;
    if (is_reverse) { is_on = "on" }
    else { is_on = "off" }
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

// Add schedulers, switching all of them on or off is depends on the "is_reverse" parameter
function addSchedules(start_indx, data_indx) {
    for (let i = start_indx; i < data_indx; i++) {
        let hour, price;
        if (sorted_prices.length > 0) {
            hour = sorted_prices[i][1].time.slice(11, 13);
            price = sorted_prices[i][1].price;
        }
        else {
            hour = JSON.stringify(start_indx);
            price = "N/A";
        }

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
}

function scheduleScript() {
    print("Creating schedule for this script ...");
    Shelly.call("Schedule.create", {
        "id": 3, "enable": true, "timespec": script_schedule,
        "calls": [{
            "method": "Script.start",
            "params": {
                "id": script_number
            }
        }]
    })

    // Stop this script in one minute from now
    Timer.set(60 * 1000, false, function () {
        print("Stopping the script ...");
        Shelly.call("Script.stop", { "id": script_number });
    });
}

function setSchedulers() {
    print("Starting to fetch market prices ...");
    Shelly.call("HTTP.GET", { url: "https://elspotcontrol.netlify.app/spotprices-v01-EE.json" }, find_cheapest);
}

setTimer(is_reverse, 1);
deleteSchedulers();
setSchedulers();
scheduleScript();