// This script has three different modes: 
// 1. Using weather forecast, the scipt calculates dynamically heating time for the next day. 
// 2. Splitting day into time windows to turn on heating for cheapest hour in each window.
// 3. Using price min-max levels to keep the shelly always on or off.

// It's scheduled to run daily after 23:00 to set heating timeslots for next day.
// updated by Leivo Sepp, 03.11.2023

let country = "ee";             // Estonia-ee, Finland-fi, Lithuania-lt, Latvia-lv
let heatingWindow = 24;         // time window size (hours), (0 -> only min-max price used, 24 -> one day)
let heatingTime = 5;            // heating time in each time window (hours)
let alwaysOnMaxPrice = 1;       // shelly is always on if energy price lower than this value
let alwaysOffMinPrice = 300;    // shelly is always off if energy price higher than this value
let is_reverse = true;          // Some heating systems requires reversed relay.
let isWeatherForecastUsed = true; //use weather forecast to calculate heating time dynamically for every day

// If getting electricity prices from Elering fails, then heating starts at the beginning of heating window.
// If getting weather forecast fails, then default heating time is used

// Following parameters used to calculate heating time only in case the weather forecast is turned on
// HeatingCurve is used to set proper heating curve for your house. This is very personal and also crucial component.
// You can start with the default number 5, and take a look how this works for you.
// If you feel cold, then increase this number. If you feel too warm, then decrease this number.
// You can see the dependency of temperature and and this parameter from this visualization: 
// Parameter startingTemp is used as starting point for heating curve.
// For example if startingTemp = 10, then the heating is not turned on for any temperature warmer than 10 degrees.
// powerFactor is used to set quadratic equation parabola curve flat or steep. Change it with your own responsibility.
// Heating hours are calculated by this quadratic equation: (startingTemp-avgTemp)^2 + (heatingCurve / powerFactor) * (startingTemp-avgTemp)
let heatingCurve = 5;
let startingTemp = 10;
let powerFactor = 0.2;

// some global variables
let openMeteoUrl = "https://api.open-meteo.com/v1/forecast?daily=temperature_2m_max,temperature_2m_min&timezone=auto";
let eleringUrl = "https://dashboard.elering.ee/api/nps/price";
let timezoneSeconds;
let data_indx;
let sorted = [];
let heatingTimes = [];
let weatherDate;
let dateStart;
let dateEnd;
let totalHours;
let countWindows = heatingWindow <= 0 ? 0 : 24 / heatingWindow;
let shellyUnixtimeUTC = Shelly.getComponentStatus("sys").unixtime;
let script_number = Shelly.getCurrentScriptId();

function getShellyStatus() {
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

    // build datetime for Elering query
    let isoTime = new Date((shellyUnixtimeUTC + timezoneSeconds + secondsInDay * addDays) * 1000).toISOString().slice(0, 10);
    let isoTimePlusDay = new Date((shellyUnixtimeUTC + timezoneSeconds + (secondsInDay * (addDays + 1))) * 1000).toISOString().slice(0, 10);
    let hourStart = JSON.stringify(24 - timezone);
    let hourEnd = JSON.stringify(24 - timezone - 1);
    dateStart = isoTime + "T" + hourStart + ":00Z";
    dateEnd = isoTimePlusDay + "T" + hourEnd + ":00Z";

    print("Shelly local date and time ", shellyLocaltime);
    shellyLocaltime = null;
    shellyUnixtimeUTC = null;

    //the following is used only in case of weather forecast based heating hours
    if (isWeatherForecastUsed) {
        let lat = JSON.stringify(Shelly.getComponentConfig("sys").location.lat);
        let lon = JSON.stringify(Shelly.getComponentConfig("sys").location.lon);
        weatherDate = isoTimePlusDay;
        // calling Open-Meteo weather forecast to get tomorrow min and max temperatures
        print("Starting to fetch weather data for ", weatherDate, " from Open-Meteo.com for your location:", lat, lon, ".")
        Shelly.call("HTTP.GET", { url: openMeteoUrl + "&latitude=" + lat + "&longitude=" + lon + "&start_date=" + weatherDate + "&end_date=" + weatherDate }, function (response) {
            if (response === null || JSON.parse(response.body)["error"]) {
                print("Getting temperature failed. Using default heatingTime parameter and will turn on heating for ", heatingTime, " hours.");
            }
            else {
                let jsonForecast = JSON.parse(response.body);
                // temperature forecast, averaging tomorrow min and max temperatures 
                let avgTempForecast = (jsonForecast["daily"]["temperature_2m_max"][0] + jsonForecast["daily"]["temperature_2m_min"][0]) / 2;
                // the next line is basically the "smart quadratic equation" which calculates the hetaing hours based on the temperature
                heatingTime = ((startingTemp - avgTempForecast) * (startingTemp - avgTempForecast) + (heatingCurve / powerFactor) * (startingTemp - avgTempForecast)) / 100;
                heatingTime = Math.ceil(heatingTime);
                if (heatingTime > 24) { heatingTime = 24; }
                print("Temperture forecast for ", weatherDate, " is ", avgTempForecast, " degrees, and heating is turned on for ", heatingTime, " hours.");
                response = null;
                jsonForecast = null;
            }
            find_cheapest();
        });
    } else {
        find_cheapest();
    }
}

// This is the main function to proceed with the price sorting etc.
function find_cheapest() {
    // Let's get the electricity market price from Elering
    print("Starting to fetch market prices from Elering from ", dateStart, " to ", dateEnd, ".");
    Shelly.call("HTTP.GET", { url: eleringUrl + "?start=" + dateStart + "&end=" + dateEnd }, function (result) {
        if (result === null) {
            // If there is no result, then use the default_start_time and heatingTime
            print("Fetching market prices failed. Adding dummy timeslot.");
            setTimer(is_reverse, heatingTime);
            for (let i = 0; i < countWindows; i++) {
                // filling up array with the hours
                heatingTimes.push({ hour: i * heatingWindow, price: "price unknown" });
            }
        }
        else {
            // let json = "{success: true,data: {ee: [{timestamp: 1673301600,price: 80.5900},"+
            // "{timestamp: 1673305200,price: 76.0500},{timestamp: 1673308800,price: 79.9500}]}}";   
            print("We got market prices, going to sort them from cheapest to most expensive.");
            let jsonElering = JSON.parse(result.body);
            result = null; 
            let pricesArray = jsonElering["data"][country];
            jsonElering = null;

            //if heating is based only on the alwaysOnMaxPrice and alwaysOffMinPrice
            if (heatingWindow <= 0) {
                for (let a = 0; a < pricesArray.length; a++) {
                    if ((pricesArray[a].price < alwaysOnMaxPrice) && !(pricesArray[a].price > alwaysOffMinPrice)) {
                        heatingTimes.push({ hour: new Date((pricesArray[a].timestamp) * 1000).getHours(), price: pricesArray[a].price });
                    }
                }
            }

            //if time windows are used
            let arrayWindow = [];
            // Create an array for each heating window, sort, and push the smallest prices to waterHeatingTimes[] 
            for (let i = 0; i < countWindows; i++) {
                let k = 0;
                let hoursInWindow = (i + 1) * heatingWindow > 24 ? 24 : (i + 1) * heatingWindow;
                for (let j = i * heatingWindow; j < hoursInWindow; j++) {
                    arrayWindow[k] = pricesArray[j];
                    k++;
                }
                let sorted = sort(arrayWindow, "price");
                let heatingHours = sorted.length < heatingTime ? sorted.length : heatingTime;

                print("For the time period: ", (i * heatingWindow) + "-" + ((i * heatingWindow) + hoursInWindow), ", cheapest price is", sorted[0].price, " at ", new Date((sorted[0].timestamp + timezoneSeconds) * 1000), ".");

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

        // The fact is that Shelly RPC calls are limited to 5.
        // Kinda timer-hack is used to execute RPC calls 24 times 
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

// Add actual schedulers
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
        })
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
function setTimer(is_reverse, timerHour) {
    let is_on = is_reverse ? "on" : "off";
    let timerSec = timerHour * 60 * 60;
    print("Set auto " + is_on + " timer for ", timerSec, " seconds.");
    Shelly.call("Switch.SetConfig", {
        "id": 0,
        config: {
            "name": "Switch0",
            "auto_on": is_reverse,
            "auto_on_delay": timerSec,
            "auto_off": !is_reverse,
            "auto_off_delay": timerSec
        }
    })
}

function scheduleScript() {
    // This script is run at random moment during the first 15 minutes after 23:00
    let minrand = Math.floor(Math.random() * 15);
    let secrand = Math.floor(Math.random() * 59);
    let script_schedule = secrand + " " + minrand + " " + "23 * * SUN,MON,TUE,WED,THU,FRI,SAT";
    print("Schedule this script to run daily at 23:", addLeadingZero(minrand) + ":" + addLeadingZero(secrand) + ".");
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

function addLeadingZero(number) {
    return number < 10 ? "0" + JSON.stringify(number) : JSON.stringify(number);
}

function stopScript() {
    // Stop this script in 1.5 minute from now
    Timer.set(100 * 1000, false, function () {
        print("Stopping the script ...");
        Shelly.call("Script.stop", { "id": script_number });
        print("Script stopped.");
    });
}

deleteSchedulers();
getShellyStatus();
setTimer(is_reverse, 1);
scheduleScript();
stopScript();
