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

/* Electricity transmission fees (EUR/MWh) excluding VAT.
Elektrilevi https://elektrilevi.ee/en/vorguleping/vorgupaketid/eramu 
Imatra https://imatraelekter.ee/vorguteenus/vorguteenuse-hinnakirjad/
*/
function pack() {
    return {
        VORK1: { dRt: 77.2, nRt: 77.2, dMRt: 77.2, hMRt: 77.2 },
        VORK2: { dRt: 60.7, nRt: 35.1, dMRt: 60.7, hMRt: 35.1 },
        VORK4: { dRt: 36.9, nRt: 21, dMRt: 36.9, hMRt: 21 },
        VORK5: { dRt: 52.9, nRt: 30.3, dMRt: 81.8, hMRt: 47.4 },
        PARTN24: { dRt: 60.7, nRt: 60.7, dMRt: 60.7, hMRt: 60.7 },
        PARTN24PL: { dRt: 38.6, nRt: 38.6, dMRt: 38.6, hMRt: 38.6 },
        PARTN12: { dRt: 72.4, nRt: 42, dMRt: 72.4, hMRt: 42 },
        PARTN12PL: { dRt: 46.4, nRt: 27.1, dMRt: 46.4, hMRt: 27.1 },
        NONE: { dRt: 0, nRt: 0, dMRt: 0, hMRt: 0 },
    }
}
/****** INITIAL SETTINGS ******/
/* 
After the initial run, all user settings are stored in the Shelly 1) KVS or 2) Virtual components (in case virtual components are supported).
To modify user settings, you’ll need to access the Shelly KVS via: Menu → Advanced → KVS on the Shelly web page.
Once you’ve updated the settings, restart the script to apply the changes or wait for the next scheduled run.
 
timePeriod: Heating Period is the time during which heating time is calculated. (0 -> only min-max price used, 24 -> period is one day).
heatingTime: Heating Time is the duration of the cheapest hours within a Heating Period when the heating system is activated. or duration of heating in a day in case of internet connection failure.
isFcstUsed: true/false - Using weather forecast to calculate heating duration.
*/
let c = {
    tPer: 24,       // KVS:TimePeriod VC:Heating Period (h) 24/12/6/0
    hTim: 10,       // KVS:HeatingTime VC:Heating Time (h/period)
    isFc: false,    // KVS:IsForecastUsed VC:Forecast Heat
    pack: "VORK2",  // KVS:EnergyProvider VC:Network Package (NONE, VORK1, VORK2, VORK4, VORK5, PARTN24, PARTN24PL, PARTN12, PARTN12PL)
    lowR: 1,        // KVS:AlwaysOnPrice VC:Heat On (min price) (EUR/MWh)
    higR: 300,      // KVS:AlwaysOffPrice VC:Heat Off (max price) (EUR/MWh)
    Inv: false,     // KVS:InvertedRelay VC:Inverted Relay
    rId: 0,         // KVS:RelayId VC: N/A, always first relay (0)
    cnty: "ee",     // KVS:Country VC:Market Price Country (ee, fi, lv, lt)
    hCur: 0,        // KVS:HeatingCurve VC:Heating Curve 
    tmr: 60,        // Default timer
    pFac: 0.5,      // Power factor
    mnKv: false,    // Forcing script to KVS mode (true) or Virtual components mode (false)
}
/****** PROGRAM INITIAL SETTINGS ******/

let s = {
    last: 0,        // KVS:LastCalculation Last calculation timestamp
    exSc: 0,        // KVS:ExistingSchedule Existing heating schedule
    vers: 0,        // KVS:Version
}

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
    hTim: 0,       //heating time
    cPer: 0,       //number of periods
    tsPr: '',       //timestamp for prices
    tsFc: '',       //timestamp for forecast
    freq: 300,      //frequency of script execution in seconds (5 min)
    isLp: false,    //loop flag
    updD: Math.floor(Math.random() * 46),           //delay for server requests (max 45min)
    sId: Shelly.getCurrentScriptId(),               //script ID
    pId: "Id" + Shelly.getCurrentScriptId() + ": ", //print ID
    scId: '',       //schedule ID
    manu: false,    //manual heating flag
    prov: "None",   //network provider name
    newV: 4.3,      //new script version
    sdOk: false,    //system data OK
    cdOk: false,    //configuration data OK
};
let cntr = 0;    //counter for async functions

function dtVc() {
    return [
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
                options: ["NONE", "VORK1", "VORK2", "VORK4", "VORK5", "PARTN24", "PARTN24PL", "PARTN12", "PARTN12PL"],
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
}

function strt() {
    sAut();
    gKvs();
}
/* set the script to sart automatically on boot */
function sAut() {
    if (!Shelly.getComponentConfig("script", _.sId).enable) {
        Shelly.call('Script.SetConfig', { id: _.sId, config: { enable: true } },
            function (res, err, msg) {
                if (err != 0) {
                    print(_.pId, "Heating script autostart is not enabled.", msg);
                }
            });
    }
}

// check if Shelly supports Virtual components
function isVC() {
    const info = Shelly.getDeviceInfo();
    return (info.gen === 3 || (info.gen === 2 && info.app.substring(0, 3) == "Pro")) && verC('1.4.3', info.ver) && !c.mnKv;
}
// compare Shelly FW versions
function verC(old, newV) {
    const oldP = old.split('.');
    const newP = newV.split('.');
    for (var i = 0; i < newP.length; i++) {
        let a = ~~newP[i]; // parse int
        let b = ~~oldP[i]; // parse int
        if (a > b) return true;
        if (a < b) return false;
    }
    return false;
}
// Get KVS ConfigurationData into memory
function memC(dt) {
    c.tPer = dt.TimePeriod;
    c.hTim = dt.HeatingTime;
    c.isFc = dt.IsForecastUsed;
    c.pack = dt.EnergyProvider;
    c.lowR = dt.AlwaysOnPrice;
    c.higR = dt.AlwaysOffPrice;
    c.Inv = dt.InvertedRelay;
    c.rId = dt.RelayId;
    c.cnty = dt.Country;
    c.hCur = dt.HeatingCurve;
    return c;
}
// ConfigurationData data to KVS store
function kvsC() {
    let cdat = {};
    cdat.TimePeriod = c.tPer;
    cdat.HeatingTime = c.hTim;
    cdat.IsForecastUsed = c.isFc;
    cdat.EnergyProvider = c.pack;
    cdat.AlwaysOnPrice = c.lowR;
    cdat.AlwaysOffPrice = c.higR;
    cdat.InvertedRelay = c.Inv;
    cdat.RelayId = c.rId;
    cdat.Country = c.cnty;
    cdat.HeatingCurve = c.hCur;
    return cdat;
}
// Get KVS SystemData into memory
function memS(dt) {
    s.exSc = dt.ExistingSchedule;
    s.vers = dt.Version;
    return s;
}
// SystemData data to KVS store
function kvsS() {
    let sdat = {};
    sdat.LastCalculation = s.last;
    sdat.ExistingSchedule = s.exSc;
    sdat.Version = s.vers;
    return sdat;
}
// Get KVS ConfigurationData and SystemData
function gKvs() {
    cntr = 2;
    Shelly.call('KVS.Get', { key: "SmartHeatingConf" + _.sId },
        function (res, err) {
            cntr--;
            if (err !== 0) {
                // Failed to get ConfigurationData
                return;
            }
            c = memC(JSON.parse(res.value));
            _.cdOk = true;
        });

    Shelly.call('KVS.Get', { key: "SmartHeatingSys" + _.sId },
        function (res, err) {
            cntr--;
            if (err !== 0) {
                // Failed to get SystemData
                return;
            }
            s = memS(JSON.parse(res.value));
            _.sdOk = true;
        });
    wait(inst);
}

// Select running mode like KVS or Virtual components
function inst() {
    if (isVC()) {
        if (_.sdOk && !(s.vers < 4.2)) {
            print(_.pId, "Existing Virtual Component mode");
            rVc();
        } else {
            print(_.pId, "New Virtual Component installation");
            gVc();
        }
    } else {
        if (_.cdOk && _.sdOk) {
            print(_.pId, "Existing KVS mode");
            main();
        } else {
            print(_.pId, "New KVS mode installation");
            tKvs();
        }
    }
}

// Store configuration data to KVS
function tKvs() {
    Shelly.call("KVS.set", { key: "SmartHeatingConf" + _.sId, value: JSON.stringify(kvsC()) },
        function (res, err, msg) {
            if (err !== 0) {
                console.log(_.pId, "Configuration not stored in KVS:", err, msg);
            } else {
                console.log(_.pId, "Configuration settings stored in KVS");
            }
        }
    );
    main();
}

// Get all virtual components and delete them all before new installation
function gVc() {
    Shelly.call("Shelly.GetComponents", { dynamic_only: true, include: ["status"] }, function (res, err, msg) {
        if (err === 0) {
            if (res.components && res.components.length > 0) {
                dVc(res.components); // Delete all Virtual Components
            } else {
                aVc(dtVc()); // Add VCom and pass Virtual Components data
            }
        } else {
            print(_.pId, "Failed to get virtual components: " + msg);
        }
    });
}

// Delete all virtual components for new installation only
function dVc(vCom) {
    if (cntr < 6 - 1) {
        for (let i = 0; i < 1 && i < vCom.length; i++) {
            let key = vCom.splice(0, 1)[0].key;
            cntr++;
            Shelly.call("Virtual.Delete", { key: key },
                function (res, err, msg) {
                    if (err === 0) {
                        print(_.pId, "Clean Virtual Components");
                    } else {
                        print(_.pId, "Virtual component is not deleted: " + msg);
                    }
                    cntr--;
                }
            );
        }
    }
    if (vCom.length > 0) {
        Timer.set(1000, false, dVc, vCom);
    } else {
        wait([aVc, dtVc()]); 
    }
}

// Add all new virtual components
function aVc(vCom) {
    if (cntr < 6 - 1) {
        for (let i = 0; i < 1 && i < vCom.length; i++) {
            let comp = vCom.splice(0, 1)[0];
            cntr++;
            Shelly.call("Virtual.Add", { type: comp.type, id: comp.id, config: comp.config },
                function (res, err, msg) {
                    if (err === 0) {
                        print(_.pId, "Added new virtual component: " + res.id);
                    } else {
                        print(_.pId, "Virtual component is not added: " + msg);
                    }
                    cntr--;
                }
            );
        }
    }
    if (vCom.length > 0) {
        Timer.set(1000, false, aVc, vCom);
    } else {
        wait(sGrp);
    }
}

// Add virtual components to group
function sGrp() {
    let gCnf = {
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
    Shelly.call("Group.Set", gCnf, function (res, err, msg) {
        if (err !== 0) {
            print(_.pId, "Group config is not set: " + msg);
        }
    });
    rVc();
}

// Read all virtual components and store the values to memory
function rVc() {
    Shelly.call("Shelly.GetComponents", { dynamic_only: true, include: ["status"] },
        function (res, err, msg) {
            if (err === 0) {
                let comp = res.components;
                res = null;
                if (comp && comp.length > 0) {
                    for (let i in comp) {
                        let val = comp[i].status.value;
                        switch (comp[i].key) {
                            case "enum:200":
                                c.tPer = JSON.parse(val);
                                break;
                            case "number:200":
                                c.hTim = JSON.parse(val);
                                break;
                            case "boolean:200":
                                c.isFc = JSON.parse(val);
                                break;
                            case "enum:201":
                                c.pack = val;
                                break;
                            case "number:201":
                                c.lowR = JSON.parse(val);
                                break;
                            case "number:202":
                                c.higR = JSON.parse(val);
                                break;
                            case "boolean:201":
                                c.Inv = JSON.parse(val);
                                break;
                            case "enum:202":
                                c.cnty = val;
                                break;
                            case "number:203":
                                c.hCur = JSON.parse(val);
                                break;
                            default:
                                break;
                        }
                    }
                    wait(main);
                } else {
                    print(_.pId, "No virtual components found");
                }
            } else {
                print(_.pId, "Couldn't get virtual components: " + msg);
            }
        });
}

// Main script where all the logic starts.
function main() {
    _.cPer = c.tPer <= 0 ? 0 : Math.ceil((24 * 100) / (c.tPer * 100));  //number of periods in a day
    _.hTim = c.hTim > c.tPer ? c.tPer : c.hTim;                         //heating time can't be more than the period
    //check if Shelly has time
    if (!isTm) {
        hErr("Shelly has no time");
        return;
    }
    // set the network provider
    if (c.pack.substring(0, 4) == "VORK") {
        _.prov = "Elektlevi";
    } else if (c.pack.substring(0, 4) == "PART") {
        _.prov = "Imatra";
    }
    print(_.pId, "Network provider: ", _.prov, c.pack);

    // If weather forecast is used for heating hours
    if (c.isFc && c.tPer > 0) {
        gFcs();
    } else {
        gEle();
    }
}

// Get Open-Meteo min and max "feels like" temperatures
function gFcs() {
    const lat = JSON.stringify(Shelly.getComponentConfig("sys").location.lat);
    const lon = JSON.stringify(Shelly.getComponentConfig("sys").location.lon);
    let url = "https://api.open-meteo.com/v1/forecast?hourly=apparent_temperature&timezone=auto&forecast_days=1&forecast_hours=";
    url = url + c.tPer + "&latitude=" + lat + "&longitude=" + lon;
    print(_.pId, "Forecast query: ", url)
    Shelly.call("HTTP.GET", { url: url, timeout: 5, ssl_ca: "*" }, function (res, err) {
        url = null; 
        if (err != 0 || res === null || res.code != 200) {
            hErr("Get forecast HTTP.GET error, check again in " + _.freq / 60 + " min.");
            return;
        }
        //open-meteo json response to get 6h, 12h or 24h temperatures
        const temp = JSON.parse(res.body)["hourly"]["apparent_temperature"];
        res = null;
        let sumT = 0;
        for (let i = 0; i < temp.length; i++) {
            sumT += temp[i];        
        }

        const tFcs = Math.ceil(sumT / c.tPer);      //AVG and round temperature up
        _.tsFc = Math.floor(Date.now() / 1000.0);   //store the timestamp into memory
        print(_.pId, "We got weather forecast from Open Meteo at ", new Date().toString());

        // calculating heating hours
        const maxT = 16;                            //max temperature for the forecast
        let fcTm = ((maxT - tFcs) * (c.pFac - 1) + (maxT - tFcs + c.hCur * 2 - 2)); //the main heating time calculation algorithm
        fcTm = fcTm < 0 || tFcs > maxT ? 0 : fcTm;  //heating time can't be negative
        _.hTim = Math.floor(fcTm / _.cPer);         //heating time per period (round-down heating time)
        _.hTim = _.hTim > c.tPer ? c.tPer : _.hTim; //heating time can't be more than the period

        print(_.pId, "Temperture forecast width windchill is ", tFcs, " °C, and heating enabled for ", _.hTim, " hours.");
        gEle(); 
    });
}
// Get electricity market price CSV file from Elering
function gEle() {
    // set the date range for Elering query
    const epch = Shelly.getComponentStatus("sys").unixtime;
    const shHr = new Date(epch * 1000).getHours();
    // After 23:00 tomorrow's energy prices are used
    // before 23:00 today's energy prices are used.
    const addD = shHr >= 23 ? 0 : -1;
    const isoT = new Date((epch + gTz() + 60 * 60 * 24 * addD) * 1000).toISOString().slice(0, 10);
    const isoN = new Date((epch + gTz() + (60 * 60 * 24 * (addD + 1))) * 1000).toISOString().slice(0, 10);
    const dtSt = isoT + "T" + (24 - gTz() / 3600) + ":00Z";
    const dtEn = isoN + "T" + (24 - gTz() / 3600 - 1) + ":00Z";
    // Build Elering URL
    let url = "https://dashboard.elering.ee/api/nps/price/csv?fields=";
    url += c.cnty + "&start=" + dtSt + "&end=" + dtEn;
    print(_.pId, "Elering query: ", url);

    Shelly.call("HTTP.GET", { url: url, timeout: 5, ssl_ca: "*" }, function (res, err) {
        url = null; 
        if (err != 0 || res === null || res.code != 200 || !res.body_b64) {
            hErr("Elering HTTP.GET error, check again in " + _.freq / 60 + " min.");
            return;
        }
        c.pack = eval("pack()." + c.pack);      //convert transfer fee to variable and load the data

        // Convert base64 to text and discard header
        res.body_b64 = atob(res.body_b64);     
        let body = res.body_b64.substring(res.body_b64.indexOf("\n") + 1);
        res = null; 
        let raw = [];
        let eler = [];
        let aPos = 0;
        while (aPos >= 0) {
            body = body.substring(aPos);
            aPos = 0;
            let row = [0, 0];
            aPos = body.indexOf("\"", aPos) + 1;
            if (aPos === 0) {
                break; // End of data
            }
            // Epoch
            row[0] = Number(body.substring(aPos, body.indexOf("\"", aPos))); 
            // Skip "; after timestamp
            aPos = body.indexOf("\"", aPos) + 2;
            // Price
            aPos = body.indexOf(";\"", aPos) + 2;
            row[1] = Number(body.substring(aPos, body.indexOf("\"", aPos)).replace(",", "."));  
            row[1] += fFee(row[0]);     //add transfer fee

            raw.push(row);
            aPos = body.indexOf("\n", aPos);
        }
        //if elering API returns less than 24 rows, the script will try to download the data again after set of minutes
        if (raw.length < 24) {
            hErr("Elering API didn't return prices, check again in " + _.freq / 60 + " min.");
            return;
        }
        //store the timestamp into memory
        _.tsPr = Math.floor(Date.now() / 1000.0);
        print(_.pId, "We got market prices from Elering ", new Date().toString());

        if (c.tPer <= 0) {
            // Calculate schedules based on alwaysOnLowPrice.
            for (let a = 0; a < raw.length; a++) {
                let ts = raw[a][0];
                let pric = raw[a][1];
                let fee = fFee(ts);
                if (pric - fee < c.lowR) { //if price - transferFee is less than min price
                    eler.push([new Date(ts * 1000).getHours(), pric]);
                    print(_.pId, "Energy price ", pric - fee, " EUR/MWh at ", new Date(ts * 1000).getHours() + ":00 is less than min price and used for heating.");
                }
            }
            if (!eler.length) {
                print(_.pId, "No energy prices below min price level. No heating.");
            }
        } else {    // Calculate schedules based on the cheap hours in the heating period.
            let numP = Math.ceil((new Date().getHours() % 23 + 2) / c.tPer);    //finds the current period for forecast calculation    

            // Create an array for each heating period, sort, and push the prices 
            for (let i = 0; i < _.cPer; i++) {                              //loop through the periods
                if (c.isFc && (i + 1) != numP) { continue; }                //use only the current period in case of forecast, skip the rest
                let hPer = (i + 1) * c.tPer > 24 ? 24 : (i + 1) * c.tPer;   //finds the end of the period
                let oneP = [];
                for (let j = i * c.tPer; j < hPer; j++) {                   //finds the prices in the period
                    oneP.push(raw[j]);                                      //copy the price to the new array
                }
                oneP = srAr(oneP, 1); //sort by price
                let hHrs = oneP.length < _.hTim ? oneP.length : _.hTim;     //finds max hours to heat in that period 

                for (let a = 0; a < oneP.length; a++) {
                    let ts = oneP[a][0];
                    let pric = oneP[a][1];
                    let fee = fFee(ts);
                    if ((a < hHrs || pric - fee < c.lowR) && !(pric - fee > c.higR)) {
                        eler.push([new Date((ts) * 1000).getHours(), pric]);
                    }
                }
            }
            if (!eler.length) {
                print(_.pId, "Current configuration does not permit heating during any hours; it is likely that the AlwaysOffPrice value is set too low.")
            }
        }
        c.pack, raw = null; 
        _.manu = false;
        fTmr();     //set default timer
        fdSc(eler); //delete existing schedule and pass eler data to create schedule
        eler = null; 
    });
}

// Get Shelly timezone offset in seconds 
function gTz() {
    const shDt = new Date(Shelly.getComponentStatus("sys").unixtime * 1000);
    const shHr = shDt.getHours();
    const utcH = shDt.toISOString().slice(11, 13);  //UTC hour
    let tz = shHr - utcH;                           //timezone offset
    if (tz > 12) { tz -= 24; }
    if (tz < -12) { tz += 24; }
    return tz * 60 * 60;
}

// Calculate transfer fee based on the timestamp.
function fFee(epoch) {
    const hour = new Date(epoch * 1000).getHours();
    const day = new Date(epoch * 1000).getDay();
    const mnth = new Date(epoch * 1000).getMonth();
    if (_.prov === "Elektlevi") {
        if ((mnth >= 10 || mnth <= 2) && (day === 0 || day === 6) && hour >= 16 && hour < 20) {
            // peak holiday: Nov-Mar, SA-SU at 16:00–20:00
            return c.pack.hMRt;
        } else if ((mnth >= 10 || mnth <= 2) && ((hour >= 9 && hour < 12) || (hour >= 16 && hour < 20))) {
            // peak daytime: Nov-Mar: MO-FR at 09:00–12:00 and at 16:00–20:00
            return c.pack.dMRt;
        } else if (hour < 7 || hour >= 22 || day === 6 || day === 0) {
            //night-time: MO-FR at 22:00–07:00, SA-SU all day
            return c.pack.nRt;
        } else {
            //daytime: MO-FR at 07:00–22:00
            return c.pack.dRt;
        }
    } else if (_.prov === "Imatra") {
        if (gTz() / 60 / 60 === 3) { //summer time
            if (hour < 8 || day === 6 || day === 0) {
                //summer-night-time: MO-FR at 00:00–08:00, SA-SU all day
                return c.pack.nRt;
            } else {
                //daytime: MO-FR at 08:00–24:00
                return c.pack.dRt;
            }
        } else {
            if (hour < 7 || hour >= 23 || day === 6 || day === 0) {
                //winter-night-time: MO-FR at 23:00–07:00, SA-SU all day
                return c.pack.nRt;
            } else {
                //daytime: MO-FR at 07:00–23:00
                return c.pack.dRt;
            }
        }
    } else {
        return 0;
    }
}

// Set countdown timer to flip Shelly status
function fTmr() {
    const timr = c.tmr * 60 + 2; //+2sec to remove flap between continous heating hours
    Shelly.call("Switch.SetConfig", {
        id: c.rId,
        config: {
            auto_on: c.Inv,
            auto_on_delay: timr,
            auto_off: !c.Inv,
            auto_off_delay: timr
        }
    });
}
// Delete the existing schedule if it exists
function fdSc(eler) {
    cntr = 1;
    Shelly.call("Schedule.Delete", { id: s.exSc }, function () {
        cntr--;
    });
    wait([fScd, eler]);
}

// Create a new schedule with the advanced timespec to cover all the hours within the same schedule item
function fScd(eler) {
    cntr = 1;
    if (eler === undefined || eler.length == 0) {
        print(_.pId, "No heating calculated for any hours with the current configuration.")
        fKvs();
        return;
    }
    // Sort the heating by hour
    let sArr = srAr(eler, 0);
    eler = [];
    _.scId = 0;
    let hArr = [];
    let pArr = [];
    for (let i = 0; i < sArr.length; i++) {
        let hr = sArr[i][0];
        hArr.push(hr);
        let t = hr < 10 ? "0" + hr : hr;
        pArr.push(t + ":00 (" + sArr[i][1] + ")");
    }
    const hrs = hArr.join(",");     //create timespec
    const pric = pArr.join(", ");   //create hours (prices) for print
    Shelly.call("Schedule.Create", {
        enable: true,
        timespec: "0 0 " + hrs + " * * *",
        calls: [{
            method: "Switch.Set",
            params: {
                id: c.rId,
                on: !c.Inv
            }
        }]
    }, function (res, err, msg) {
        if (err !== 0) {
            print(_.pId, "Scheduler not created:", err, msg);
        } else {
            _.scId = res.id; //last scheduleID to store in KVS
        }
        cntr--;
    });
    print(_.pId, "Heating will be turned on to following hours 'HH:mm (EUR/MWh Energy Price + Transmission)':\n", pric);
    wait(fKvs);
}

// Store the schedulerID, version and last calculation to KVS to have them in case of power outage
function fKvs() {
    cntr = 1;
    s.last = new Date().toString();
    s.exSc = _.scId;
    s.vers = _.newV;
    Shelly.call("KVS.set", { key: "SmartHeatingSys" + _.sId, value: JSON.stringify(kvsS()) },
        function () {
            cntr--;
        });
    s.last = null;  
    print(_.pId, "Script v", _.newV, (_.scId > 0 ? " created a schedule with ID:" + _.scId : "") + ", next heating calculation at", nxHr(1) + (_.updD < 10 ? ":0" : ":") + _.updD);
    wait(f_Wd);
}

//if the internet is not working or Elering is down
function fMan() {
    if (_.manu) {
        return;
    }
    _.manu = true;

    let chpH = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 21, 22, 23, 18, 19, 20];
    let eler = [];
    for (let i = 0; i < _.cPer; i++) {                  //create schedule for each period
        let hT = (i * c.tPer) + _.hTim;                 //find the end of the period
        hT = hT > 24 ? 24 : hT;                         //if the end of the period is more than 24, set it to 24
        for (let j = i * c.tPer; j < hT; j++) {         //find the prices in each period
            eler.push([chpH[j], "-"]);                  //copy the price to the new array
        }
    }
    chpH = null;
    fTmr();     //set default timer
    fdSc(eler); //delete existing schedule and pass schedule data to create schedule
}

// Shelly doesnt support Javascript sort function so this basic math algorithm will do the sorting job
function srAr(arr, sort) {
    let i, j, k, min, max, minX, maxX, tmp;
    j = arr.length - 1;
    for (i = 0; i < j; i++) {
        min = max = arr[i][sort];
        minX = maxX = i;
        for (k = i; k <= j; k++) {
            if (arr[k][sort] > max) {
                max = arr[k][sort];
                maxX = k;
            } else if (arr[k][sort] < min) {
                min = arr[k][sort];
                minX = k;
            }
        }
        tmp = arr[i];
        arr.splice(i, 1, arr[minX]);
        arr.splice(minX, 1, tmp);

        if (arr[minX][sort] === max) {
            tmp = arr[j];
            arr.splice(j, 1, arr[minX]);
            arr.splice(minX, 1, tmp);
        } else {
            tmp = arr[j];
            arr.splice(j, 1, arr[maxX]);
            arr.splice(maxX, 1, tmp);
        }
        j--;
    }
    return arr;
}

// Handle errors by logging and setting manual mode.
function hErr(msg) {
    print(_.pId, "# Internet error, using historical cheap hours because ", msg);
    fMan();     //set schedule manually
    _.isLp = false;
}
// Wait for the RPC calls to be completed before starting next function.
function wait(data) {
    if (cntr !== 0) {
        Timer.set(1000, false, wait, data);
        return;
    }
    if (typeof data === "function") {   //if data is a function, call it
        data();
    } else {                            //if data is an array, the first element is a function and the second element is a parameter
        data[0](data[1]);
    }
}

// Next hour for heating calculation
function nxHr(adHr) {
    const chkT = c.isFc && c.tPer > 0 ? c.tPer : 24;
    const hr = (Math.ceil((new Date(Date.now() + (adHr * 60 * 60 * 1000)).getHours() + 1) / chkT) * chkT) - 1;
    return hr > 23 ? 23 : hr;
}

/**
Getting prices or forecast for today if 
    * prices or forecast have never been fetched OR 
    * prices or forecast are not from today or yesterday OR 
    * prices or forecast needs regular update
 */
function updt(ts) {
    const nHr = nxHr(0);                                //next hour for heating calculation
    const now = new Date();                             //now
    const yDt = new Date(now - 60 * 60 * 24 * 1000);    //yesterday
    const tDt = new Date(ts * 1000);                    //timestamp
    const tTd = tDt.getFullYear() === now.getFullYear() && tDt.getMonth() === now.getMonth() && tDt.getDate() === now.getDate();
    const tYd = tDt.getFullYear() === yDt.getFullYear() && tDt.getMonth() === yDt.getMonth() && tDt.getDate() === yDt.getDate();
    const tAft = tDt.getHours() === nHr && tTd;
    const isTm = now.getHours() === nHr && now.getMinutes() >= _.updD;
    return (isTm && !tAft) || !(tTd || tYd);
}

// This loop is to update the heating schedule
function loop() {
    if (_.isLp) {
        return;
    }
    _.isLp = true;
    if (updt(_.tsPr) || c.isFc && updt(_.tsFc)) {   //check if the prices or forecast needs to be updated
        strt();                                     //start the program
    } else {
        _.isLp = false;
    }
}

let isTm = false;   //check if Shelly has time
let t_hd;           //timer handle
let t_ct = 0;       //time counter
let lNot = true;    //loop notification
function fcTm() {
    const epch = Shelly.getComponentStatus("sys").unixtime;
    if (epch > 0) {
        //if time is OK, then stop the timer
        Timer.clear(t_hd);
        isTm = true;
        print(_.pId, "Shelly has time ", new Date(epch * 1000));
        //start the main loop with a random delay (0-5 sec) to avoid the same starting time for concurrent instances
        Timer.set(Math.floor(Math.random() * 5) * 1000, false, loop);
    } else {
        t_ct++;
        print(_.pId, "Shelly has no time", t_ct, "seconds. We wait for the time to be set.");
        if (t_ct > 30 && lNot) {
            loop(); //start the main loop if the time is not set in 30 seconds
            lNot = false;
        }
        return;
    }
}

/*  ---------  WATCHDOG START  ---------   */
/** find watchdog script ID */
function f_Wd() {
    Shelly.call('Script.List', null, function (res) {
        if (res) {
            let id = 0;
            const scr = res.scripts;
            res = null;
            for (let i = 0; i < scr.length; i++) {
                if (scr[i].name === "watchdog") {
                    id = scr[i].id;
                    break;
                }
            }
            /** Create a new script (id==0) or stop the existing script (id<>0) if watchdog found. */
            if (id === 0) {
                Shelly.call('Script.Create', { name: "watchdog" }, putC, { id: id });   //create a new watchdog 
            } else {
                Shelly.call('Script.Stop', { id: id }, putC, { id: id });               //stop the existing watchdog 
            }
        }
    });
}

// Add code to the watchdog
function putC(res, err, msg, data) {
    if (err !== 0) {
        print(_.pId, "Watchdog script not created:", msg, ". Schedule will not be deleted if heating script is stopped or deleted.");
    } else {
        let code = 'let scId=0;function strt(){Shelly.call("KVS.Get",{key:"SmartHeatingSys"+scId},(function(e){e&&delS(JSON.parse(e.value))}))}function delS(e){Shelly.call("Schedule.Delete",{id:e.ExistingSchedule},(function(e,t,d,l){0!==t?print("Script #"+scId,"schedule ",l.id," deletion by watchdog failed."):print("Script #"+scId,"schedule ",l.id," deleted by watchdog.")}),{id:e.ExistingSchedule}),updK(e)}function updK(e){e.ExistingSchedule=0,Shelly.call("KVS.set",{key:"SmartHeatingSys"+scId,value:JSON.stringify(e)})}Shelly.addStatusHandler((function(e){"script"!==e.name||e.delta.running||(scId=e.delta.id,strt())}));'
        const id = res.id > 0 ? res.id : data.id;   //get the script ID
        Shelly.call('Script.PutCode', { id: id, code: code }, function (res, err, msg, data) {
            if (err === 0) {
                a_St(data.id); 
            } else {
                print(_.pId, "Code is not added to the script:", msg, ". Schedule will notbe deleted if heating script is stopped or deleted.")
            }
        }, { id: id });
    }
}

// Enable autostart for the watchdog
function a_St(sId) {
    if (!Shelly.getComponentConfig("script", sId).enable) {
        Shelly.call('Script.SetConfig', { id: sId, config: { enable: true } }, function (res, err, msg) {
            if (err !== 0) {
                print(_.pId, "Watchdog script autostart is not enabled.", msg, ". After Shelly restart, this script will not start and schedule is not deleted if heating script is stopped or deleted.");
            }
        });
    }
    // Start the watchdog
    Shelly.call('Script.Start', { id: sId }, function (res, err, msg) {
        if (err === 0) {
            print(_.pId, "Watchdog script created and started successfully.");
        } else {
            print(_.pId, "Watchdog script is not started.", msg, ". Schedule will not be deleted if heating script is stopped or deleted.");
        }
    });
    _.isLp = false;
}
/*  ---------  WATCHDOG END  ---------   */

t_hd = Timer.set(1000, true, fcTm);     //start the Shelly timecheck timer
Timer.set(_.freq * 1000, true, loop);   //start the main loop with a frequency of 5 minutes
