/*
Created by Leivo Sepp, 2024-2025
Licensed under the MIT License
https://github.com/LeivoSepp/Smart-heating-management-with-Shelly

This Shelly script is designed to retrieve energy market prices from Elering and
activate heating during the most cost-effective hours each day, employing various algorithms. 

1. Dynamic calculation of heating time for the next day based on weather forecasts.
2. Division of heating into time periods, with activation during the cheapest hour within each period.
3. Utilization of min-max price levels to maintain the Shelly system consistently on or off.
The script executes daily after 23:00 to establish heating timeslots for the following day.
*/

/* Electricity transmission fees (EUR/MWh)
Elektrilevi https://elektrilevi.ee/en/vorguleping/vorgupaketid/eramu 
Imatra https://imatraelekter.ee/vorguteenus/vorguteenuse-hinnakirjad/
*/
const VORK1 = { dayRate: 77.2, nightRate: 77.2, dayMaxRate: 77.2, holidayMaxRate: 77.2 };
const VORK2 = { dayRate: 60.7, nightRate: 35.1, dayMaxRate: 60.7, holidayMaxRate: 35.1 };
const VORK4 = { dayRate: 36.9, nightRate: 21, dayMaxRate: 36.9, holidayMaxRate: 21 };
const VORK5 = { dayRate: 52.9, nightRate: 30.3, dayMaxRate: 81.8, holidayMaxRate: 47.4 };
const Partner24 = { dayRate: 60.7, nightRate: 60.7, dayMaxRate: 60.7, holidayMaxRate: 60.7 };
const Partner24Plus = { dayRate: 38.6, nightRate: 38.6, dayMaxRate: 38.6, holidayMaxRate: 38.6 };
const Partner12 = { dayRate: 72.4, nightRate: 42, dayMaxRate: 72.4, holidayMaxRate: 42 };
const Partner12Plus = { dayRate: 46.4, nightRate: 27.1, dayMaxRate: 46.4, holidayMaxRate: 27.1 };
const NONE = { dayRate: 0, nightRate: 0, dayMaxRate: 0, holidayMaxRate: 0 };

/****** PROGRAM INITIAL SETTINGS ******/
/* 
After the initial run, all user settings are stored in the Shelly 1) KVS or 2) Virtual components (in case virtual components are supported).
To modify these user settings later, you’ll need to access the Shelly KVS via: Menu → Advanced → KVS on the Shelly web page.
Once you’ve updated the settings, restart the script to apply the changes or wait for the next scheduled run.
If the Shelly supports Virtual components, the script will automatically create them and store the settings there.
This allows you to modify the heating settings directly from the Shelly web page or Shelly mobile app.
Updating script code is easy, you only need to copy-paste new code as all the settings are pulled from the KVS or Virtual components.

heatingMode.timePeriod: Heating Period is the time during which heating time is calculated. (0 -> only min-max price used, 24 -> period is one day).
heatingMode.heatingTime: Heating Time is the duration of the cheapest hours within a Heating Period when the heating system is activated. or duration of heating in a day in case of internet connection failure.
heatingMode.isFcstUsed: true/false - Using weather forecast to calculate heating duration.
*/
let s = {
    heatingMode: { timePeriod: 24, heatingTime: 10, isFcstUsed: false }, // HEATING MODE. Different heating modes described above.
    elektrilevi: "VORK2",      // ELEKTRILEVI/IMATRA transmission fee: VORK1 / VORK2 / VORK4 /VORK5 / Partner24 / Partner24Plus / Partner12 / Partner12Plus / NONE
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
    rpcBlock: 2, //block createSchedule and createWatchdog functions
    schedId: '',
    newSchedules: [],
    isSchedCreatedManually: false,
    existingSchedules: '',
    networkProvider: "None",
    oldVersion: 0,
    version: 3.9,
};
let cntr = 0;

const virtualComponents = [
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
            max: 24,
            persisted: true,
            meta: { ui: { view: "slider", unit: "h/period" } }
        }
    },
    {
        type: "enum", id: 201, config: {
            name: "Network Package",
            options: ["NONE", "VORK1", "VORK2", "VORK4", "VORK5", "Partner24", "Partner24Plus", "Partner12", "Partner12Plus"],
            default_value: "VORK2",
            persisted: true,
            meta: { ui: { view: "dropdown", webIcon: 22, titles: { "NONE": "No package", "VORK1": "Võrk1 Base", "VORK2": "Võrk2 DayNight", "VORK4": "Võrk4 DayNight", "VORK5": "Võrk5 DayNightPeak", "Partner24": "Partner24 Base", "Partner24Plus": "Partner24Plus Base", "Partner12": "Partner12 DayNight", "Partner12Plus": "Partner12Plus DayNight" } } }
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
            min: -6,
            max: 6,
            persisted: true,
            meta: { ui: { view: "slider", unit: "h more heat" } }
        }
    },
];

function start() {
    setAutoStart();
    setKvsScrLibr();
    getKvsData();
    createSchedule();
}
/* set the script to sart automatically on boot */
function setAutoStart() {
    if (!Shelly.getComponentConfig("script", _.sId).enable) {
        Shelly.call('Script.SetConfig', { id: _.sId, config: { enable: true } },
            function (res, err, msg, data) {
                if (err != 0) {
                    console.log(_.pId, "Heating script autostart is not enabled.", msg, ". After Shelly restart, this script will not start and new heating schedules are not created.");
                }
            });
    }
}
/* set the default script library */
function setKvsScrLibr() {
    Shelly.call("KVS.set", { key: "scripts-library", value: '{"url": "https://raw.githubusercontent.com/LeivoSepp/Smart-heating-management-with-Shelly/master/manifest.json"}' });
}
// check if Shelly supports Virtual components
function isVirtualComponentsAvailable() {
    const info = Shelly.getDeviceInfo();
    return (info.gen === 3 || (info.gen === 2 && info.app.substring(0, 3) == "Pro")) && isNewerVersion('1.4.3', info.ver);
}
// compare versions
function isNewerVersion(oldVer, newVer) {
    const oldParts = oldVer.split('.')
    const newParts = newVer.split('.')
    for (var i = 0; i < newParts.length; i++) {
        let a = ~~newParts[i] // parse int
        let b = ~~oldParts[i] // parse int
        if (a > b) return true
        if (a < b) return false
    }
    return false
}

function getKvsData() {
    Shelly.call('KVS.GetMany', null, processKVSData);
}
function processKVSData(res, err, msg, data) {
    let kvsData;
    if (res) {
        kvsData = res.items;
        res = null;
    }
    //store scheduler ID to memory
    _.existingSchedules = typeof kvsData["schedulerIDs" + _.sId] !== "undefined" && typeof JSON.parse(kvsData["schedulerIDs" + _.sId].value) === "number" ? JSON.parse(kvsData["schedulerIDs" + _.sId].value) : '';
    //old version number is used to maintain backward compatibility
    _.oldVersion = (kvsData["version" + _.sId] != null && typeof JSON.parse(kvsData["version" + _.sId].value) === "number") ? JSON.parse(kvsData["version" + _.sId].value) : 0;

    if (isVirtualComponentsAvailable()) {
        let userConfig = [];
        //create an array from the user settings to delete them from KVS
        for (let i in s) userConfig.push(i + _.sId);

        if (_.oldVersion <= 3.2) {
            console.log(_.pId, "New virtual component installation.");
            deleteAllKvs(userConfig);
        } else if (_.oldVersion === 3.3) {
            console.log(_.pId, "Upgrading from KVS to Virtual components.");
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
        } else {
            console.log(_.pId, "Script in Virtual components mode.");
            readAllVirtualComponents();
        }
    } else { // this is the KVS path if Shelly doesn't support Virtual components
        console.log(_.pId, "Script in KVS mode.");
        let isExistInKvs = false;
        let userCongfigNotInKvs = [];
        //iterate settings and then KVS
        for (var k in s) {
            for (var i in kvsData) {
                //check if settings found in KVS
                if (i == k + _.sId) {
                    if (k == "elektrilevi" || k == "country") {
                        if (_.oldVersion >= 3.2) {
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
        storeSettingsKvs(userCongfigNotInKvs);
    }
}
function storeSettingsKvs(userCongfigNotInKvs) {
    if (cntr < 6 - _.rpcCl) {
        for (let i = 0; i < _.rpcCl && i < userCongfigNotInKvs.length; i++) {
            let value = userCongfigNotInKvs[0][1];
            let key = userCongfigNotInKvs.splice(0, 1)[0][0] + _.sId;
            cntr++;
            Shelly.call("KVS.set", { key: key, value: value },
                function (res, err, msg, data) {
                    if (err !== 0) {
                        console.log(_.pId, "Store settings", data.key, data.value, "in KVS failed.");
                    } else {
                        console.log(_.pId, "Store settings", data.key, data.value, "to KVS is OK");
                    }
                    cntr--;
                },
                { key: key, value: value }
            );
        }
    }
    if (userCongfigNotInKvs.length > 0) {
        Timer.set(1000, false, storeSettingsKvs, userCongfigNotInKvs);
    } else {
        waitForRpcCalls(main);
    }
}

// Only in case of Virtual Components: delete user config from KVS store as all the config moved to Virtual components
function deleteAllKvs(userConfig) {
    if (cntr < 6 - _.rpcCl) {
        for (let i = 0; i < _.rpcCl && i < userConfig.length; i++) {
            let key = userConfig.splice(0, 1)[0];
            cntr++;
            Shelly.call("KVS.Delete", { key: key },
                function (res, err, msg, data) {
                    if (err === 0) {
                        console.log(_.pId, "Deleted " + data.key + " from KVS store");
                    } else {
                        console.log(_.pId, "Failed to delete " + data.key + " from KVS store. Error: " + msg);
                    }
                    cntr--;
                },
                { key: key }
            );
        }
    }
    if (userConfig.length > 0) {
        Timer.set(1000, false, deleteAllKvs, userConfig);
    } else {
        waitForRpcCalls(getAllVirtualComponents);
    }
}

// Function to get all virtual components and delete them all before creating new
function getAllVirtualComponents() {
    Shelly.call("Shelly.GetComponents", { dynamic_only: true, include: ["status"] }, checkComponents);
}
function checkComponents(res, err, msg, data) {
    if (err === 0) {
        if (res.components && res.components.length > 0) {
            deleteVirtualComponents(res.components);
        } else {
            addVirtualComponent(virtualComponents);
        }
    } else {
        console.log(_.pId, "Failed to get virtual components. Error: " + msg);
    }
}
// Function to delete all virtual components
function deleteVirtualComponents(vComponents) {
    if (cntr < 6 - _.rpcCl) {
        for (let i = 0; i < _.rpcCl && i < vComponents.length; i++) {
            let key = vComponents.splice(0, 1)[0].key;
            cntr++;
            Shelly.call("Virtual.Delete", { key: key },
                function (res, err, msg, data) {
                    if (err === 0) {
                        console.log(_.pId, "Deleted " + data.key + " virtual component");
                    } else {
                        console.log(_.pId, "Failed to delete " + data.key + " virtual component. Error: " + msg);
                    }
                    cntr--;
                },
                { key: key }
            );
        }
    }
    if (vComponents.length > 0) {
        Timer.set(1000, false, deleteVirtualComponents, vComponents);
    } else {
        waitForRpcCalls([addVirtualComponent, virtualComponents]);
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
                function (res, err, msg, data) {
                    if (err === 0) {
                        console.log(_.pId, "Added virtual component: " + data.type + ":" + data.id);
                    } else {
                        console.log(_.pId, "Failed to add virtual component: " + data.type + ":" + data.id + ". Error: " + msg);
                    }
                    cntr--;
                },
                { type: type, id: id, config: config }
            );
        }
    }
    if (virtualComponents.length > 0) {
        Timer.set(1000, false, addVirtualComponent, virtualComponents);
    } else {
        waitForRpcCalls(setGroupConfig);
    }
}

// add virtual components to group
function setGroupConfig() {
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
    Shelly.call("Group.Set", groupConfig, function (res, err, msg, data) {
        if (err !== 0) {
            console.log(_.pId, "Failed to set group config. Error: " + msg);
        }
    });
    readAllVirtualComponents();
}

function readAllVirtualComponents() {
    //this is for adding Imatra packages during the upgrade to 3.7
    if (_.oldVersion < 3.7 && _.oldVersion >= 3.4) {
        Shelly.call("Enum.SetConfig", virtualComponents[3], function (res, err, msg, data) {
            if (err !== 0) {
                console.log(_.pId, "Failed to set enum config. Error: " + msg);
            }
        });
    }
    //this function reads all virtual components and stores the values to memory
    Shelly.call("Shelly.GetComponents", { dynamic_only: true, include: ["status"] }, processComponents);
}
function processComponents(res, err, msg, data) {
    if (err === 0) {
        const components = res.components;
        res = null;
        if (components && components.length > 0) {
            for (let i in components) {
                switch (components[i].key) {
                    case "enum:200":
                        s.heatingMode.timePeriod = JSON.parse(components[i].status.value);
                        break;
                    case "number:200":
                        s.heatingMode.heatingTime = JSON.parse(components[i].status.value);
                        break;
                    case "boolean:200":
                        s.heatingMode.isFcstUsed = JSON.parse(components[i].status.value);
                        break;
                    case "enum:201":
                        s.elektrilevi = components[i].status.value;
                        break;
                    case "number:201":
                        s.alwaysOnLowPrice = JSON.parse(components[i].status.value);
                        break;
                    case "number:202":
                        s.alwaysOffHighPrice = JSON.parse(components[i].status.value);
                        break;
                    case "boolean:201":
                        s.isOutputInverted = JSON.parse(components[i].status.value);
                        break;
                    case "enum:202":
                        s.country = components[i].status.value;
                        break;
                    case "number:203":
                        s.heatingCurve = JSON.parse(components[i].status.value);
                        break;
                    default:
                        break;
                }
            }
            waitForRpcCalls(main);
        } else {
            console.log(_.pId, "No virtual components found.");
        }
    } else {
        console.log(_.pId, "Failed to get virtual components. Error: " + msg);
    }
}
/**
This is the main script where all the logic starts.
*/
function main() {
    // Calculate the number of periods
    _.ctPeriods = s.heatingMode.timePeriod <= 0 ? 0 : Math.ceil((24 * 100) / (s.heatingMode.timePeriod * 100));
    //check if Shelly has time
    if (!isShellyTimeOk) {
        handleError("Shelly has no time.");
        return;
    }
    if (s.elektrilevi.substring(0, 4) == "VORK") {
        _.networkProvider = "Elektrilevi";
    } else if (s.elektrilevi.substring(0, 4) == "Part") {
        _.networkProvider = "Imatra";
    }
    console.log(_.pId, "Network provider: ", _.networkProvider, s.elektrilevi);

    console.log(_.pId, "Shelly ", new Date(Shelly.getComponentStatus("sys").unixtime * 1000));

    _.heatTime = s.heatingMode.heatingTime;
    // If weather forecast is used for heating hours
    if (s.heatingMode.isFcstUsed && s.heatingMode.timePeriod > 0) {
        getForecast();
    } else {
        getElering();
    }
}
/**
Get Open-Meteo min and max "feels like" temperatures
 */
function getForecast() {
    const lat = JSON.stringify(Shelly.getComponentConfig("sys").location.lat);
    const lon = JSON.stringify(Shelly.getComponentConfig("sys").location.lon);
    const omUrl = _.openMeteo + s.heatingMode.timePeriod + "&latitude=" + lat + "&longitude=" + lon;
    console.log(_.pId, "Forecast query: ", omUrl)
    try {
        Shelly.call("HTTP.GET", { url: omUrl, timeout: 5, ssl_ca: "*" }, fcstCalc);
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
        const jsonFcst = JSON.parse(res.body); //open-meteo json response
        const aTemp = jsonFcst["hourly"]["apparent_temperature"]; //get 6h, 12h or 24h temperatures
        let sumFcst = 0;
        for (let i = 0; i < aTemp.length; i++) {
            sumFcst += aTemp[i];
        }
        res = null;

        const tempFcst = Math.ceil(sumFcst / s.heatingMode.timePeriod); //AVG and round temperature up
        _.tsFcst = epoch();  //store the timestamp into memory
        console.log(_.pId, "We got weather forecast from Open Meteo at ", new Date().toString());

        // calculating heating hours
        const startTemp = 16;
        let fcstHeatTime = ((startTemp - tempFcst) * (s.powerFactor - 1) + (startTemp - tempFcst + s.heatingCurve * 2 - 2));
        fcstHeatTime = fcstHeatTime < 0 || tempFcst > startTemp ? 0 : fcstHeatTime; //heating time can't be negative
        _.heatTime = Math.floor(fcstHeatTime / _.ctPeriods); //divide with periods and round-down heating duration
        _.heatTime = _.heatTime > s.heatingMode.timePeriod ? s.heatingMode.timePeriod : _.heatTime; //heating time can't be more than period

        console.log(_.pId, "Temperture forecast width windchill is ", tempFcst, " °C, and heating enabled for ", _.heatTime, " hours.");

        getElering(); //call elering
    } catch (error) {
        handleError("Get forecast JSON error," + error + "check again in " + _.loopFreq / 60 + " min.");
    }
}
/* Get electricity market price CSV file from Elering.  */
function getElering() {
    const tzInSec = getShellyTimezone();
    // Determine the date range for Elering query
    const dtRange = getEleringDateRange(tzInSec);
    // Build Elering URL
    const elUrl = buildEleringUrl(dtRange[0], dtRange[1]);

    console.log(_.pId, "Elering query: ", elUrl);
    try {
        Shelly.call("HTTP.GET", { url: elUrl, timeout: 5, ssl_ca: "*" }, priceCalc);
    } catch (error) {
        handleError("Elering HTTP.GET error" + error + "check again in " + _.loopFreq / 60 + " min.");
    }
}
function getShellyTimezone() {
    const shEpochUtc = Shelly.getComponentStatus("sys").unixtime;
    const shDt = new Date(shEpochUtc * 1000);
    const shHr = shDt.getHours();
    const shUtcHr = shDt.toISOString().slice(11, 13);
    let tz = shHr - shUtcHr;
    if (tz > 12) { tz -= 24; }
    if (tz < -12) { tz += 24; }
    return tz * 60 * 60;
}
function getEleringDateRange(tzInSec) {
    const shEpochUtc = Shelly.getComponentStatus("sys").unixtime;
    const shHr = new Date(shEpochUtc * 1000).getHours();
    // After 23:00 tomorrow's energy prices are used
    // before 23:00 today's energy prices are used.
    const addDays = shHr >= 23 ? 0 : -1;
    const isoTime = new Date((shEpochUtc + tzInSec + _.dayInSec * addDays) * 1000).toISOString().slice(0, 10);
    const isoTimePlusDay = new Date((shEpochUtc + tzInSec + (_.dayInSec * (addDays + 1))) * 1000).toISOString().slice(0, 10);
    const dtStart = isoTime + "T" + (24 - tzInSec / 3600) + ":00Z";
    const dtEnd = isoTimePlusDay + "T" + (24 - tzInSec / 3600 - 1) + ":00Z";
    return [dtStart, dtEnd];
}
function buildEleringUrl(dtStart, dtEnd) {
    return _.elering + s.country + "&start=" + dtStart + "&end=" + dtEnd;
}

/**
Price calculation logic.
Creating time periods etc.
*/
function priceCalc(res, err, msg) {
    if (err != 0 || res === null || res.code != 200 || !res.body_b64) {
        handleError("Elering HTTP.GET, check again in " + _.loopFreq / 60 + " min.");
        return;
    }
    //convert the elektrilevi packet value to variable
    s.elektrilevi = eval(s.elektrilevi);

    // Convert base64 to text and discard header
    res.body_b64 = atob(res.body_b64);
    const csvData = res.body_b64.substring(res.body_b64.indexOf("\n") + 1);
    res = null; //clear memory
    const eleringPrices = parseEleringPrices(csvData);
    //if elering API returns less than 23 rows, the script will try to download the data again after set of minutes
    if (eleringPrices.length < 24) {
        handleError("Elering API didn't return prices, check again in " + _.loopFreq / 60 + " min.");
        return;
    }
    //store the timestamp into memory
    _.tsPrices = epoch();
    console.log(_.pId, "We got market prices from Elering ", new Date().toString());

    //calculate schedules
    _.newSchedules = [];
    if (s.heatingMode.timePeriod <= 0) {
        _.newSchedules = calculateAlwaysOnLowPriceSchedules(eleringPrices);
    } else {
        _.newSchedules = calculateHeatingPeriods(eleringPrices);
    }
    _.isSchedCreatedManually = false;
    setShellyTimer(s.isOutputInverted, s.defaultTimer); //set default timer
    deleteSchedule();
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
 * Calculate schedules based on alwaysOnLowPrice.
 */
function calculateAlwaysOnLowPriceSchedules(eleringPrices) {
    let newScheds = [];
    for (let a = 0; a < eleringPrices.length; a++) {
        let transferFee = calculateTransferFees(eleringPrices[a][0]);
        if (eleringPrices[a][1] - transferFee < s.alwaysOnLowPrice) {
            newScheds.push([new Date(eleringPrices[a][0] * 1000).getHours(), eleringPrices[a][1]]);
            console.log(_.pId, "Energy price ", eleringPrices[a][1] - transferFee, " EUR/MWh at ", new Date(eleringPrices[a][0] * 1000).getHours() + ":00 is less than min price and used for heating.");
        }
    }
    if (!newScheds.length) {
        console.log(_.pId, "No energy prices below min price level. No heating.");
    }
    return newScheds;
}
/**
 * Calculate schedules based on heating time.
 */
function calculateHeatingPeriods(eleringPrices) {
    let period = [];
    let sortedPeriod = [];
    let newScheds = [];

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
                newScheds.push([new Date((sortedPeriod[a][0]) * 1000).getHours(), sortedPeriod[a][1]]);
            }

            //If some hours are too expensive to use for heating, then just let user know for this
            if (a < heatingHours && sortedPeriod[a][1] - transferFee > s.alwaysOffHighPrice) {
                console.log(_.pId, "Energy price ", sortedPeriod[a][1] - transferFee, " EUR/MWh at ", new Date((sortedPeriod[a][0]) * 1000).getHours() + ":00 is more expensive than max price and not used for heating.")
            }
        }
    }
    if (!newScheds.length) {
        console.log(_.pId, "Current configuration does not permit heating during any hours; it is likely that the alwaysOffHighPrice value is set too low.")
    }
    return newScheds;
}
/**
 * Calculate transfer fees based on the timestamp.
 */
function calculateTransferFees(epoch) {
    if (_.networkProvider === "Elektrilevi") {
        return calculateElektrileviTransferFees(epoch);
    } else if (_.networkProvider === "Imatra") {
        return calculateImatraTransferFees(epoch);
    } else {
        return 0;
    }
}
function calculateElektrileviTransferFees(epoch) {
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
        //daytime: MO-FR at 07:00–22:00
        return s.elektrilevi.dayRate;
    }
}
function isSummerTime() {
    return getShellyTimezone() / 60 / 60 === 3;
}
function calculateImatraTransferFees(epoch) {
    const hour = new Date(epoch * 1000).getHours();
    const day = new Date(epoch * 1000).getDay();
    if (isSummerTime()) {
        if (hour < 8 || day === 6 || day === 0) {
            //summer-night-time: MO-FR at 00:00–08:00, SA-SU all day
            return s.elektrilevi.nightRate;
        } else {
            //daytime: MO-FR at 08:00–24:00
            return s.elektrilevi.dayRate;
        }
    } else {
        if (hour < 7 || hour >= 23 || day === 6 || day === 0) {
            //winter-night-time: MO-FR at 23:00–07:00, SA-SU all day
            return s.elektrilevi.nightRate;
        } else {
            //daytime> MO-FR at 07:00–23:00
            return s.elektrilevi.dayRate;
        }
    }
}
/**
Set countdown timer to flip Shelly status
 */
function setShellyTimer(isOutInv, timerMin) {
    const is_on = isOutInv ? "on" : "off";
    const timerSec = timerMin * 60 + 2; //time in seconds, +2sec to remove flap between continous heating hours
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
// delete the schedule if it exists
function deleteSchedule() {
    const id = _.existingSchedules;
    if (id !== "") {
        Shelly.call("Schedule.Delete", { id: id });
    }
    _.rpcBlock = 1; //release block for createSchedule
}

// Create a new schedule with the advanced timespec to cover all the hours within the same schedule item
function createSchedule() {
    //waiting RPC calls to be completed
    if (_.rpcBlock !== 1) {
        Timer.set(500, false, createSchedule);
        return;
    }
    let sortedSched = sort(_.newSchedules, 0);
    _.schedId = null;
    let hoursArr = [];
    let hourPricesArr = [];
    for (let i = 0; i < sortedSched.length; i++) {
        let hr = sortedSched[i][0];
        hoursArr.push(hr);
        let t = hr < 10 ? "0" + hr : hr;
        hourPricesArr.push(t + ":00 (" + sortedSched[i][1] + ")");
    }
    const hours = hoursArr.join(","); //create timespec
    const prices = hourPricesArr.join(", "); //create hours (prices) only for console.log

    Shelly.call("Schedule.Create", {
        enable: true,
        timespec: "0 0 " + hours + " * * *",
        calls: [{
            method: "Switch.Set",
            params: {
                id: s.relayID,
                on: !s.isOutputInverted
            }
        }]
    }, processSchedule, { hours: hours, prices: prices });
}
function processSchedule(res, err, msg, data) {
    if (err !== 0) {
        console.log(_.pId, "Scheduler for hours: ", data.hours, " FAILED.");
    } else {
        console.log(_.pId, "Heating will be turned on to following hours 'HH:mm (EUR/MWh Energy Price + Transmission)': ", data.prices);
        _.schedId = res.id; //last scheduleID
        setKVS();
    }
}

/**
Storing the scheduler IDs in KVS to not loose them in case of power outage
 */
function setKVS() {
    //schedulers are created, store the IDs to KVS
    Shelly.call("KVS.set", { key: "version" + _.sId, value: _.version });
    Shelly.call("KVS.set", { key: "lastcalculation" + _.sId, value: new Date().toString() });
    Shelly.call("KVS.set", { key: "schedulerIDs" + _.sId, value: JSON.stringify(_.schedId) },
        function () {
            console.log(_.pId, "Script v", _.version, " created a schedule with ID:" + _.schedId + ", next heating calculation at", nextChkHr(1) + (_.updtDelay < 10 ? ":0" : ":") + _.updtDelay);
            _.rpcBlock = 0; //release RPCcalls for watchdog
            createWatchdog();
        });
}

//if the internet is not working or Elering is down
function setShellyManualMode() {
    if (_.isSchedCreatedManually) {
        return;
    }
    _.isSchedCreatedManually = true;

    // create schedules for the historical cheap hours manually
    const cheapHoursDay = [0, 1, 2, 3, 4, 5, 6, 20, 21, 22, 23, 12, 13, 14, 15, 7, 8, 9, 10, 11, 16, 17, 18, 19];
    const heatingHours = s.heatingMode.heatingTime * _.ctPeriods <= 24 ? s.heatingMode.heatingTime * _.ctPeriods : 24; //finds max hours to heat in 24h period 

    _.newSchedules = [];
    for (let i = 0; i < heatingHours; i++) {
        _.newSchedules.push([cheapHoursDay[i], "no price"]);
    }
    setShellyTimer(s.isOutputInverted, s.defaultTimer); //set default timer
    deleteSchedule();
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
    console.log(_.pId, "# Internet error, using historical cheap hours because ", manualModeReason);
    setShellyManualMode();
    _.loopRunning = false;
}
/**
 * Wait for the RPC calls to be completed before starting next function.
 */
function waitForRpcCalls(userdata) {
    if (cntr !== 0) {
        //console.log("Shelly is waiting for ", cntr, " RPC call(s) to complete.");
        Timer.set(1000, false, waitForRpcCalls, userdata);
        return;
    }
    if (typeof userdata === "function") {
        userdata();
    } else {
        userdata[0](userdata[1]);
    }
}

function epoch() {
    return Math.floor(Date.now() / 1000.0);
}
/* Next hour for heating calculation */
function nextChkHr(addHr) {
    const chkT = s.heatingMode.isFcstUsed && s.heatingMode.timePeriod > 0 ? s.heatingMode.timePeriod : 24;
    const hr = (Math.ceil((new Date(Date.now() + (addHr * 60 * 60 * 1000)).getHours() + 1) / chkT) * chkT) - 1;
    return hr > 23 ? 23 : hr;
}
/**
Getting prices or forecast for today if 
    * prices or forecast have never been fetched OR 
    * prices or forecast are not from today or yesterday OR 
    * prices or forecast needs regular update
 */
function isUpdtReq(ts) {
    const nextHour = nextChkHr(0);
    const now = new Date();
    const yestDt = new Date(now - _.dayInSec * 1000);
    const tsDt = new Date(ts * 1000);
    const isToday = tsDt.getFullYear() === now.getFullYear() && tsDt.getMonth() === now.getMonth() && tsDt.getDate() === now.getDate();
    const isYesterday = tsDt.getFullYear() === yestDt.getFullYear() && tsDt.getMonth() === yestDt.getMonth() && tsDt.getDate() === yestDt.getDate();
    const isTsAfterChkT = tsDt.getHours() === nextHour && isToday;
    const isChkT = now.getHours() === nextHour && now.getMinutes() >= _.updtDelay;
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
    if (isUpdtReq(_.tsPrices) || s.heatingMode.isFcstUsed && isUpdtReq(_.tsFcst)) {
        start();
    } else {
        _.loopRunning = false;
    }
}

let isShellyTimeOk = false;
let timer_handle;
let time_counter = 0;
let loopNotStarted = true;

function checkShellyTime() {
    //check Shelly time
    const shEpochUtc = Shelly.getComponentStatus("sys").unixtime;
    if (shEpochUtc > 0) {
        //if time is OK, then stop the timer
        Timer.clear(timer_handle);
        isShellyTimeOk = true;
        loop(); //start the loop
    } else {
        time_counter++;
        print("Shelly has no time", time_counter, "seconds. We wait for the time to be set.");
        if (time_counter > 30 && loopNotStarted) {
            loop(); //start the loop with no time
            loopNotStarted = false;
        }
        //waiting timeserver response
        return;
    }
}

/*  ---------  WATCHDOG START  ---------   */
/** find watchdog script ID */
function createWatchdog() {
    //waiting other RPC calls to be completed
    if (_.rpcBlock !== 0) {
        Timer.set(500, false, createWatchdog);
        return;
    }
    Shelly.call('Script.List', null, scriptList);
}
function scriptList(res, err, msg, data) {
    if (res) {
        let wdId = 0;
        const s = res.scripts;
        res = null;
        for (let i = 0; i < s.length; i++) {
            if (s[i].name === "watchdog") {
                wdId = s[i].id;
                break;
            }
        }
        createScript(wdId);
    }
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
        const watchdog = 'let scId=0;function start(){Shelly.call("KVS.Get",{key:"schedulerIDs"+scId},(function(e,l,d,c){e&&delSc(JSON.parse(e.value))}))}function delSc(e){Shelly.call("Schedule.Delete",{id:e},(function(e,l,d,c){0!==l?print("Script #"+scId,"schedule ",c.id," deletion by watchdog failed."):print("Script #"+scId,"schedule ",c.id," deleted by watchdog."),delKVS()}),{id:e})}function delKVS(){Shelly.call("KVS.Delete",{key:"schedulerIDs"+scId})}Shelly.addStatusHandler((function(e){"script"!==e.name||e.delta.running||(scId=e.delta.id,start())}));'
        const scId = res.id > 0 ? res.id : data.id;
        Shelly.call('Script.PutCode', { id: scId, code: watchdog }, startScript, { id: scId });
    } else {
        console.log(_.pId, "Watchdog script creation failed.", msg, ". Schedules are not deleted if heating script is stopped or deleted.");
    }
}
/** Enable autostart and start the watchdog script */
function startScript(res, err, msg, data) {
    if (err === 0) {
        enableAutoStart(data.id);
        startWatchdogScript(data.id);
    } else {
        console.log(_.pId, "Adding code to the script is failed.", msg, ". Schedules are not deleted if heating script is stopped or deleted.")
    }
}

/** Enable autostart for the watchdog script */
function enableAutoStart(scriptId) {
    if (!Shelly.getComponentConfig("script", scriptId).enable) {
        Shelly.call('Script.SetConfig', { id: scriptId, config: { enable: true } }, function (res, err, msg, data) {
            if (err !== 0) {
                console.log(_.pId, "Watchdog script autostart is not enabled.", msg, ". After Shelly restart, this script will not start and schedules are not deleted if heating script is stopped or deleted.");
            }
        });
    }
}

/** Start the watchdog script */
function startWatchdogScript(scriptId) {
    Shelly.call('Script.Start', { id: scriptId }, function (res, err, msg, data) {
        if (err === 0) {
            console.log(_.pId, "Watchdog script created and started successfully.");
        } else {
            console.log(_.pId, "Watchdog script is not started.", msg, ". Schedules are not deleted if heating script is stopped or deleted.");
        }
    });
    _.loopRunning = false;
}
/*  ---------  WATCHDOG END  ---------   */

//start 1 sec loop-timer to check Shelly time during device boot
//if Shelly has already time, then this timer will be closed immediately
checkShellyTime();
timer_handle = Timer.set(1000, true, checkShellyTime);

//start the loop component
Timer.set(_.loopFreq * 1000, true, loop);