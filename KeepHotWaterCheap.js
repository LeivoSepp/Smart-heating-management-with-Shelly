// This script divides day to heating windows, finds cheapest hour from each window, and turns on your (water)heating for that time.

// It's scheduled to run daily after 23:00 to set heating windows for next day.
// by Leivo Sepp, 31.01.2023
// Energy Market price is downloaded from Elering API https://dashboard.elering.ee/assets/api-doc.html#/nps-controller/getPriceUsingGET. 

// Set the country Estonia-ee, Finland-fi, Lthuania-lt, Latvia-lv
// No other countries support exist trough Elering API. 
let country = "ee";

// This parameter used to set heating window hours. In normal cases I would recommend to set it between 4 to 8, bat can be 1-24 (24 is useless).
// If this number is 6, then heating windows are 00-05, 06-11, 12-17, 18-23. Inside of each heating window the script finds chepest prices depends on the next heatingTime parameter.
let heatingWindow = 6;

// This parameter used to set a number of heating hours in a heating window. In normal cases it should 1 or 2 hours, but can be also bigger number.
// For example if this number is set to 1 then Shelly will be turned on for 1 hour for each heating window. 
let heatingTime = 1;

// Keep this is_reverse value "false", I think 99% of the situations are required so.
// Rarely some heating systems requires reversed relay. Put this "true" if you are sure that your appliance requires so.
// For example my personal ground source heat pump requires reversed management. If Shelly relay is activated (ON), then the pump is turned off.
let is_reverse = false;

// This is timezone for EE, LT, LV and FI.
// Do not change this because it won't work currently for other timezones.
let timezone = 2;

// some global variables
let eleringUrl = "https://dashboard.elering.ee/api/nps/price";
let sorted = [];
let dateStart;
let dateEnd;
let shellyUnixtime = Shelly.getComponentStatus("sys").unixtime;
let totalHours;
let waterHeatingTimes = [];
let data_indx;
let countWindows = 24 / heatingWindow;

let year;
let month;
let date;

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
function find_cheapest() {
    let addDays = -1; //yesterday, used in case the scipt started before 3PM and we don't have tomorrow prices
    let shellyHour = JSON.parse(unixTimeToHumanReadable(shellyUnixtime, timezone, addDays).slice(11, 13));
    // Only after 3PM this script can calculate schedule for tomorrow as the energy prices are not available before 3PM
    if (shellyHour >= 15) {
        addDays = 0
    }
    let shellyTime = unixTimeToHumanReadable(shellyUnixtime, timezone, addDays);
    let shellyTimePlus1 = unixTimeToHumanReadable(shellyUnixtime, timezone, addDays + 1);

    let dateTime = unixTimeToHumanReadable(shellyUnixtime, timezone, 0);
    year = JSON.parse(dateTime.slice(0, 4));
    month = JSON.parse(dateTime.slice(5, 7));
    date = JSON.parse(dateTime.slice(8, 10));

    // Let's prepare proper date-time formats for Elering query
    dateStart = shellyTime.slice(0, 10) + "T22:00Z";
    dateEnd = shellyTimePlus1.slice(0, 10) + "T21:00Z";

    // Let's get the electricity market price from Elering
    print("Starting to fetch market prices from Elering from ", dateStart, " to ", dateEnd, ".");
    Shelly.call("HTTP.GET", { url: eleringUrl + "?start=" + dateStart + "&end=" + dateEnd }, function (result) {
        if (result === null) {
            // If there is no result, then use the default_start_time and heatingTime
            print("Fetching market prices failed. Adding default timeslots.");
            setTimer(is_reverse, heatingTime);
            for (let i = 0; i < countWindows; i++) {
                let unixtime = dateTimeToUnixTime(year, month, date, (i * heatingWindow) - 2, 0);
                // filling up array with the unixtimestamps
                waterHeatingTimes.push({ timestamp: unixtime });
            }
        }
        else {
            // Let's hope we got good JSON result and we can proceed normally
            // Example of good json
            // let json = "{success: true,data: {ee: [{timestamp: 1673301600,price: 80.5900},"+
            // "{timestamp: 1673305200,price: 76.0500},{timestamp: 1673308800,price: 79.9500}]}}";   
            print("We got market prices, going to sort them from cheapest to most expensive ...");
            let json = JSON.parse(result.body);
            let pricesArray = json["data"][country];

            let arrayWindow = [];
            // Creating array for each window, sorting, and pushing smallest prices to waterHeatingTimes[] 
            for (let i = 0; i < countWindows; i++) {
                let k = 0;
                let hoursInWindow = (i + 1) * heatingWindow > 24 ? 24 : (i + 1) * heatingWindow;
                for (let j = i * heatingWindow; j < hoursInWindow; j++) {
                    arrayWindow[k] = pricesArray[j];
                    k++;
                }
                // Sort prices from smallest to largest
                sorted = sort(arrayWindow, "price");
                let heatingHours = sorted.length < heatingTime ? sorted.length : heatingTime;
                for (let x = 0; x < heatingHours; x++) {
                    waterHeatingTimes[(i * heatingTime) + x] = sorted[x];
                }
            }
        }
        // // The fact is that Shelly RPC calls are limited to 5, one is used already for HTTP.GET and we have only 4 left.
        // // These 4 RPC calls are used here. 
        totalHours = waterHeatingTimes.length;
        data_indx = (totalHours - 4) < 1 ? totalHours : 4;
        print("Starting to add hours 0-3");
        addSchedules(waterHeatingTimes, 0, data_indx);

        // // This is the hack with the timers to add more RPC calls. We simply add a 4 second delay between the timer actions :) 
        // // Timers are called four times and each timer has four RPC calls to set up alltogether maximum 20 schedules.
        // // The Timers in Shelly script are limited also to 5, as one is used to stop the script itself we can call maximum 4 timers.
        // // For some reason I couldn't make this code smarter as calling timers seems not working from for-loop which would be the normal solution.
        if (totalHours - 4 > 0) {
            Timer.set(5 * 1000, false, function () {
                data_indx = (totalHours - 9) < 1 ? totalHours : 9;
                print("Starting to add hours 4-8");
                addSchedules(waterHeatingTimes, 4, data_indx);
            });
        }
        if (totalHours - 9 > 0) {
            Timer.set(10 * 1000, false, function () {
                data_indx = (totalHours - 14) < 1 ? totalHours : 14;
                print("Starting to add hours 9-13");
                addSchedules(waterHeatingTimes, 9, data_indx);
            });
        }
        if (totalHours - 14 > 0) {
            Timer.set(15 * 1000, false, function () {
                data_indx = (totalHours - 19) < 1 ? totalHours : 19;
                print("Starting to add hours 14-19");
                addSchedules(waterHeatingTimes, 14, data_indx);
            });
        }
        if (totalHours - 19 > 0) {
            Timer.set(20 * 1000, false, function () {
                data_indx = (totalHours - 24) < 1 ? totalHours : 24;
                print("Starting to add hours 19-23");
                addSchedules(waterHeatingTimes, 19, data_indx);
            });
        }
    });
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
            price = "no price.";
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

function dateTimeToUnixTime(year, month, day, hh, mm) {
    let month_yday = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    let year_adj = year + 4800;  /* Ensure positive year, multiple of 400. */
    let febs = year_adj - (month <= 2 ? 1 : 0);  /* Februaries since base. */
    let leap_days = 1 + Math.floor(febs / 4) - Math.floor(febs / 100) + Math.floor(febs / 400);
    let days = 365 * year_adj + leap_days + month_yday[month - 1] + day - 1;
    return (days - 2472692) * 86400 + hh * 3600 + mm * 60;  /* Adjust to Unix epoch. */
}

// Shelly doesn't support any date-time management.
// With this very basic math we can convert unix time to Human readable format
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
                if (extraDays - daysOfMonth[index] <= 0) {
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
            if (extraDays - daysOfMonth[index] <= 0) {
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
    let monthStr = month < 10 ? "0" + JSON.stringify(month) : JSON.stringify(month);
    let dateStr = date < 10 ? "0" + JSON.stringify(date) : JSON.stringify(date);
    let hoursStr = hours < 10 ? "0" + JSON.stringify(hours) : JSON.stringify(hours);
    let minutesStr = minutes < 10 ? "0" + JSON.stringify(minutes) : JSON.stringify(minutes);
    let secondsStr = secondss < 10 ? "0" + JSON.stringify(secondss) : JSON.stringify(secondss);

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

// Set automatic one hour countdown timer to flip the Shelly status
// Auto_on or auto_off is depends on the "is_reverse" parameter
// Delay_hour is the time period in hour. Shelly will translate this to seconds.
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
