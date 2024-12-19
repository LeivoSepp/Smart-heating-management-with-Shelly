/*
This Shelly script is designed to retrieve energy market prices from Elering and
activate heating during the most cost-effective hours each day, employing various algorithms. 

1. Dynamic calculation of heating time for the next day based on weather forecasts.
2. Division of heating into time periods, with activation during the cheapest hour within each period.
3. Utilization of min-max price levels to maintain the Shelly system consistently on or off.
The script executes daily after 23:00 to establish heating timeslots for the following day.

created by Leivo Sepp, 17.12.2024
https://github.com/LeivoSepp/Smart-heating-management-with-Shelly
*/

/* Elektrilevi electricity transmission fees (EUR/MWh): https://elektrilevi.ee/en/vorguleping/vorgupaketid/eramu */
let VORK1 = { dayRate: 77, nightRate: 77, dayMaxRate: 77, holidayMaxRate: 77 };
let VORK2 = { dayRate: 60, nightRate: 35, dayMaxRate: 60, holidayMaxRate: 35 };
let VORK4 = { dayRate: 37, nightRate: 21, dayMaxRate: 37, holidayMaxRate: 21 };
let VORK5 = { dayRate: 53, nightRate: 30, dayMaxRate: 82, holidayMaxRate: 47 };
let NONE = { dayRate: 0, nightRate: 0, dayMaxRate: 0, holidayMaxRate: 0 };

/****** PROGRAM INITIAL SETTINGS ******/
/* 
After the initial run, all user settings are stored in the Shelly 1) KVS or 2) Virtual components (in case virtual components are supported).
To modify these user settings later, you’ll need to access the Shelly KVS via: Menu → Advanced → KVS on the Shelly web page.
Once you’ve updated the settings, restart the script to apply the changes or wait for the next scheduled run.
If the Shelly supports Virtual components, the script will automatically create them and store the settings there.
This allows you to modify the heating settings directly from the Shelly web page.
Updating script code is easy, you only need to copy-paste new code as all the settings are pulled from the KVS or Virtual components.

heatingMode.timePeriod: Heating Period is the time during which heating time is calculated. (0 -> only min-max price used, 24 -> period is one day).
heatingMode.heatingTime: Heating Time is the duration of the cheapest hours within a Heating Period when the heating system is activated. or duration of heating in a day in case of internet connection failure.
heatingMode.isFcstUsed: true/false - Using weather forecast to calculate heating duration.
*/
let s = {
    heatingMode: { timePeriod: 24, heatingTime: 10, isFcstUsed: false }, // HEATING MODE. Different heating modes described above.
    elektrilevi: "VORK2",      // ELEKTRILEVI transmission fee: VORK1 / VORK2 / VORK4 /VORK5 / NONE
    alwaysOnLowPrice: 1,       // Keep heating always ON if energy price lower than this value (EUR/MWh)
    alwaysOffHighPrice: 300,    // Keep heating always OFF if energy price higher than this value (EUR/MWh)
    isOutputInverted: false,    // Configures the relay state to either normal or inverted. (inverted required by Nibe, Thermia)
    relayID: 0,                 // Shelly relay ID
    defaultTimer: 60,           // Default timer duration, in minutes, for toggling the Shelly state.
    country: "ee",              // Estonia-ee, Finland-fi, Lithuania-lt, Latvia-lv
    heatingCurve: 0,            // Shifting heating curve to the left or right, check the tables below. Shift by 1 equals 1h more. 
    powerFactor: 0.5,           // Adjusts the heating curve to be either more flat or more aggressive (0 -> flat, 1 -> steep).
}
/****** PROGRAM INITIAL SETTINGS ******/

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
    openMeteo: "https://api.open-meteo.com/v1/forecast?hourly=apparent_temperature&timezone=auto&forecast_days=1&forecast_hours=",
    elering: "https://dashboard.elering.ee/api/nps/price/csv?fields=",
    elUrl: '',
    omUrl: '',
    heatTime: '',
    ctPeriods: '', //period count is up-rounded
    tsPrices: '',
    tsFcst: '',
    loopFreq: 300, //300 seconds / 5 min
    loopRunning: false,
    dayInSec: 60 * 60 * 24,
    updtDelay: Math.floor(Math.random() * 46), //delay for server requests (max 45min)
    sId: Shelly.getCurrentScriptId(),
    pId: "Id" + Shelly.getCurrentScriptId() + ": ",
    rpcCl: 1,
    rpcBlock: 1,
    schedId: [],
    newSchedules: [],
    isSchedCreatedManually: false,
    existingSchedules: [],
    version: 3.5,
};
let cntr = 0;

let virtualComponents = [
    {
        type: "group", id: 200, config: {
            name: "Smart Heating"
        }
    },
    {
        type: "enum", id: 200, config: {
            name: "Heating Period (h)",
            options: ["24", "12", "6", "0"],
            default_value: "24",
            persisted: true,
            meta: { ui: { view: "dropdown", webIcon: 13, titles: { "24": "24 hour", "12": "12 hour", "6": "6 hour", "0": "No period" } } }
        }
    },
    {
        type: "number", id: 200, config: {
            name: "Heating Time (h/period)",
            default_value: 10,
            min: 0,
            max: 20,
            persisted: true,
            meta: { ui: { view: "slider", unit: "h/period" } }
        }
    },
    {
        type: "enum", id: 201, config: {
            name: "Elektrilevi Package",
            options: ["NONE", "VORK1", "VORK2", "VORK4", "VORK5"],
            default_value: "VORK2",
            persisted: true,
            meta: { ui: { view: "dropdown", webIcon: 22, titles: { "NONE": "No package", "VORK1": "Võrk1 Basic", "VORK2": "Võrk2 DayNight", "VORK4": "Võrk4 DayNight", "VORK5": "Võrk5 DayNightPeak" } } }
        }
    },
    {
        type: "number", id: 201, config: {
            name: "Heat On (min price)",
            default_value: 1,
            min: 0,
            max: 100,
            persisted: true,
            meta: { ui: { view: "slider", unit: "€/MWh or less" } }
        }
    },
    {
        type: "number", id: 202, config: {
            name: "Heat Off (max price)",
            default_value: 300,
            min: 0,
            max: 500,
            persisted: true,
            meta: { ui: { view: "slider", unit: "€/MWh or more" } }
        }
    },
    {
        type: "boolean", id: 201, config: {
            name: "Inverted Relay",
            default_value: false,
            persisted: true,
            meta: { ui: { view: "toggle", webIcon: 7, titles: ["No", "Yes"] } }
        }
    },
    {
        type: "enum", id: 202, config: {
            name: "Market Price Country",
            options: ["ee", "fi", "lv", "lt"],
            default_value: "ee",
            persisted: true,
            meta: { ui: { view: "dropdown", webIcon: 9, titles: { "ee": "Estonia", "fi": "Findland", "lv": "Latvia", "lt": "Lithuania" } } }
        }
    },
    {
        type: "boolean", id: 200, config: {
            name: "Forecast Heat",
            default_value: false,
            persisted: true,
            meta: { ui: { view: "toggle", webIcon: 14, titles: ["No", "Yes"] } }
        }
    },
    {
        type: "number", id: 203, config: {
            name: "Forecast Impact +/-",
            default_value: 0,
            min: -10,
            max: 10,
            persisted: true,
            meta: { ui: { view: "slider", unit: "h more heat" } }
        }
    },
];


/*
This is the start of the script.
Set the script to start automatically.
Set the default script library
Get old scheduler IDs from the KVS storage
*/
function start() {
    setAutoStart();
    setKvsScrLibr();
    checkSettingsKvs();
}
/* set the script to sart automatically on boot */
function setAutoStart() {
    if (!Shelly.getComponentConfig("script", _.sId).enable) {
        Shelly.call('Script.SetConfig', { id: _.sId, config: { enable: true } },
            function (res, err, msg, data) {
                if (err != 0) {
                    print(_.pId, "Heating script autostart is not enabled.", msg, ". After Shelly restart, this script will not start and new heating schedules are not created.");
                }
            });
    }
}
/* set the default script library */
function setKvsScrLibr() {
    Shelly.call("KVS.set", { key: "scripts-library", value: '{"url": "https://raw.githubusercontent.com/LeivoSepp/Smart-heating-management-with-Shelly/master/manifest.json"}' });
}

function isVirtualComponentsAvailable() {
    let info = Shelly.getDeviceInfo();
    return info.gen === 3 || (info.gen === 2 && info.app.substring(0, 3) == "Pro");
}

function checkSettingsKvs() {
    //get all KVS values
    Shelly.call('KVS.GetMany', null, processKVSData);
}
function processKVSData(res, err, msg, data) {
    let kvsData;
    if (res) {
        kvsData = res.items;
        res = null; //to save memory
    }

    //store scheduler IDs to memory
    _.existingSchedules = typeof kvsData["schedulerIDs" + _.sId] !== "undefined" && typeof JSON.parse(kvsData["schedulerIDs" + _.sId].value) === "object" ? JSON.parse(kvsData["schedulerIDs" + _.sId].value) : [];
    //old version number is used to maintain backward compatibility
    const oldVersion = (kvsData["version" + _.sId] != null && typeof JSON.parse(kvsData["version" + _.sId].value) === "number") ? JSON.parse(kvsData["version" + _.sId].value) : 0;

    if (isVirtualComponentsAvailable()) {
        let userConfig = [];
        //create an array from the user settings to delete them from KVS
        for (let i in s) userConfig.push(i + _.sId);

        if (oldVersion <= 3.2) {
            print(_.pId, "New virtual component installation.");
            deleteAllKvs(userConfig);
            userConfig = null;
        } else if (oldVersion === 3.3) {
            print(_.pId, "Upgrading from KVS to Virtual components.");
            virtualComponents[1].config.default_value = JSON.stringify(JSON.parse(kvsData["heatingMode" + _.sId].value).timePeriod);
            virtualComponents[2].config.default_value = JSON.parse(kvsData["heatingMode" + _.sId].value).heatingTime;
            virtualComponents[8].config.default_value = JSON.parse(kvsData["heatingMode" + _.sId].value).isFcstUsed;
            virtualComponents[4].config.default_value = JSON.parse(kvsData["alwaysOnLowPrice" + _.sId].value);
            virtualComponents[5].config.default_value = JSON.parse(kvsData["alwaysOffHighPrice" + _.sId].value);
            virtualComponents[6].config.default_value = JSON.parse(kvsData["isOutputInverted" + _.sId].value);
            virtualComponents[7].config.default_value = kvsData["country" + _.sId].value;
            virtualComponents[3].config.default_value = kvsData["elektrilevi" + _.sId].value;
            virtualComponents[9].config.default_value = JSON.parse(kvsData["heatingCurve" + _.sId].value);

            deleteAllKvs(userConfig);
            userConfig = null;
        } else {
            print(_.pId, "Script in Virtual components mode.");
            readAllVirtualComponents();
        }
    } else { // this is the old KVS path if Shelly doesn't support Virtual components
        print(_.pId, "Script in KVS mode.");
        let isExistInKvs = false;
        let userCongfigNotInKvs = [];
        //iterate through settings and then through KVS
        for (var k in s) {
            for (var i in kvsData) {
                //check if settings found in KVS
                if (i == k + _.sId) {
                    if (k == "elektrilevi" || k == "country") {
                        if (oldVersion >= 3.2) {
                            s[k] = kvsData[i].value; //do not convert strings
                        } else {
                            break; //store new versions of elektrilevi and country values <- this part is for backward compatibility
                        }
                    } else {
                        s[k] = JSON.parse(kvsData[i].value); //convert string values to object
                    }
                    isExistInKvs = true;
                    break;
                }
            }
            if (isExistInKvs) {
                isExistInKvs = false;
            } else if (typeof s[k] === "object") {
                userCongfigNotInKvs.push([k, JSON.stringify(s[k])]);
            } else {
                userCongfigNotInKvs.push([k, s[k]]);
            }
        }
        //convert the elektrilevi packet value to variable
        s.elektrilevi = eval(s.elektrilevi);

        storeSettingsKvs(userCongfigNotInKvs);
        userCongfigNotInKvs = null;
    }
    kvsData = null; //save memory
}
function storeSettingsKvs(userCongfigNotInKvs) {
    if (cntr < 6 - _.rpcCl) {
        for (let i = 0; i < _.rpcCl && i < userCongfigNotInKvs.length; i++) {
            let value = userCongfigNotInKvs[0][1];
            let key = userCongfigNotInKvs.splice(0, 1)[0][0] + _.sId;
            cntr++;
            Shelly.call("KVS.set", { key: key, value: value },
                function (res, error_code, error_message, data) {
                    if (error_code !== 0) {
                        print(_.pId, "Store settings", data.key, data.value, "in KVS failed.");
                    } else {
                        print(_.pId, "Store settings", data.key, data.value, "to KVS is OK");
                    }
                    cntr--;
                },
                { key: key, value: value }
            );
        }
    }
    //if there are more items in queue
    if (userCongfigNotInKvs.length > 0) {
        Timer.set(1000, false, function () { storeSettingsKvs(userCongfigNotInKvs); });
    } else {
        main();
    }
}

// Only in case of Virtual Components: delete user config from KVS store as all the config moved to Virtual components
function deleteAllKvs(userConfig) {
    if (cntr < 6 - _.rpcCl) {
        for (let i = 0; i < _.rpcCl && i < userConfig.length; i++) {
            let key = userConfig.splice(0, 1)[0];
            cntr++;
            Shelly.call("KVS.Delete", { key: key },
                function (res, error_code, error_message, data) {
                    if (error_code === 0) {
                        print(_.pId, "Deleted " + data.key + " from KVS store");
                    } else {
                        print(_.pId, "Failed to delete " + data.key + " from KVS store. Error: " + error_message);
                    }
                    cntr--;
                },
                { key: key }
            );
        }
    }
    //if there are more items in queue
    if (userConfig.length > 0) {
        Timer.set(1000, false, function () { deleteAllKvs(userConfig); });
    } else {
        getAllVirtualComponents();
    }
}

// Function to get all virtual components and delete them all before creating new
function getAllVirtualComponents() {
    //wait until all KVS are deleted
    if (cntr !== 0) {
        Timer.set(1000, false, getAllVirtualComponents);
        return;
    }
    Shelly.call("Shelly.GetComponents", { dynamic_only: true, include: ["config"] }, function (result, error_code, error_message) {
        if (error_code === 0) {
            if (result.components && result.components.length > 0) {
                deleteVirtualComponents(result.components);
                result = null;
            } else {
                addVirtualComponent(virtualComponents);
            }
        } else {
            print(_.pId, "Failed to get virtual components. Error: " + error_message);
        }
    });
}
// Function to delete all virtual components
function deleteVirtualComponents(vComponents) {
    if (cntr < 6 - _.rpcCl) {
        for (let i = 0; i < _.rpcCl && i < vComponents.length; i++) {
            let key = vComponents.splice(0, 1)[0].key;
            cntr++;
            Shelly.call("Virtual.Delete", { key: key },
                function (res, error_code, error_message, data) {
                    if (error_code === 0) {
                        print(_.pId, "Deleted " + data.key + " virtual component");
                    } else {
                        print(_.pId, "Failed to delete " + data.key + " virtual component. Error: " + error_message);
                    }
                    cntr--;
                },
                { key: key }
            );
        }
    }
    //if there are more items in queue
    if (vComponents.length > 0) {
        Timer.set(1000, false, function () { deleteVirtualComponents(vComponents); });
    } else {
        addVirtualComponent(virtualComponents);
    }
}

//add all new virtual components
function addVirtualComponent(virtualComponents) {
    if (cntr < 6 - _.rpcCl) {
        for (let i = 0; i < _.rpcCl && i < virtualComponents.length; i++) {
            let component = virtualComponents.splice(0, 1)[0];
            let type = component.type;
            let id = component.id;
            let config = component.config;
            cntr++;
            Shelly.call("Virtual.Add", { type: type, id: id, config: config },
                function (res, error_code, error_message, data) {
                    if (error_code === 0) {
                        print(_.pId, "Added virtual component: " + data.type + ":" + data.id);
                    } else {
                        print(_.pId, "Failed to add virtual component: " + data.type + ":" + data.id + ". Error: " + error_message);
                    }
                    cntr--;
                },
                { type: type, id: id, config: config }
            );
        }
    }
    //if there are more items in queue
    if (virtualComponents.length > 0) {
        Timer.set(1000, false, function () { addVirtualComponent(virtualComponents); });
    } else {
        setGroupConfig();
    }
}

function setGroupConfig() {
    //wait until all Virtual components added
    if (cntr !== 0) {
        Timer.set(1000, false, setGroupConfig);
        return;
    }
    const groupConfig = {
        id: 200,
        value: [
            "enum:200",
            "number:200",
            "boolean:200",
            "number:203",
            "enum:201",
            "number:201",
            "number:202",
            "boolean:201",
            "enum:202"
        ]
    };
    Shelly.call("Group.Set", groupConfig, function (result, error_code, error_message) {
        if (error_code !== 0) {
            print(_.pId, "Failed to set group config. Error: " + error_message);
        }
    });
    readAllVirtualComponents();
}

function readAllVirtualComponents() {
    Shelly.call("Shelly.GetComponents", { dynamic_only: true, include: ["status"] }, function (result, error_code, error_message) {
        if (error_code === 0) {
            if (result.components && result.components.length > 0) {
                for (let i in result.components) {
                    switch (result.components[i].key) {
                        case "enum:200":
                            s.heatingMode.timePeriod = JSON.parse(result.components[i].status.value);
                            break;
                        case "number:200":
                            s.heatingMode.heatingTime = JSON.parse(result.components[i].status.value);
                            break;
                        case "boolean:200":
                            s.heatingMode.isFcstUsed = JSON.parse(result.components[i].status.value);
                            break;
                        case "enum:201":
                            s.elektrilevi = eval(result.components[i].status.value);
                            break;
                        case "number:201":
                            s.alwaysOnLowPrice = JSON.parse(result.components[i].status.value);
                            break;
                        case "number:202":
                            s.alwaysOffHighPrice = JSON.parse(result.components[i].status.value);
                            break;
                        case "boolean:201":
                            s.isOutputInverted = JSON.parse(result.components[i].status.value);
                            break;
                        case "enum:202":
                            s.country = result.components[i].status.value;
                            break;
                        case "number:203":
                            s.heatingCurve = JSON.parse(result.components[i].status.value);
                            break;
                        default:
                            break;
                    }
                }
                main();
            } else {
                print(_.pId, "No virtual components found.");
            }
        } else {
            print(_.pId, "Failed to get virtual components. Error: " + error_message);
        }
    });
}

/**
This is the main script where all the logic starts.
*/
function main() {
    //wait until settings are stored in KVS
    if (cntr !== 0) {
        Timer.set(1000, false, main);
        return;
    }
    // Calculate the number of periods
    _.ctPeriods = s.heatingMode.timePeriod <= 0 ? 0 : Math.ceil((24 * 100) / (s.heatingMode.timePeriod * 100));
    //check Shelly time
    if (!isShellyTimeOk) {
        handleError("Shelly has no time.");
        return;
    }
    // Get Shelly timezone
    let tzInSec = getShellyTimezone();

    // Determine the date range for Elering query
    let dtRange = getEleringDateRange(tzInSec);

    // Build Elering URL
    _.elUrl = buildEleringUrl(dtRange[0], dtRange[1]);

    print(_.pId, "Shelly ", new Date(Shelly.getComponentStatus("sys").unixtime * 1000));

    _.heatTime = s.heatingMode.heatingTime;
    // If weather forecast is used for heating hours
    if (s.heatingMode.isFcstUsed) {
        getForecast();
    } else {
        getElering();
    }
}

function getShellyTimezone() {
    const shEpochUtc = Shelly.getComponentStatus("sys").unixtime;
    let shDt = new Date(shEpochUtc * 1000);
    let shHr = shDt.getHours();
    let shUtcHr = shDt.toISOString().slice(11, 13);
    let tz = shHr - shUtcHr;
    if (tz > 12) { tz -= 24; }
    if (tz < -12) { tz += 24; }
    return tz * 60 * 60;
}
function getEleringDateRange(tzInSec) {
    let shEpochUtc = Shelly.getComponentStatus("sys").unixtime;
    let shHr = new Date(shEpochUtc * 1000).getHours();
    // After 23:00 tomorrow's energy prices are used
    // before 23:00 today's energy prices are used.
    let addDays = shHr >= 23 ? 0 : -1;
    let isoTime = new Date((shEpochUtc + tzInSec + _.dayInSec * addDays) * 1000).toISOString().slice(0, 10);
    let isoTimePlusDay = new Date((shEpochUtc + tzInSec + (_.dayInSec * (addDays + 1))) * 1000).toISOString().slice(0, 10);
    let dtStart = isoTime + "T" + (24 - tzInSec / 3600) + ":00Z";
    let dtEnd = isoTimePlusDay + "T" + (24 - tzInSec / 3600 - 1) + ":00Z";

    return [dtStart, dtEnd];
}
function buildEleringUrl(dtStart, dtEnd) {
    return _.elering + s.country + "&start=" + dtStart + "&end=" + dtEnd;
}
/**
Get Open-Meteo min and max "feels like" temperatures
 */
function getForecast() {
    const lat = JSON.stringify(Shelly.getComponentConfig("sys").location.lat);
    const lon = JSON.stringify(Shelly.getComponentConfig("sys").location.lon);
    _.omUrl = _.openMeteo + s.heatingMode.timePeriod + "&latitude=" + lat + "&longitude=" + lon;
    print(_.pId, "Forecast query: ", _.omUrl)
    try {
        Shelly.call("HTTP.GET", { url: _.omUrl, timeout: 5, ssl_ca: "*" }, fcstCalc);
    }
    catch (error) {
        handleError("Get forecast HTTP error " + error + " check again in " + _.loopFreq / 60 + " min.");
    }
}

/* Calculate heating hours */
function fcstCalc(res, err, msg) {
    try {
        if (err != 0 || res === null || res.code != 200 || JSON.parse(res.body)["error"]) {
            handleError("Get forecast HTTP.GET error, check again in " + _.loopFreq / 60 + " min.");
            return;
        }
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

        const tempFcst = Math.ceil(sumFcst / s.heatingMode.timePeriod); //AVG and round temperature up
        _.tsFcst = epoch();  //store the timestamp into memory
        print(_.pId, "We got weather forecast from Open Meteo at ", new Date().toString());

        // calculating heating hours
        const startTemp = 16;
        let fcstHeatTime = ((startTemp - tempFcst) * (s.powerFactor - 1) + (startTemp - tempFcst + s.heatingCurve - 2));
        fcstHeatTime = fcstHeatTime < 0 || tempFcst > startTemp ? 0 : fcstHeatTime; //heating time can't be negative
        _.heatTime = Math.floor(fcstHeatTime / _.ctPeriods); //divide with periods and round-down heating duration
        _.heatTime = _.heatTime > s.heatingMode.timePeriod ? s.heatingMode.timePeriod : _.heatTime; //heating time can't be more than period

        print(_.pId, "Temperture forecast width windchill is ", tempFcst, " °C, and heating enabled for ", _.heatTime, " hours.");

        getElering(); //call elering
    } catch (error) {
        handleError("Get forecast JSON error," + error + "check again in " + _.loopFreq / 60 + " min.");
    }
}
/* Get electricity market price CSV file from Elering.  */
function getElering() {
    print(_.pId, "Elering query: ", _.elUrl);
    try {
        Shelly.call("HTTP.GET", { url: _.elUrl, timeout: 5, ssl_ca: "*" }, priceCalc);
    }
    catch (error) {
        handleError("Elering HTTP.GET error" + error + "check again in " + _.loopFreq / 60 + " min.");
    }
}
/**
Price calculation logic.
Creating time periods etc.
*/
function priceCalc(res, err, msg) {
    if (err != 0 || res === null || res.code != 200 || !res.body_b64) {
        handleError("Elering JSON error, check again in " + _.loopFreq / 60 + " min.");
        return;
    }
    // Clear unnecessary data to save memory
    res.headers = null;
    res.message = null;
    msg = null;

    // Convert base64 to text and discard header
    res.body_b64 = atob(res.body_b64);
    let csvData = res.body_b64.substring(res.body_b64.indexOf("\n") + 1);
    res = null; //clear memory

    let eleringPrices = parseEleringPrices(csvData);

    //if elering API returns less than 23 rows, the script will try to download the data again after set of minutes
    if (eleringPrices.length < 23) {
        handleError("Elering API didn't return prices, check again in " + _.loopFreq / 60 + " min.");
        return;
    }
    let newScheds = [];
    //store the timestamp into memory
    _.tsPrices = epoch();
    print(_.pId, "We got market prices from Elering ", new Date().toString());

    //if heating is based only on the alwaysOnLowPrice 
    if (s.heatingMode.timePeriod <= 0) {
        for (let a = 0; a < eleringPrices.length; a++) {
            let transferFee = calculateTransferFees(eleringPrices[a][0]);
            if (eleringPrices[a][1] - transferFee < s.alwaysOnLowPrice) {
                newScheds.push([new Date((eleringPrices[a][0]) * 1000).getHours(), eleringPrices[a][1], 0]);
                print(_.pId, "Energy price ", eleringPrices[a][1] - transferFee, " EUR/MWh at ", new Date((eleringPrices[a][0]) * 1000).getHours() + ":00 is less than min price and used for heating.")
            }
        }
    }

    //heating periods calculation 
    let period = [];
    let sortedPeriod = [];

    //the number of period when the script is executed in case of forecast used
    const nmPeriod = Math.ceil((new Date().getHours() % 23 + 2) / s.heatingMode.timePeriod);

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
            let transferFee = calculateTransferFees(sortedPeriod[a][0]);
            if ((a < heatingHours || sortedPeriod[a][1] - transferFee < s.alwaysOnLowPrice) && !(sortedPeriod[a][1] - transferFee > s.alwaysOffHighPrice)) {
                newScheds.push([new Date((sortedPeriod[a][0]) * 1000).getHours(), sortedPeriod[a][1], i + 1]);
            }

            //If some hours are too expensive to use for heating, then just let user know for this
            if (a < heatingHours && sortedPeriod[a][1] - transferFee > s.alwaysOffHighPrice) {
                print(_.pId, "Energy price ", sortedPeriod[a][1] - transferFee, " EUR/MWh at ", new Date((sortedPeriod[a][0]) * 1000).getHours() + ":00 is more expensive than max price and not used for heating.")
            }
        }
    }
    if (!newScheds.length) {
        print(_.pId, "Current configuration does not permit heating during any hours; it is likely that the alwaysOffHighPrice value is set too low.")
    }

    //clearing memory
    eleringPrices = null;
    sortedPeriod = null;
    period = null;
    _.newSchedules = sort(newScheds, 0);
    newScheds = null; //clear memory
    _.isSchedCreatedManually = false;
    setShellyTimer(s.isOutputInverted, s.defaultTimer); //set default timer
    delSc(_.existingSchedules);
}

/**
 * Parse Elering prices from the response body.
 */
function parseEleringPrices(body) {
    let eleringPrices = [];
    let activePos = 0;
    while (activePos >= 0) {
        body = body.substring(activePos);
        activePos = 0;
        let row = [0, 0];
        activePos = body.indexOf("\"", activePos) + 1;
        if (activePos === 0) {
            break; // End of data
        }
        // Epoch
        row[0] = Number(body.substring(activePos, body.indexOf("\"", activePos)));
        // Skip "; after timestamp
        activePos = body.indexOf("\"", activePos) + 2;
        // Price
        activePos = body.indexOf(";\"", activePos) + 2;
        row[1] = Number(body.substring(activePos, body.indexOf("\"", activePos)).replace(",", "."));
        // Add transfer fees
        row[1] += calculateTransferFees(row[0]);
        eleringPrices.push(row);
        activePos = body.indexOf("\n", activePos);
    }
    return eleringPrices;
}
/**
 * Calculate transfer fees based on the timestamp.
 */
function calculateTransferFees(epoch) {
    const hour = new Date(epoch * 1000).getHours();
    const day = new Date(epoch * 1000).getDay();
    const month = new Date(epoch * 1000).getMonth();
    if ((month >= 10 || month <= 2) && (day === 0 || day === 6) && hour >= 16 && hour < 20) {
        // peak holiday: Nov-Mar, SA-SU at 16:00–20:00
        return s.elektrilevi.holidayMaxRate;
    } else if ((month >= 10 || month <= 2) && ((hour >= 9 && hour < 12) || (hour >= 16 && hour < 20))) {
        // peak daytime: Nov-Mar: MO-FR at 09:00–12:00 and at 16:00–20:00
        return s.elektrilevi.dayMaxRate;
    } else if (hour < 7 || hour >= 22 || day === 6 || day === 0) {
        //night-time: MO-FR at 22:00–07:00, SA-SU all day
        return s.elektrilevi.nightRate;
    } else {
        //daytime> MO-FR at 07:00–22:00
        return s.elektrilevi.dayRate;
    }
}
/*
delete all the old schedulers created by this script. 
*/
function delSc(s) {
    if (cntr < 6 - _.rpcCl) {
        for (let i = 0; i < _.rpcCl && i < s.length; i++) {
            let id = s.splice(0, 1)[0];
            cntr++;
            Shelly.call("Schedule.Delete", { id: id },
                function (res, err, msg, data) {
                    if (err !== 0) {
                        print(_.pId, "Schedule ", data.id, " delete FAILED.");
                    } else {
                        print(_.pId, "Schedule ", data.id, " delete SUCCEEDED.");
                    }
                    cntr--;
                },
                { id: id }
            );
        }
    }
    //if there are more calls in the queue
    if (s.length > 0) {
        Timer.set(1000, false, function () { delSc(s); });
    } else {
        // create schedulers
        listScheds(_.newSchedules);
        _.newScheds = null; //clear memory
    }
}

/**
Get all the existing schedulers to check duplications
 */
function listScheds(newScheds) {
    //wait until all the schedulers are deleted
    if (cntr !== 0) {
        Timer.set(1000, false, function () { listScheds(newScheds); });
        return;
    }

    Shelly.call("Schedule.List", {},
        function (res, err, msg, data) {
            if (res === 0) {
                // No existing schedulers found
                createScheds([], data.s);
            } else {
                // Found existing schedulers
                createScheds(res.jobs, data.s);
                res = null; //to save memory
            }
        }, { s: newScheds }
    );
    newScheds = null; //clear memory
}

/**
Create all schedulers, the Shelly limit is 20.
 */
function createScheds(listScheds, newScheds) {
    //logic below is a non-blocking method for RPC calls to create all schedulers one by one
    if (cntr < 6 - _.rpcCl) {
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
                cntr++;
                Shelly.call("Schedule.Create", {
                    enable: true, timespec: timespec,
                    calls: [{
                        method: "Switch.Set",
                        params: {
                            id: s.relayID,
                            on: !s.isOutputInverted
                        }
                    }]
                },
                    function (res, err, msg, data) {
                        if (err !== 0) {
                            print(_.pId, "#" + data.ctPeriod, "Scheduler at: ", data.hour + ":00 price: ", data.price, " EUR/MWh (energy price + transmission). FAILED, 20 schedulers is the Shelly limit.");
                        } else {
                            print(_.pId, "#" + data.ctPeriod, "Scheduler starts at: ", data.hour + ":00 price: ", data.price, " EUR/MWh (energy price + transmission). ID:", res.id, " SUCCESS");
                            _.schedId.push(res.id); //create an array of scheduleIDs
                        }
                        cntr--;
                    },
                    { hour: hour, price: price, ctPeriod: ctPeriod }
                );
            }
        }
    }

    //if there are more calls in the queue
    if (newScheds.length > 0) {
        Timer.set(1000, false, function () { createScheds(listScheds, newScheds); });
    } else {
        listScheds = null; //clear memory
        setKVS();
    }
}

/**
Storing the scheduler IDs in KVS to not loose them in case of power outage
 */
function setKVS() {
    //wait until all the schedulerIDs are collected
    if (cntr !== 0) {
        Timer.set(1000, false, setKVS);
        return;
    }
    //schedulers are created, store the IDs to KVS
    Shelly.call("KVS.set", { key: "version" + _.sId, value: _.version });
    Shelly.call("KVS.set", { key: "lastcalculation" + _.sId, value: new Date().toString() });
    Shelly.call("KVS.set", { key: "schedulerIDs" + _.sId, value: JSON.stringify(_.schedId) },
        function () {
            print(_.pId, "Script v", _.version, " created all the schedules, next heating calculation at", nextChkHr(1) + (_.updtDelay < 10 ? ":0" : ":") + _.updtDelay);
            _.rpcBlock--; //release RPC calls for watchdog
            _.loopRunning = false;
        });
    _.schedId = [];
}

/**
Set countdown timer to flip Shelly status
 */
function setShellyTimer(isOutInv, timerMin) {
    let is_on = isOutInv ? "on" : "off";
    let timerSec = timerMin * 60 + 2; //time in seconds, +2sec to remove flap between continous heating hours
    print(_.pId, "Set Shelly auto " + is_on + " timer for ", timerMin, " minutes.");
    Shelly.call("Switch.SetConfig", {
        id: s.relayID,
        config: {
            auto_on: isOutInv,
            auto_on_delay: timerSec,
            auto_off: !isOutInv,
            auto_off_delay: timerSec
        }
    });
}

//if the internet is not working or Elering is down
function setShellyManualMode() {
    if (_.isSchedCreatedManually) {
        return;
    }
    _.isSchedCreatedManually = true;
    setShellyTimer(s.isOutputInverted, s.defaultTimer); //set default timer

    // create schedules for the historical cheap hours manually
    // allow heating only outside of peak periods 0-8, 12-15, 20-23
    let newScheds = [];
    const cheapHoursDay = [0, 12, 1, 13, 2, 14, 3, 15, 4, 20, 5, 21, 6, 22, 7, 23, 8];
    const heatingHours = s.heatingMode.heatingTime * _.ctPeriods <= 17 ? s.heatingMode.heatingTime * _.ctPeriods : 17; //finds max hours to heat in 24h period 

    for (let i = 0; i < heatingHours; i++) {
        newScheds.push([cheapHoursDay[i], "no prices", 1]);
    }
    _.newSchedules = sort(newScheds, 0);
    newScheds = null; //clear memory
    delSc(_.existingSchedules);
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
            } else if (array[k][sortby] < min) {
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
        } else {
            tmp = array[j];
            array.splice(j, 1, array[max_indx]);
            array.splice(max_indx, 1, tmp);
        }
        j--;
    }
    return array;
}
/**
 * Handle errors by logging and setting manual mode.
 */
function handleError(manualModeReason) {
    print(_.pId, "# Internet error, using historical cheap hours because ", manualModeReason);
    setShellyManualMode();
    _.loopRunning = false;
}

function epoch() {
    return Math.floor(Date.now() / 1000.0);
}
/* Next hour for heating calculation */
function nextChkHr(addHr) {
    let chkT = s.heatingMode.isFcstUsed ? s.heatingMode.timePeriod : 24;
    let hr = (Math.ceil((new Date(Date.now() + (addHr * 60 * 60 * 1000)).getHours() + 1) / chkT) * chkT) - 1;
    return hr > 23 ? 23 : hr;
}
/**
Getting prices or forecast for today if 
    * prices or forecast have never been fetched OR 
    * prices or forecast are not from today or yesterday OR 
    * prices or forecast needs regular update
 */
function isUpdtReq(ts) {
    let nextHour = nextChkHr(0);
    let now = new Date();
    let yestDt = new Date(now - _.dayInSec * 1000);
    let tsDt = new Date(ts * 1000);
    let isToday = tsDt.getFullYear() === now.getFullYear() && tsDt.getMonth() === now.getMonth() && tsDt.getDate() === now.getDate();
    let isYesterday = tsDt.getFullYear() === yestDt.getFullYear() && tsDt.getMonth() === yestDt.getMonth() && tsDt.getDate() === yestDt.getDate();
    let isTsAfterChkT = tsDt.getHours() === nextHour && isToday;
    let isChkT = now.getHours() === nextHour && now.getMinutes() >= _.updtDelay;
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
    if ((isUpdtReq(_.tsPrices) || s.heatingMode.isFcstUsed && isUpdtReq(_.tsFcst))) {
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
    } else {
        //waiting timeserver response
        return;
    }
}
//execute the checkShellyTime when the script starts
checkShellyTime();
//start 1 sec loop-timer to check Shelly time 
//if Shelly has already time, then this timer will be closed immediately
timer_handle = Timer.set(1000, true, checkShellyTime);

//start the loop component
Timer.set(_.loopFreq * 1000, true, loop);


/*  ---------  WATCHDOG START  ---------   */
/** This is the watchdog script code */
let watchdog = 'let _={sId:0,mc:3,ct:0};function start(e){Shelly.call("KVS.Get",{key:"schedulerIDs"+e},(function(e,l,t,c){if(e){let l=[];l=JSON.parse(e.value),e=null,delSc(l,c.sId)}}),{sId:e})}function delSc(e,l){if(_.ct<6-_.mc)for(let t=0;t<_.mc&&t<e.length;t++){let t=e.splice(0,1)[0];_.ct++,Shelly.call("Schedule.Delete",{id:t},(function(e,t,c,i){0!==t?print("Script #"+l,"schedule ",i.id," del FAIL."):print("Script #"+l,"schedule ",i.id," del OK."),_.ct--}),{id:t})}e.length>0?Timer.set(1e3,!1,(function(){delSc(e,l)})):delKVS(l)}function delKVS(e){0===_.ct?(Shelly.call("KVS.Delete",{key:"schedulerIDs"+e}),print("Heating script #"+e,"is clean")):Timer.set(1e3,!1,(function(){delKVS(e)}))}Shelly.addStatusHandler((function(e){"script"!==e.name||e.delta.running||(_.sId=e.delta.id,start(_.sId))}));'
/** find watchdog script ID */
function createWatchdog() {
    //waiting other RPC calls to be completed
    if (_.rpcBlock !== 0) {
        Timer.set(1000, false, createWatchdog);
        return;
    }
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
    } else {
        Shelly.call('Script.Stop', { id: id }, putCode, { id: id });
    }
}
/** Add code to the watchdog script */
function putCode(res, err, msg, data) {
    if (err === 0) {
        let scId = res.id > 0 ? res.id : data.id;
        Shelly.call('Script.PutCode', { id: scId, code: watchdog }, startScript, { id: scId });
    } else {
        print(_.pId, "Watchdog script creation failed.", msg, ". Schedules are not deleted if heating script is stopped or deleted.");
    }
}
/** Enable autostart and start the watchdog script */
function startScript(res, err, msg, data) {
    if (err === 0) {
        enableAutoStart(data.id);
        startWatchdogScript(data.id);
    } else {
        print(_.pId, "Adding code to the script is failed.", msg, ". Schedules are not deleted if heating script is stopped or deleted.")
    }
}

/** Enable autostart for the watchdog script */
function enableAutoStart(scriptId) {
    if (!Shelly.getComponentConfig("script", scriptId).enable) {
        Shelly.call('Script.SetConfig', { id: scriptId, config: { enable: true } }, function (res, err, msg, data) {
            if (err !== 0) {
                print(_.pId, "Watchdog script autostart is not enabled.", msg, ". After Shelly restart, this script will not start and schedules are not deleted if heating script is stopped or deleted.");
            }
        });
    }
}

/** Start the watchdog script */
function startWatchdogScript(scriptId) {
    Shelly.call('Script.Start', { id: scriptId }, function (res, err, msg, data) {
        if (err === 0) {
            print(_.pId, "Watchdog script created and started successfully.");
        } else {
            print(_.pId, "Watchdog script is not started.", msg, ". Schedules are not deleted if heating script is stopped or deleted.");
        }
    });
}
/*  ---------  WATCHDOG END  ---------   */

createWatchdog();
loop();

