// This script will turn on Shelly for number of cheapest hours during a day.
// It's scheduled to run daily after 23:00 to set proper timeslots for next day.
// by Leivo Sepp, 10.01.2023
// Energy Market price is downloaded from Elering API https://dashboard.elering.ee/assets/api-doc.html#/nps-controller/getPriceUsingGET. 

// Set the country Estonia-ee, Finland-fi, Lthuania-lt, Latvia-lv
let country = "ee";

// How many cheap hours you need during a day? Number 1-20. 
// For example if this number is set to 5 then Shelly will be turned on for 5 most cheapest hours during a day. 
// If the cheapest hours are 02:00, 04:00, 07:00, 15:00 and 16:00, then the Shelly is turned on 02-03, 04-05, 07-08 and 15-17 (two hours in a row).
let needed_hours = 10;

// If fetching prices fails, use this time as a start time, 2 means 02:00. 
// if needed_hours is 5, then the Shelly is turned on from 02:00 to 07:00
let default_start_time = 1;

// Keep this value "false", I think 99% of the situations are required so.
// Some heating systems requires reversed relay. Put this "true" if you are sure that your appliance requires so.
// For example my personal ground source heat pump requires reversed management. If Shelly relay is activated (ON), then the pump is turned off.
let is_reverse = false;

// This is timezone for EE, LT, LV and FI.
// Do not change this as this as other timezones are not tested and doesn't work properly.
let timezone = 2;

// Timer function can take in only global variables.
let data_indx;
let sorted = [];

// Crontab for running this script. 
// This script is run at random moment during the first 15 minutes after 23:00
// Random timing is used so that all clients wouldn't be polling the server exactly at same time
let minrand = JSON.stringify(Math.floor(Math.random() * 15));
let secrand = JSON.stringify(Math.floor(Math.random() * 59));
let script_schedule = secrand + " " + minrand + " " + "23 * * SUN,MON,TUE,WED,THU,FRI,SAT";

// Number for this script. If this doesn't work (as in earlier versions), get it from this url (use your own ip) http://192.168.33.1/rpc/Script.List
// You can check the schedules here (use your own ip) http://192.168.33.1/rpc/Schedule.List
let script_number = Shelly.getCurrentScriptId();

// This is the main function to proceed with the price sorting etc.
function find_cheapest(result) {
    if (result === null) {
        // If there is no result, then use the default_start_time and needed_hours
        print("Fetching market prices failed. Adding one big timeslot.");
        setTimer(is_reverse, needed_hours);
        addSchedules(sorted, default_start_time, default_start_time + 1);
    }
    else {
        // Let's hope we got good JSON result and we can proceed normally
        // Example of good json
        // let json = "{success: true,data: {ee: [{timestamp: 1673301600,price: 80.5900},"+
        // "{timestamp: 1673305200,price: 76.0500},{timestamp: 1673308800,price: 79.9500}]}}";   
        print("We got market prices, going to sort them from cheapest to most expensive ...");

        let json = JSON.parse(result.body);
        let pricesArray = json["data"][country];

        sorted = sort(pricesArray, "price");

        print("Cheapest daily price:", sorted[0].price, " ", unixTimeToHumanReadable(sorted[0].timestamp, 2, 0));
        print("Most expensive daily price", sorted[sorted.length - 1].price, " ", unixTimeToHumanReadable(sorted[sorted.length - 1].timestamp, 2, 0));

        // The fact is that Shelly RPC calls are limited to 5, one is used already for HTTP.GET and we have only 4 left.
        // These 4 RPC calls are used here. 
        if (needed_hours - 4 < 1) { data_indx = needed_hours; }
        else { data_indx = 4; }
        print("Starting to add hours 0-3");
        addSchedules(sorted, 0, data_indx);

        // This is the hack with the timers to add more RPC calls. We simply add a 4 second delay between the timer actions :) 
        // Timers are called four times and each timer has four RPC calls to set up alltogether maximum 20 schedules.
        // The Timers in Shelly script are limited also to 5, as one is used to stop the script itself we can call maximum 4 timers.
        // For some reason I couldn't make this code smarter as calling timers seems not working from for-loop which would be the normal solution.
        if (needed_hours - 4 > 0) {
            Timer.set(4 * 1000, false, function () {
                print("Starting to add hours 4-7");
                if (needed_hours - 8 < 1) { data_indx = needed_hours; }
                else { data_indx = 8; }
                addSchedules(sorted, 4, data_indx);
            });
        }
        if (needed_hours - 8 > 0) {
            Timer.set(8 * 1000, false, function () {
                print("Starting to add hours 8-11");
                if (needed_hours - 12 < 1) { data_indx = needed_hours; }
                else { data_indx = 12; }
                addSchedules(sorted, 8, data_indx);
            });
        }
        if (needed_hours - 12 > 0) {
            Timer.set(12 * 1000, false, function () {
                print("Starting to add hours 12-15");
                if (needed_hours - 16 < 1) { data_indx = needed_hours; }
                else { data_indx = 16; }
                addSchedules(sorted, 12, data_indx);
            });
        }
        if (needed_hours - 16 > 0) {
            Timer.set(16 * 1000, false, function () {
                print("Starting to add hours 16-19");
                if (needed_hours - 20 < 1) { data_indx = needed_hours; }
                else { data_indx = 20; }
                addSchedules(sorted, 16, data_indx);
            });
        }
    }
}

// Add schedulers, switching them on or off is depends on the "is_reverse" parameter
function addSchedules(sorted_prices, start_indx, data_indx) {
    for (let i = start_indx; i < data_indx; i++) {
        let hour, price;
        if (sorted_prices.length > 0) {
            hour = unixTimeToHumanReadable(sorted_prices[i].timestamp, 2, 0).slice(11, 13);
            price = sorted_prices[i].price;
        }
        else {
            hour = JSON.stringify(start_indx);
            price = "N/A";
        }
        print("Scheduled start at: ", hour, " price: ", price);
        // Remove leading zeros from hour
        if (hour.slice(0, 1) === "0") { hour = hour.slice(1, 2); }
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

// Shelly doesn't support any date-time management.
// We need to use very basic math to write a function to convert unix time to Human readable format
function unixTimeToHumanReadable(seconds, timezone, addDay) {
    //add timezone
    seconds += 60 * 60 * timezone;
    //add days
    seconds += 60 * 60 * 24 * addDay;

    // Save the time in Human readable format
    let ans = "";

    // Number of days in month in normal year
    let daysOfMonth = [31, 28, 31, 30, 31, 30,
        31, 31, 30, 31, 30, 31];

    let currYear, daysTillNow, extraTime,
        extraDays, index, date, month, hours,
        minutes, secondss, flag = 0;

    // Calculate total days unix time T
    daysTillNow = Math.floor(seconds / (24 * 60 * 60));
    extraTime = seconds % (24 * 60 * 60);
    currYear = 1970;

    // Calculating current year
    while (true) {
        if (currYear % 400 === 0
            || (currYear % 4 === 0 && currYear % 100 !== 0)) {
            if (daysTillNow < 366) {
                break;
            }
            daysTillNow -= 366;
        }
        else {
            if (daysTillNow < 365) {
                break;
            }
            daysTillNow -= 365;
        }
        currYear += 1;
    }

    // Updating extradays because it will give days till previous day and we have include current day
    extraDays = daysTillNow + 1;

    if (currYear % 400 === 0 ||
        (currYear % 4 === 0 &&
            currYear % 100 !== 0))
        flag = 1;

    // Calculating MONTH and DATE
    month = 0; index = 0;
    if (flag === 1) {
        while (true) {
            if (index === 1) {
                if (extraDays - 29 < 0)
                    break;

                month += 1;
                extraDays -= 29;
            }
            else {
                if (extraDays -
                    daysOfMonth[index] < 0) {
                    break;
                }
                month += 1;
                extraDays -= daysOfMonth[index];
            }
            index += 1;
        }
    }
    else {
        while (true) {
            if (extraDays - daysOfMonth[index] < 0) {
                break;
            }
            month += 1;
            extraDays -= daysOfMonth[index];
            index += 1;
        }
    }

    // Current Month
    if (extraDays > 0) {
        month += 1;
        date = extraDays;
    }
    else {
        if (month === 2 && flag === 1) {
            date = 29;
        }
        else {
            date = daysOfMonth[month - 1];
        }
    }

    // Calculating HH:MM:SS
    hours = Math.floor(extraTime / 3600);
    minutes = Math.floor((extraTime % 3600) / 60);
    secondss = Math.floor((extraTime % 3600) % 60);

    //add leading 0 to month, date, hour, minute, and seconds
    let monthStr, dateStr, hoursStr, minutesStr, secondsStr;
    if (month < 10) { monthStr = "0" + JSON.stringify(month); } else { monthStr = JSON.stringify(month); }
    if (date < 10) { dateStr = "0" + JSON.stringify(date); } else { dateStr = JSON.stringify(date); }
    if (hours < 10) { hoursStr = "0" + JSON.stringify(hours); } else { hoursStr = JSON.stringify(hours); }
    if (minutes < 10) { minutesStr = "0" + JSON.stringify(minutes); } else { minutesStr = JSON.stringify(minutes); }
    if (secondss < 10) { secondsStr = "0" + JSON.stringify(secondss); } else { secondsStr = JSON.stringify(secondss); }

    ans += JSON.stringify(currYear);
    ans += "-";
    ans += monthStr;
    ans += "-";
    ans += dateStr;
    ans += " ";
    ans += hoursStr;
    ans += ":";
    ans += minutesStr;
    ans += ":";
    ans += secondsStr;

    // Return the time
    return ans;
}

// Shelly doesnt support Javascript sort function so we have to write our own sorting algorithm
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

function scheduleScript() {
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
    // Stop this script in one minute from now
    Timer.set(60 * 1000, false, function () {
        print("Stopping the script ...");
        Shelly.call("Script.stop", { "id": script_number });
    });
}

function getPrices(result) {
    let shellyUnixtime = result.unixtime;
    let addDays = -1; //yesterday, used in case the scipt started before 3PM and we don't have tomorrow prices
    let shellyHour = JSON.parse(result.time.slice(0, 2));
    if (shellyHour > 15) {
        addDays = 0
    }
    let shellyTime = unixTimeToHumanReadable(shellyUnixtime, timezone, addDays);
    let shellyTimePlus1 = unixTimeToHumanReadable(shellyUnixtime, timezone, addDays + 1);

    let dateStart = shellyTime.slice(0, 10) + "T22:00Z";
    let dateEnd = shellyTimePlus1.slice(0, 10) + "T21:00Z";
    print(dateStart, "-", dateEnd);

    print("Starting to fetch market prices from Elering ...")
    Shelly.call("HTTP.GET", { url: "https://dashboard.elering.ee/api/nps/price?start=" + dateStart + "&end=" + dateEnd }, find_cheapest);
}

// Let's start to get the Shelly status
// We need this only to get the Shelly date and time
function getShellyStatus() {
    Shelly.call("Sys.GetStatus", {}, getPrices);
}

getShellyStatus();
setTimer(is_reverse, 1);
deleteSchedulers();
scheduleScript();
