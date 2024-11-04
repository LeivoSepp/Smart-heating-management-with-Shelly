/*
This Shelly script is designed to retrieve energy market prices from Elering and
activate heating during the most cost-effective hours each day, employing various algorithms. 

1. Dynamic calculation of heating time for the next day based on weather forecasts.
2. Division of heating into time periods, with activation during the cheapest hour within each period.
3. Utilization of min-max price levels to maintain the Shelly system consistently on or off.
The script executes daily after 23:00 to establish heating timeslots for the following day.

created by Leivo Sepp, 25.12.2023
https://github.com/LeivoSepp/Smart-heating-management-with-Shelly
*/

/* Elektrilevi electricity transmission fees (EUR/MWh): */
let VORK1 = { dayRt: 72, nightRt: 72 };
let VORK2 = { dayRt: 87, nightRt: 50 };
let VORK2KUU = { dayRt: 56, nightRt: 33 };
let VORK4 = { dayRt: 37, nightRt: 21 };
let NONE = { dayRt: 0, nightRt: 0 };

// timePeriod: duration of each time period in hours, (0 -> only min-max price used, 24 -> period is one day).
// heatingTime: duration of heating in hours during each designated period.
// isFcstUsed: true/false - Using weather forecast to calculate heating duration.

/****** HEATING MODES, YOU CAN MODIFY OR CREATE YOUR OWN ******/
/* Heating schedulers with forecast */
let HEAT24H_FCST = { timePeriod: 24, heatingTime: 0, isFcstUsed: true };
let HEAT12H_FCST = { timePeriod: 12, heatingTime: 0, isFcstUsed: true };
let HEAT6H_FCST = { timePeriod: 6, heatingTime: 0, isFcstUsed: true };
/* 24h heating schedulers */
let HEAT24H_20H = { timePeriod: 24, heatingTime: 20, isFcstUsed: false };
let HEAT24H_12H = { timePeriod: 24, heatingTime: 12, isFcstUsed: false };
let HEAT24H_10H = { timePeriod: 24, heatingTime: 10, isFcstUsed: false };
let HEAT24H_8H = { timePeriod: 24, heatingTime: 8, isFcstUsed: false };
/* 12h heating schedulers */
let HEAT12H_6H = { timePeriod: 12, heatingTime: 6, isFcstUsed: false };
let HEAT12H_4H = { timePeriod: 12, heatingTime: 4, isFcstUsed: false };
let HEAT12H_2H = { timePeriod: 12, heatingTime: 2, isFcstUsed: false };
let HEAT12H_1H = { timePeriod: 12, heatingTime: 1, isFcstUsed: false };
/* 6h heating schedulers */
let HEAT6H_2H = { timePeriod: 6, heatingTime: 2, isFcstUsed: false };
let HEAT6H_1H = { timePeriod: 6, heatingTime: 1, isFcstUsed: false };
/* 4h heating schedulers */
let HEAT4H_2H = { timePeriod: 4, heatingTime: 2, isFcstUsed: false };
let HEAT4H_1H = { timePeriod: 4, heatingTime: 1, isFcstUsed: false };
/* Use only low price component */
let HEAT_LOWPRICE = { timePeriod: 0, heatingTime: 0, isFcstUsed: false };


/****** USER SETTINGS, START MODIFICATION ******/
let s = {
    heatingMode: HEAT24H_FCST,  // HEATING MODE. Different heating modes described above.
    elektrilevi: VORK2KUU,      // ELEKTRILEVI transmission fee: VORK1 / VORK2 / VORK2KUU / VORK4 / NONE
    alwaysOnLowPrice: 10,       // Keep heating always ON if energy price lower than this value (EUR/MWh)
    alwaysOffHighPrice: 300,    // Keep heating always OFF if energy price higher than this value (EUR/MWh)
    isOutputInverted: true,    // Configures the relay state to either normal or inverted. (inverted required by Nibe, Thermia)
    relayID: 0,                 // Shelly relay ID
    defaultTimer: 60,           // Default timer duration, in minutes, for toggling the Shelly state.
    country: "ee",              // Estonia-ee, Finland-fi, Lithuania-lt, Latvia-lv
    heatingCurve: 0,            // Shifting heating curve to the left or right, check the tables below. Shift by 1 equals 1h. 
    powerFactor: 0.5,           // Adjusts the heating curve to be either more flat or more aggressive (0 -> flat, 1 -> steep).
}
/****** USER SETTINGS, END OF MODIFICATION ******/

/*
Heating time dependency on heating curve and outside temperature for 24h and 12h (power factor 0.5).

    |   ------   24h heating curve   ------   |  
°C  |-10  -8  -6  -4  -2  0   2   4   6   8   10
_________________________________________________
17  | 0   0   0   0   0   0   0   0   0   0   0
15  | 0   0   0   0   0   0   0   2   4   6   8
10  | 0   0   0   0   0   1   3   5   7   9   11
5   | 0   0   0   0   1   3   5   7   9   11  13
0   | 0   0   0   2   4   6   8   10  12  14  16
-5  | 0   0   2   4   6   8   10  12  14  16  18
-10 | 1   3   5   7   9   11  13  15  17  19  21
-15 | 3   5   7   9   11  13  15  17  19  21  23
-20 | 6   8   10  12  14  16  18  20  22  24  24
-25 | 8   10  12  14  16  18  20  22  24  24  24

    |   -------   12h heating curve   -------   |
°C  |-10  -8  -6  -4  -2  0   2   4   6   8   10
_________________________________________________
17  | 0   0   0   0   0   0   0   0   0   0   0
15  | 0   0   0   0   0   0   0   1   2   3   4
10  | 0   0   0   0   0   1   2   3   4   5   6
5   | 0   0   0   0   1   2   3   4   5   6   7
0   | 0   0   0   1   2   3   4   5   6   7   8
-5  | 0   0   1   2   3   4   5   6   7   8   9
-10 | 1   2   3   4   5   6   7   8   9   10  11
-15 | 2   3   4   5   6   7   8   9   10  11  12
-20 | 3   4   5   6   7   8   9   10  11  12  12
-25 | 4   5   6   7   8   9   10  11  12  12  12

Forecast temp °C is "feels like": more information here: https://en.wikipedia.org/wiki/Apparent_temperature
*/


let _ = {
    openMeteo: "https://api.open-meteo.com/v1/forecast?hourly=apparent_temperature&timezone=auto&forecast_days=1&forecast_hours=" + s.heatingMode.timePeriod,
    elering: "https://dashboard.elering.ee/api/nps/price/csv?fields=" + s.country,
    elUrl: '',
    omUrl: '',
    heatTime: '',
    ctPeriods: s.heatingMode.timePeriod <= 0 ? 0 : Math.ceil((24 * 100) / (s.heatingMode.timePeriod * 100)), //period count is up-rounded
    tsPrices: '',
    tsFcst: '',
    loopFreq: 60, //seconds
    loopRunning: false,
    dayInSec: 60 * 60 * 24,
    sId: Shelly.getCurrentScriptId(),
    pId: "Id" + Shelly.getCurrentScriptId() + ": ",
    rpcCl: 3,
    cntr: 0,
    schedId: [],
    version: 2.7,
};

/*
This is the start of the script.
Set the script to start automatically.
Set the default script library
Get old scheduler IDs from the KVS storage
*/
function start() {
    setAutoStart();
    setKvsScrLibr();

    Shelly.call('KVS.Get', { key: "schedulerIDs" + _.sId }, function (res, err, msg, data) {
        let si = [];
        if (res) {
            si = JSON.parse(res.value);
            res = null; //to save memory
        }
        delSc(si);
    });
}
/* set the script to sart automatically on boot */
function setAutoStart() {
    if (!Shelly.getComponentConfig("script", _.sId).enable) {
        Shelly.call('Script.SetConfig', { id: _.sId, config: { enable: true } },
            function (res, err, msg, data) {
                if (err != 0) {
                    print("Heating script autostart is not enabled.", msg, ". After Shelly restart, this script will not start and new heating schedules are not created.");
                }
            });
    }
}
/* set the default script library */
function setKvsScrLibr() {
    Shelly.call("KVS.set", { key: "scripts-library", value: '{"url": "https://raw.githubusercontent.com/LeivoSepp/Smart-heating-management-with-Shelly/master/manifest.json"}' });
}

/*
Before anything else delete all the old schedulers created by this script. 
*/
function delSc(s) {
    //logic below is a non-blocking method for RPC calls to delete all schedulers one by one
    if (_.cntr < 6 - _.rpcCl) {
        for (let i = 0; i < _.rpcCl && i < s.length; i++) {
            let id = s.splice(0, 1)[0];
            _.cntr++;
            Shelly.call("Schedule.Delete", { id: id },
                function (res, err, msg, data) {
                    if (err !== 0) {
                        print(_.pId, "Schedule ", data.id, " delete FAILED.");
                    }
                    else {
                        print(_.pId, "Schedule ", data.id, " delete SUCCEEDED.");
                    }
                    _.cntr--;
                },
                { id: id }
            );
        }
    }
    //if there are more calls in the queue
    if (s.length > 0) {
        Timer.set(
            1000, //the delay
            false,
            function () {
                delSc(s);
            });
    }
    else {
        main(); //start the main logic
    }
}

/**
This is the main script where all the logic starts.
This one is called after all the old schedulers are deleted.
*/
function main() {
    //wait until all the schedulers are deleted
    if (_.cntr !== 0) {
        Timer.set(
            1000,
            false,
            function () {
                main();
            });
        return;
    }
    //all old schedulers are now deleted, start the main flow
    //find Shelly timezone
    let shEpochUtc = Shelly.getComponentStatus("sys").unixtime;
    let shDt = new Date(shEpochUtc * 1000);
    let shHr = shDt.getHours();
    let shUtcHr = shDt.toISOString().slice(11, 13);
    let tz = shHr - shUtcHr;
    if (tz > 12) { tz -= 24; }
    if (tz < -12) { tz += 24; }
    let tzInSec = tz * 60 * 60;

    // After 23:00 tomorrow's energy prices are used
    // before 23:00 today's energy prices are used.
    let addDays = shHr >= 23 ? 0 : -1;

    // build datetime for Elering query
    let isoTime = new Date((shEpochUtc + tzInSec + _.dayInSec * addDays) * 1000).toISOString().slice(0, 10);
    let isoTimePlusDay = new Date((shEpochUtc + tzInSec + (_.dayInSec * (addDays + 1))) * 1000).toISOString().slice(0, 10);
    let dtStart = isoTime + "T" + (24 - tz) + ":00Z";
    let dtEnd = isoTimePlusDay + "T" + (24 - tz - 1) + ":00Z";
    _.elUrl = _.elering + "&start=" + dtStart + "&end=" + dtEnd;

    print(_.pId, "Shelly ", shDt);
    shDt = null;
    shEpochUtc = null;

    _.heatTime = s.heatingMode.heatingTime;
    //if weather forecast used for heating hours
    s.heatingMode.isFcstUsed ? getForecast() : getElering();
}

/**
Get Open-Meteo min and max "feels like" temperatures
 */
function getForecast() {
    let lat = JSON.stringify(Shelly.getComponentConfig("sys").location.lat);
    let lon = JSON.stringify(Shelly.getComponentConfig("sys").location.lon);
    _.omUrl = _.openMeteo + "&latitude=" + lat + "&longitude=" + lon;
    print(_.pId, "Get forecast from: ", _.omUrl)
    try {
        Shelly.call("HTTP.GET", { url: _.omUrl, timeout: 5, ssl_ca: "*" }, fcstCalc);
    }
    catch (error) {
        print(_.pId, "Oh no, OpenMeteo ", error);
        print(_.pId, "Get forecast failed, checking again in ", _.loopFreq, " seconds.");
        _.loopRunning = false;
    }
}

/* Calculate heating hours */
function fcstCalc(res, err, msg) {
    try {
        if (err != 0 || res === null || res.code != 200 || JSON.parse(res.body)["error"]) {
            print(_.pId, "Get forecast failed, checking again in ", _.loopFreq, " seconds.");
            _.loopRunning = false;
        }
        else {
            let jsonFcst = JSON.parse(res.body); //open-meteo json response
            let aTemp = jsonFcst["hourly"]["apparent_temperature"]; //get 6h, 12h or 24h temperatures
            let sumFcst = 0;
            for (let i = 0; i < aTemp.length; i++) {
                sumFcst += aTemp[i];
            }
            //clear memory
            aTemp = null;
            res = null;
            jsonFcst = null;

            let tempFcst = Math.ceil(sumFcst / s.heatingMode.timePeriod); //AVG and round temperature up
            _.tsFcst = epoch();  //store the timestamp into memory
            print(_.pId, "We got weather forecast from Open Meteo at ", new Date().toString());

            // calculating heating hours
            let startTemp = 16;
            let fcstHeatTime = ((startTemp - tempFcst) * (s.powerFactor - 1) + (startTemp - tempFcst + s.heatingCurve - 2));
            fcstHeatTime = fcstHeatTime < 0 || tempFcst > startTemp ? 0 : fcstHeatTime; //heating time can't be negative
            _.heatTime = Math.floor(fcstHeatTime / _.ctPeriods); //divide with periods and round-down heating duration
            _.heatTime = _.heatTime > s.heatingMode.timePeriod ? s.heatingMode.timePeriod : _.heatTime; //heating time can't be more than period

            print(_.pId, "Temperture forecast width windchill is ", tempFcst, " °C, and heating enabled for ", _.heatTime, " hours.");

            getElering(); //call elering
        }
    } catch (error) {
        print(_.pId, "Oh no, OpenMeteo JSON ", error);
        print(_.pId, "Get forecast failed, checking again in ", _.loopFreq, " seconds.");
        _.loopRunning = false;
    }
}

/* Get electricity market price CSV file from Elering.  */
function getElering() {
    print(_.pId, "Get Elering prices from: ", _.elUrl);
    try {
        Shelly.call("HTTP.GET", { url: _.elUrl, timeout: 5, ssl_ca: "*" }, priceCalc);
    }
    catch (error) {
        print(_.pId, "Oh no, Elering ", error);
        print(_.pId, "Get Elering failed, checking again in ", _.loopFreq, " seconds.");
        _.loopRunning = false;
    }
}

/**
Price calculation logic.
Creating time periods etc.
*/
function priceCalc(res, err, msg) {
    if (err != 0 || res === null || res.code != 200 || !res.body_b64) {
        print(_.pId, "Get Elering failed, checking again in ", _.loopFreq, " seconds.");
        _.loopRunning = false;
    }
    else {
        //clear memory
        res.headers = null;
        res.message = null;
        msg = null;

        //Converting base64 to text
        res.body_b64 = atob(res.body_b64);

        //Discarding header
        res.body_b64 = res.body_b64.substring(res.body_b64.indexOf("\n") + 1);

        let eleringPrices = [];
        let activePos = 0;
        while (activePos >= 0) {
            res.body_b64 = res.body_b64.substring(activePos);
            activePos = 0;

            let row = [0, 0];
            activePos = res.body_b64.indexOf("\"", activePos) + 1;

            if (activePos === 0) {
                //" character not found -> end of data
                break;
            }

            //epoch
            row[0] = Number(res.body_b64.substring(activePos, res.body_b64.indexOf("\"", activePos)));

            //skip "; after timestamp
            activePos = res.body_b64.indexOf("\"", activePos) + 2;

            //price
            activePos = res.body_b64.indexOf(";\"", activePos) + 2;
            row[1] = Number(res.body_b64.substring(activePos, res.body_b64.indexOf("\"", activePos)).replace(",", "."));

            //Add transfer fees (if any)
            let hour = new Date(row[0] * 1000).getHours();
            let day = new Date(row[0] * 1000).getDay();
            if (hour < 7 || hour >= 22 || day === 6 || day === 0) {
                row[1] += s.elektrilevi.nightRt; //night fee
            }
            else {
                row[1] += s.elektrilevi.dayRt; //day fee
            }

            //Adding stuff
            eleringPrices.push(row);
            //find next row
            activePos = res.body_b64.indexOf("\n", activePos);
        }
        res = null; //to save memory

        let newScheds = [];
        //store the timestamp into memory
        _.tsPrices = epoch();
        print(_.pId, "We got market prices from Elering ", new Date().toString());

        setShellyTimer(s.isOutputInverted, s.defaultTimer); //set default timer

        //if heating is based only on the alwaysOnMaxPrice and alwaysOffMinPrice
        if (s.heatingMode.timePeriod <= 0) {
            for (let a = 0; a < eleringPrices.length; a++) {
                if (eleringPrices[a][1] < s.alwaysOnLowPrice) {
                    newScheds.push([new Date((eleringPrices[a][0]) * 1000).getHours(), eleringPrices[a][1], 0]);
                    print(_.pId, "Energy price + transfer fee " + eleringPrices[a][1] + " EUR/MWh at " + new Date((eleringPrices[a][0]) * 1000).getHours() + ":00 is less than min price and used for heating.")
                }
            }

            if (!newScheds.length) {
                print(_.pId, "No energy prices below min price level. No heating.")
            }
        }

        //heating periods calculation 
        let period = [];
        let sortedPeriod = [];

        //the number of period when the script is executed in case of forecast used
        let nmPeriod = Math.ceil((new Date().getHours() % 23 + 2) / s.heatingMode.timePeriod);

        // Create an array for each heating period, sort, and push the prices 
        for (let i = 0; i < _.ctPeriods; i++) {
            if (s.heatingMode.isFcstUsed && (i + 1) != nmPeriod) { continue; } //in case of forecast, only one period is calculated
            let k = 0;
            let hoursInPeriod = (i + 1) * s.heatingMode.timePeriod > 24 ? 24 : (i + 1) * s.heatingMode.timePeriod;
            for (let j = i * s.heatingMode.timePeriod; j < hoursInPeriod; j++) {
                period[k] = eleringPrices[j];
                k++;
            }
            sortedPeriod = sort(period, 1); //sort by price
            let heatingHours = sortedPeriod.length < _.heatTime ? sortedPeriod.length : _.heatTime; //finds max hours to heat in that period 

            for (let a = 0; a < sortedPeriod.length; a++) {
                if ((a < heatingHours || sortedPeriod[a][1] < s.alwaysOnLowPrice) && !(sortedPeriod[a][1] > s.alwaysOffHighPrice)) {
                    newScheds.push([new Date((sortedPeriod[a][0]) * 1000).getHours(), sortedPeriod[a][1], i + 1]);
                }

                //If some hours are too expensive to use for heating, then just let user know for this
                if (a < heatingHours && sortedPeriod[a][1] > s.alwaysOffHighPrice) {
                    print(_.pId, "Energy price + transfer fee " + sortedPeriod[a][1] + " EUR/MWh at " + new Date((sortedPeriod[a][0]) * 1000).getHours() + ":00 is more expensive than max price and not used for heating.")
                }
            }
        }
        //clearing memory
        eleringPrices = null;
        sortedPeriod = null;
        period = null;
        listScheds(sort(newScheds, 0));
    }
}

/**
Get all the existing schedulers to check duplications
 */
function listScheds(newScheds) {
    Shelly.call("Schedule.List", {},
        function (res, err, msg, data) {
            if (res === 0) {
                // No existing schedulers found
                createScheds([], data.s);
            }
            else {
                // Found existing schedulers
                createScheds(res.jobs, data.s);
                res = null; //to save memory
            }
        }, { s: newScheds }
    );
}

/**
Create all schedulers, the Shelly limit is 20.
 */
function createScheds(listScheds, newScheds) {
    //logic below is a non-blocking method for RPC calls to create all schedulers one by one
    if (_.cntr < 6 - _.rpcCl) {
        for (let i = 0; i < _.rpcCl && i < newScheds.length; i++) {
            let isExist = false;
            let hour = newScheds[0][0];
            let ctPeriod = newScheds[0][2];
            let price = newScheds.splice(0, 1)[0][1]; //cut the array one-by-one
            let timespec = "0 0 " + hour + " * * *";
            //looping through existing schedulers
            for (let k = 0; k < listScheds.length; k++) {
                let t = listScheds[k].timespec;
                let p = listScheds[k].calls[0].params;
                //check if the scheduler exist 
                if (p.id === s.relayID && t.split(" ").join("") === timespec.split(" ").join("")) {
                    print(_.pId, "#" + ctPeriod, "Skipping scheduler at: ", hour + ":00 for relay:", s.relayID, " as it is already exist.");
                    isExist = true;
                    break;
                }
            }
            // only create unique schedulers
            if (!isExist) {
                _.cntr++;
                Shelly.call("Schedule.Create", {
                    "id": 0, "enable": true, "timespec": timespec,
                    "calls": [{
                        "method": "Switch.Set",
                        "params": {
                            "id": s.relayID,
                            "on": !s.isOutputInverted
                        }
                    }]
                },
                    function (res, err, msg, data) {
                        if (err !== 0) {
                            print(_.pId, "#" + data.ctPeriod, "Scheduler at: ", data.hour + ":00 price: ", data.price, " EUR/MWh (energy price + transmission). FAILED, 20 schedulers is the Shelly limit.");
                        }
                        else {
                            print(_.pId, "#" + data.ctPeriod, "Scheduler starts at: ", data.hour + ":00 price: ", data.price, " EUR/MWh (energy price + transmission). ID:", res.id, " SUCCESS");
                            _.schedId.push(res.id); //create an array of scheduleIDs
                        }
                        _.cntr--;
                    },
                    { hour: hour, price: price, ctPeriod: ctPeriod }
                );
            }
        }
    }

    //if there are more calls in the queue
    if (newScheds.length > 0) {
        Timer.set(
            1000, //the delay
            false,
            function () {
                createScheds(listScheds, newScheds);
            });
    }
    else {
        setKVS();
    }
}

/**
Storing the scheduler IDs in KVS to not loose them in case of power outage
 */
function setKVS() {
    //wait until all the schedulerIDs are collected
    if (_.cntr !== 0) {
        Timer.set(
            1000,
            false,
            function () {
                setKVS();
            });
        return;
    }
    //schedulers are created, store the IDs to KVS
    Shelly.call("KVS.set", { key: "version" + _.sId, value: _.version });
    Shelly.call("KVS.set", { key: "timestamp" + _.sId, value: new Date().toString() });
    Shelly.call("KVS.set", { key: "schedulerIDs" + _.sId, value: JSON.stringify(_.schedId) },
        function () {
            print(_.pId, "Script v", _.version, " created all the schedules, next heating calculation at", nextChkHr() + ":00.");
            _.loopRunning = false;
        });
    _.schedId = [];
}

/**
Set countdown timer to flip Shelly status
 */
function setShellyTimer(isOutInv, timerMin) {
    let is_on = isOutInv ? "on" : "off";
    let timerSec = timerMin * 60; //time in seconds
    print(_.pId, "Set Shelly auto " + is_on + " timer for ", timerMin, " minutes.");
    Shelly.call("Switch.SetConfig", {
        "id": 0,
        config: {
            "name": "Switch0",
            "auto_on": isOutInv,
            "auto_on_delay": timerSec,
            "auto_off": !isOutInv,
            "auto_off_delay": timerSec
        }
    });
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
}

function epoch() {
    return Math.floor(Date.now() / 1000.0);
}
/* Next hour for heating calculation */
function nextChkHr() {
    let chkT = s.heatingMode.isFcstUsed ? s.heatingMode.timePeriod : 24;
    let hr = (Math.ceil((new Date().getHours() + 1) / chkT) * chkT) - 1;
    return hr > 23 ? 23 : hr;
}
/**
Getting prices or forecast for today if 
    * prices or forecast have never been fetched OR 
    * prices or forecast are not from today or yesterday OR 
    * prices or forecast needs regular update
 */
function isUpdtReq(ts) {
    let nextHour = nextChkHr();
    let now = new Date();
    let yestDt = new Date(now - _.dayInSec * 1000);
    let tsDt = new Date(ts * 1000);
    let isToday = tsDt.getFullYear() === now.getFullYear() && tsDt.getMonth() === now.getMonth() && tsDt.getDate() === now.getDate();
    let isYesterday = tsDt.getFullYear() === yestDt.getFullYear() && tsDt.getMonth() === yestDt.getMonth() && tsDt.getDate() === yestDt.getDate();
    let isTsAfterChkT = new Date(ts * 1000).getHours() === nextHour;
    let isChkT = now.getHours() === nextHour;
    return (isChkT && !isTsAfterChkT) || !(isToday || isYesterday);
}

/**
 This loop runs in every xx seconds
 */
function loop() {
    if (_.loopRunning) {
        return;
    }
    _.loopRunning = true;
    if ((isUpdtReq(_.tsPrices) || s.heatingMode.isFcstUsed && isUpdtReq(_.tsFcst)) && isShellyTimeOk) {
        start();
    } else {
        _.loopRunning = false;
    }
}

let isShellyTimeOk = false;
let timer_handle;
function checkShellyTime() {
    //check Shelly time
    let shEpochUtc = Shelly.getComponentStatus("sys").unixtime;
    if (shEpochUtc > 0) {
        //if time is OK, then stop the timer
        Timer.clear(timer_handle);
        isShellyTimeOk = true;
    }
    else {
        //waiting timeserver response
        return;
    }
}
//start the script with the time testing
timer_handle = Timer.set(500, true, checkShellyTime); //0,5 sec until the time is OK

//start the loop component
Timer.set(_.loopFreq * 1000, true, loop);

/*  ---------  WATCHDOG START  ---------   */
/** This is the watchdog script code */
let watchdog = 'let _={sId:0,mc:3,ct:0};function start(e){Shelly.call("KVS.Get",{key:"schedulerIDs"+e},(function(e,l,t,c){if(e){let l=[];l=JSON.parse(e.value),e=null,delSc(l,c.sId)}}),{sId:e})}function delSc(e,l){if(_.ct<6-_.mc)for(let t=0;t<_.mc&&t<e.length;t++){let t=e.splice(0,1)[0];_.ct++,Shelly.call("Schedule.Delete",{id:t},(function(e,t,c,i){0!==t?print("Script #"+l,"schedule ",i.id," del FAIL."):print("Script #"+l,"schedule ",i.id," del OK."),_.ct--}),{id:t})}e.length>0?Timer.set(1e3,!1,(function(){delSc(e,l)})):delKVS(l)}function delKVS(e){0===_.ct?(Shelly.call("KVS.Delete",{key:"schedulerIDs"+e}),Shelly.call("KVS.Delete",{key:"version"+e}),Shelly.call("KVS.Delete",{key:"timestamp"+e}),print("Heating script #"+e,"is clean")):Timer.set(1e3,!1,(function(){delKVS(e)}))}Shelly.addStatusHandler((function(e){"script"!==e.name||e.delta.running||(_.sId=e.delta.id,start(_.sId))}));'
/** find watchdog script ID */
function createWatchdog() {
    Shelly.call('Script.List', null, function (res, err, msg, data) {
        if (res) {
            let wdId = 0;
            let s = res.scripts;
            res = null;
            for (let i = 0; i < s.length; i++) {
                if (s[i].name === "watchdog") {
                    wdId = s[i].id;
                    break;
                }
            }
            createScript(wdId);
        }
    });
}
/** Create a new script (id==0) or stop the existing script (id<>0) if watchdog found. */
function createScript(id) {
    if (id === 0) {
        Shelly.call('Script.Create', { name: "watchdog" }, putCode, { id: id });
    }
    else {
        Shelly.call('Script.Stop', { id: id }, putCode, { id: id });
    }
}
/** Add code to the watchdog script */
function putCode(res, err, msg, data) {
    if (err === 0) {
        print(_.pId, "Watchdog script has been created.");
        let scId = res.id > 0 ? res.id : data.id;
        Shelly.call('Script.PutCode', { id: scId, code: watchdog }, startScript, { id: scId });
    }
    else {
        print(_.pId, "Watchdog script creation failed.", msg, ". Schedules are not deleted if heating script is stopped or deleted.");
    }
}
/** Enable autostart and start the watchdog script */
function startScript(res, err, msg, data) {
    if (err === 0) {
        print(_.pId, "Insert code to watchdog script completed.");
        if (!Shelly.getComponentConfig("script", data.id).enable) {
            Shelly.call('Script.SetConfig', { id: data.id, config: { enable: true } },
                function (res, err, msg, data) {
                    if (err != 0) {
                        print(_.pId, "Watchdog script autostart is not enabled.", msg, ". After Shelly restart, this script will not start and schedules are not deleted if heating script is stopped or deleted.");
                    }
                });
        }
        Shelly.call('Script.Start', { id: data.id }, function (res, err, msg, data) {
            if (err === 0) {
                print(_.pId, "Watchdog script started succesfully.");
            }
            else {
                print(_.pId, "Watchdog script is not started.", msg, ". Schedules are not deleted if heating script is stopped or deleted.");
            }
        });
    }
    else {
        print(_.pId, "Adding code to the script is failed.", msg, ". Schedules are not deleted if heating script is stopped or deleted.")
    }
}
/*  ---------  WATCHDOG END  ---------   */

createWatchdog();
loop();